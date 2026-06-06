import type { AgentEvent, AgentId, EventMapper } from "../types/events";
import { type ProcessRunOptions, runProcessLines } from "./spawn";
import { firstLine } from "./util";

export interface AgentRunOptions {
  prompt: string;
  model: string;
  /** Reasoning effort / variant (claude: `--effort`, opencode: `--variant`). */
  effort?: string;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Extra env vars merged over `process.env` for this run (per-step targets). */
  env?: Record<string, string>;
  /** Extra CLI flags appended to the agent's own args, before the prompt. */
  extraArgs?: string[];
}

/**
 * The single contract the orchestrator depends on. `run` streams normalized
 * events for one task; each adapter owns the CLI flags and raw→normalized map.
 */
export interface AgentAdapter {
  readonly id: AgentId;
  readonly binary: string;
  run(opts: AgentRunOptions): AsyncIterable<AgentEvent>;
}

export interface AgentProcessParams {
  id: AgentId;
  binary: string;
  args: string[];
  opts: AgentRunOptions;
  /** Per-run mapper (may be stateful — create a fresh one per run). */
  map: EventMapper;
}

/**
 * Shared driver: spawns the CLI, parses each NDJSON line, runs the adapter's
 * mapper, and turns process-level failures (spawn error, non-zero exit, empty
 * output, timeout) into `error` events. Adapters differ only in args + mapper.
 */
export async function* runAgentProcess(params: AgentProcessParams): AsyncGenerator<AgentEvent> {
  const { id, binary, args, opts, map } = params;
  let lineCount = 0;
  let sawError = false;

  const processOpts: ProcessRunOptions = {
    binary,
    args,
    cwd: opts.cwd,
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  };

  for await (const item of runProcessLines(processOpts)) {
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
      for (const event of map(raw)) {
        if (event.kind === "error") sawError = true;
        yield event;
      }
      continue;
    }

    if (item.kind === "exit") {
      const ts = Date.now();
      const stderr = item.stderr.trim();
      const stderrTail = stderr ? `: ${firstLine(stderr)}` : "";

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
        yield {
          kind: "error",
          agent: id,
          ts,
          message: `'${binary}' timed out after ${opts.timeoutMs}ms`,
          stderr: stderr || undefined,
          code: item.code,
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

    // stderr chunks are captured for the exit summary; not surfaced per-line.
  }
}
