import type { AgentEvent, AgentId, AgentInstanceId, EventMapper } from "../types/events";
import { appendCapped } from "../util/capped-buffer";
import { type AgentFailureKind, classifyAgentFailure, isCapacityFailure } from "./failure-classify";
import type { ResolvedPermissions } from "./permissions";
import { type ProcessRunOptions, resolveAgentIdleTimeoutMs, runProcessLines } from "./spawn";
import { stderrSummary } from "./util";

/** Rolling stderr window used to detect mid-run capacity failures across chunks. */
const CAPACITY_STDERR_PROBE_BYTES = 64 * 1024;

export interface AgentRunOptions {
  prompt: string;
  model: string;
  /** Reasoning effort / variant (claude: `--effort`, opencode: `--variant`, codex: `-c model_reasoning_effort=…`, kimi: `KIMI_MODEL_THINKING_EFFORT` env). */
  effort?: string;
  cwd?: string;
  timeoutMs?: number;
  /**
   * Kill the agent if it goes silent (no stdout/stderr) this long. `0` disables.
   * Omitted → spawn default ({@link DEFAULT_AGENT_IDLE_TIMEOUT_MS} when a
   * wall-clock timeout is set).
   */
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  /** Extra env vars merged over `process.env` for this run (per-step targets). */
  env?: Record<string, string>;
  /** Extra CLI flags appended to the agent's own args, before the prompt. */
  extraArgs?: string[];
  /**
   * Per-step tool permissions (see `permissions.ts`). Each adapter splices the
   * provider's translated flags in *before* {@link AgentRunOptions.extraArgs},
   * so an author's hand-written flag still has the last word. Absent ⇒ no
   * permission flags at all (the historical behavior), which is deliberately
   * distinct from an explicit `"full"` profile.
   */
  permissions?: ResolvedPermissions;
  /** Configured instance id to stamp on normalized events. Defaults to provider id. */
  agentId?: AgentInstanceId;
  /**
   * Resume a previously recorded CLI session (captured from `session_start`)
   * instead of starting fresh, so the new prompt continues that conversation.
   * Honored only by adapters that declare {@link AgentAdapter.supportsResume};
   * others ignore it (callers must compose a self-contained prompt for them).
   */
  resumeSessionId?: string;
}

/**
 * The single contract the orchestrator depends on. `run` streams normalized
 * events for one task; each adapter owns the CLI flags and raw→normalized map.
 */
export interface AgentAdapter {
  readonly id: AgentId;
  readonly binary: string;
  readonly defaultModel: string;
  /**
   * True when {@link AgentRunOptions.resumeSessionId} is honored (the CLI can
   * continue a recorded session). Absent/false ⇒ resume requests are ignored.
   */
  readonly supportsResume?: boolean;
  run(opts: AgentRunOptions): AsyncIterable<AgentEvent>;
}

export interface AgentProcessParams {
  id: AgentId;
  binary: string;
  args: string[];
  opts: AgentRunOptions;
  /** Per-run mapper (may be stateful — create a fresh one per run). */
  map: EventMapper;
  /** Prompt text to write to stdin. When provided, stdin is piped instead of ignored. */
  prompt?: string;
}

/**
 * Shared driver: spawns the CLI, parses each NDJSON line, runs the adapter's
 * mapper, and turns process-level failures (spawn error, non-zero exit, empty
 * output, timeout) into `error` events. Adapters differ only in args + mapper.
 *
 * Also watches stderr for quota / rate-limit copy and aborts the child early.
 * Some CLIs (notably OpenCode in `--format json`) otherwise wait out a
 * multi-hour provider retry with no stdout, which looks like a hang.
 */
export async function* runAgentProcess(params: AgentProcessParams): AsyncGenerator<AgentEvent> {
  const { binary, args, opts, map, prompt } = params;
  const id = opts.agentId ?? params.id;
  let lineCount = 0;
  let sawError = false;
  let stderrProbe = "";
  let capacityKind: AgentFailureKind | undefined;
  let capacityMessage: string | undefined;

  const capacityAbort = new AbortController();
  const signal = mergeAbortSignals(opts.signal, capacityAbort.signal);

  const processOpts: ProcessRunOptions = {
    binary,
    args,
    cwd: opts.cwd,
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    idleTimeoutMs: opts.idleTimeoutMs,
    signal,
    prompt,
  };

  for await (const item of runProcessLines(processOpts)) {
    if (item.kind === "stderr") {
      // Detect capacity failures while the CLI is still alive (OpenCode logs
      // "Rate limit exceeded" then waits hours to retry). Kill promptly so the
      // engine can failover instead of staring at a silent child.
      if (!capacityKind) {
        stderrProbe = appendCapped(stderrProbe, item.text, CAPACITY_STDERR_PROBE_BYTES);
        const kind = classifyAgentFailure(stderrProbe);
        if (isCapacityFailure(kind)) {
          capacityKind = kind;
          capacityMessage = summarizeCapacityStderr(stderrProbe) ?? item.text.trim();
          capacityAbort.abort();
        }
      }
      continue;
    }

    if (item.kind === "line") {
      lineCount += 1;
      let raw: unknown;
      try {
        raw = JSON.parse(item.line);
      } catch {
        // Non-JSON noise on stdout (e.g. a stray log line) — keep it visible.
        yield { kind: "unknown", agent: id, ts: Date.now(), raw: item.line };
        continue;
      }
      try {
        for (const event of map(raw)) {
          if (event.kind === "error") sawError = true;
          yield event;
        }
      } catch (err) {
        sawError = true;
        yield {
          kind: "error",
          agent: id,
          ts: Date.now(),
          message: `mapper error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      continue;
    }

    if (item.kind === "exit") {
      const ts = Date.now();
      const stderr = item.stderr.trim();
      const summary = stderrSummary(stderr);
      const stderrTail = summary ? `: ${summary}` : "";

      if (capacityKind) {
        sawError = true;
        yield {
          kind: "error",
          agent: id,
          ts,
          message:
            capacityMessage && capacityMessage.length > 0
              ? `'${binary}' ${capacityMessage}`
              : `'${binary}' ${capacityKind === "quota" ? "quota / billing exhausted" : "rate limited"}`,
          stderr: stderr || undefined,
          code: item.code,
          category: capacityKind,
        };
        return;
      }
      if (item.spawnError) {
        yield {
          kind: "error",
          agent: id,
          ts,
          message: `failed to start '${binary}': ${item.spawnError}`,
          stderr: stderr || undefined,
          code: item.code,
        };
        return;
      }
      if (item.timedOut) {
        // Prefer capacity classification from stderr over a generic timeout —
        // OpenCode free-tier waits can trip the idle timer with the real reason
        // already sitting in --print-logs output.
        const fromStderr = classifyAgentFailure(summary, { stderr });
        const category: AgentFailureKind = isCapacityFailure(fromStderr) ? fromStderr : "transient";
        yield {
          kind: "error",
          agent: id,
          ts,
          message: item.idleTimedOut
            ? `'${binary}' idle timeout after ${(resolveAgentIdleTimeoutMs(opts) ?? 0) / 1000}s with no output${
                isCapacityFailure(fromStderr) && summary ? `: ${summary}` : ""
              }`
            : `'${binary}' timed out after ${opts.timeoutMs! / 1000}s${
                isCapacityFailure(fromStderr) && summary ? `: ${summary}` : ""
              }`,
          stderr: stderr || undefined,
          code: item.code,
          category,
          timedOut: true,
        };
        return;
      }
      if ((item.code ?? 0) !== 0) {
        yield {
          kind: "error",
          agent: id,
          ts,
          message: `'${binary}' exited with code ${item.code}${stderrTail}`,
          stderr: stderr || undefined,
          code: item.code,
        };
        return;
      }
      if ((lineCount === 0 || !item.sawStdout) && !sawError) {
        yield {
          kind: "error",
          agent: id,
          ts,
          message: `'${binary}' produced no output${stderrTail}`,
          stderr: stderr || undefined,
          code: item.code,
        };
        return;
      }
      return;
    }
  }
}

/** Combine caller cancellation with an internal capacity-abort controller. */
function mergeAbortSignals(external: AbortSignal | undefined, internal: AbortSignal): AbortSignal {
  if (!external) return internal;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([external, internal]);
  const merged = new AbortController();
  const abort = (): void => merged.abort();
  if (external.aborted || internal.aborted) {
    merged.abort();
    return merged.signal;
  }
  external.addEventListener("abort", abort, { once: true });
  internal.addEventListener("abort", abort, { once: true });
  return merged.signal;
}

/**
 * Prefer a short, human capacity reason from OpenCode-style log lines
 * (`error.error="AI_APICallError: Rate limit exceeded…"`) over the full
 * timestamped dump.
 */
function summarizeCapacityStderr(text: string): string | undefined {
  const quoted = text.match(/error\.error="([^"]+)"/);
  if (quoted?.[1]) {
    return quoted[1].replace(/^AI_(?:APICall|Retry)Error:\s*/i, "").trim();
  }
  const freeUsage = text.match(/Free usage exceeded[^\n\r\]]*/i);
  if (freeUsage) return freeUsage[0]!.trim();
  const summary = stderrSummary(text);
  return summary || undefined;
}
