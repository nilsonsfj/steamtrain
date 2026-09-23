import type {
  AgentEvent,
  AgentId,
  AgentInstanceId,
  EventMapper,
  TokenUsage,
} from "../types/events";
import {
  type OpenCodePart,
  type OpenCodeTokens,
  opencodeEnvelope,
  opencodeEvent,
} from "../types/raw-opencode";
import { type AgentAdapter, type AgentRunOptions, runAgentProcess } from "./adapter";
import type { AgentModel } from "./agent-model";
import { rememberSessionDirectory, sessionForDirectory } from "./opencode-session";
import { permissionArgs } from "./permissions";
import { stringifyContent } from "./util";

const AGENT: AgentId = "opencode";

/** Known OpenCode models (provider/model; used by `/model` and autocomplete). */
export const OPENCODE_MODELS: readonly AgentModel[] = [
  // OpenCode Zen (https://models.dev — provider "opencode", active models)
  { id: "opencode/gpt-6-astra", name: "GPT 6 Astra" },
  { id: "opencode/gpt-6-sol", name: "GPT 6 Sol" },
  { id: "opencode/gpt-6-luna", name: "GPT 6 Luna" },
  { id: "opencode/gpt-5.6-sol", name: "GPT 5.6 Sol" },
  { id: "opencode/gpt-5.6-terra", name: "GPT 5.6 Terra" },
  { id: "opencode/gpt-5.6-luna", name: "GPT 5.6 Luna" },
  { id: "opencode/gpt-5.4-mini", name: "GPT 5.4 Mini" },
  { id: "opencode/gpt-5.4", name: "GPT 5.4" },
  { id: "opencode/gpt-5.4-pro", name: "GPT 5.4 Pro" },
  { id: "opencode/gpt-5.4-nano", name: "GPT 5.4 Nano" },
  { id: "opencode/gpt-5.5", name: "GPT 5.5" },
  { id: "opencode/gpt-5.5-pro", name: "GPT 5.5 Pro" },
  { id: "opencode/gpt-5.3-codex", name: "GPT 5.3 Codex" },
  { id: "opencode/gpt-5.3-codex-spark", name: "GPT 5.3 Codex Spark" },
  { id: "opencode/gpt-5.2", name: "GPT 5.2" },
  { id: "opencode/gpt-5.2-codex", name: "GPT 5.2 Codex" },
  { id: "opencode/gpt-5.1", name: "GPT 5.1" },
  { id: "opencode/gpt-5.1-codex", name: "GPT 5.1 Codex" },
  { id: "opencode/gpt-5.1-codex-max", name: "GPT 5.1 Codex Max" },
  { id: "opencode/gpt-5.1-codex-mini", name: "GPT 5.1 Codex Mini" },
  { id: "opencode/gpt-5", name: "GPT 5" },
  { id: "opencode/gpt-5-codex", name: "GPT 5 Codex" },
  { id: "opencode/gpt-5-nano", name: "GPT 5 Nano" },
  { id: "opencode/claude-fable-5-1", name: "Claude Fable 5.1" },
  { id: "opencode/claude-fable-5", name: "Claude Fable 5" },
  { id: "opencode/claude-opus-5-5", name: "Claude Opus 5.5" },
  { id: "opencode/claude-opus-5", name: "Claude Opus 5" },
  { id: "opencode/claude-sonnet-5", name: "Claude Sonnet 5" },
  { id: "opencode/claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { id: "opencode/claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
  { id: "opencode/claude-sonnet-4", name: "Claude Sonnet 4" },
  { id: "opencode/claude-opus-4-8", name: "Claude Opus 4.8" },
  { id: "opencode/claude-opus-4-7", name: "Claude Opus 4.7" },
  { id: "opencode/claude-opus-4-6", name: "Claude Opus 4.6" },
  { id: "opencode/claude-opus-4-5", name: "Claude Opus 4.5" },
  { id: "opencode/claude-haiku-4-5", name: "Claude Haiku 4.5" },
  { id: "opencode/gemini-3.8-flash", name: "Gemini 3.8 Flash" },
  { id: "opencode/gemini-3.7-flash", name: "Gemini 3.7 Flash" },
  { id: "opencode/gemini-3.6-flash", name: "Gemini 3.6 Flash" },
  { id: "opencode/gemini-3.5-flash-lite", name: "Gemini 3.5 Flash-Lite" },
  { id: "opencode/gemini-3.5-flash", name: "Gemini 3.5 Flash" },
  { id: "opencode/gemini-3.1-pro", name: "Gemini 3.1 Pro" },
  { id: "opencode/gemini-3-flash", name: "Gemini 3 Flash" },
  { id: "opencode/grok-build-0.1", name: "Grok Build 0.1" },
  { id: "opencode/grok-4.6", name: "Grok 4.6" },
  { id: "opencode/grok-4.5", name: "Grok 4.5" },
  { id: "opencode/glm-5.3-flash", name: "GLM 5.3 Flash" },
  { id: "opencode/glm-5.3", name: "GLM 5.3" },
  { id: "opencode/glm-5.2", name: "GLM 5.2" },
  { id: "opencode/glm-5.1", name: "GLM 5.1" },
  { id: "opencode/glm-5", name: "GLM 5" },
  { id: "opencode/kimi-k3", name: "Kimi K3" },
  { id: "opencode/kimi-k2.7-code", name: "Kimi K2.7 Code" },
  { id: "opencode/kimi-k2.6", name: "Kimi K2.6" },
  { id: "opencode/kimi-k2.5", name: "Kimi K2.5" },
  { id: "opencode/minimax-m3", name: "MiniMax M3" },
  { id: "opencode/minimax-m2.7", name: "MiniMax M2.7" },
  { id: "opencode/minimax-m2.5", name: "MiniMax M2.5" },
  { id: "opencode/qwen3.8-flash", name: "Qwen 3.8 Flash" },
  { id: "opencode/qwen3.6-plus", name: "Qwen 3.6 Plus" },
  { id: "opencode/qwen3.5-plus", name: "Qwen 3.5 Plus" },
  { id: "opencode/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
  { id: "opencode/deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision Exp" },
  { id: "opencode/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
  { id: "opencode/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
  { id: "opencode/muse-spark-1.3", name: "Muse Spark 1.3" },
  { id: "opencode/muse-spark-1.2", name: "Muse Spark 1.2" },
  { id: "opencode/big-pickle", name: "Big Pickle" },
  { id: "opencode/mimo-v2.6-flash-free", name: "MiMo V2.6 Flash Free" },
  { id: "opencode/muse-spark-1.3-contributor-free", name: "Muse Spark 1.3 Free" },
  { id: "opencode/ling-3.0-flash-fin-free", name: "Ling 3.0 Flash Fin Free" },
  { id: "opencode/nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free" },
  { id: "opencode/muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Free" },
  { id: "opencode/nemotron-3-ultra-free", name: "Nemotron 3 Ultra Free" },
  // OpenCode Go (https://models.dev — provider "opencode-go", active models)
  { id: "opencode-go/kimi-k3", name: "Kimi K3" },
  { id: "opencode-go/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
  { id: "opencode-go/deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision Exp" },
  { id: "opencode-go/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
  { id: "opencode-go/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
  { id: "opencode-go/glm-5.3-flash", name: "GLM 5.3 Flash" },
  { id: "opencode-go/glm-5.3", name: "GLM 5.3" },
  { id: "opencode-go/glm-5.2", name: "GLM 5.2" },
  { id: "opencode-go/glm-5.1", name: "GLM 5.1" },
  { id: "opencode-go/kimi-k2.7-code", name: "Kimi K2.7 Code" },
  { id: "opencode-go/kimi-k2.6", name: "Kimi K2.6" },
  { id: "opencode-go/mimo-v2.6-pro", name: "MiMo V2.6 Pro" },
  { id: "opencode-go/mimo-v2.6-flash", name: "MiMo V2.6 Flash" },
  { id: "opencode-go/mimo-v2.5", name: "MiMo V2.5" },
  { id: "opencode-go/mimo-v2.5-pro", name: "MiMo V2.5 Pro" },
  { id: "opencode-go/minimax-m3", name: "MiniMax M3" },
  { id: "opencode-go/minimax-m2.7", name: "MiniMax M2.7" },
  { id: "opencode-go/qwen3.8-flash", name: "Qwen 3.8 Flash" },
  { id: "opencode-go/qwen3.8-max", name: "Qwen 3.8 Max" },
  { id: "opencode-go/qwen3.7-max", name: "Qwen 3.7 Max" },
  { id: "opencode-go/qwen3.7-plus", name: "Qwen 3.7 Plus" },
  { id: "opencode-go/qwen3.6-plus", name: "Qwen 3.6 Plus" },
  { id: "opencode-go/grok-4.7", name: "Grok 4.7" },
  { id: "opencode-go/grok-4.6", name: "Grok 4.6" },
  { id: "opencode-go/muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor" },
  { id: "opencode-go/muse-spark-1.2-contributor", name: "Muse Spark 1.2 Contributor" },
  { id: "opencode-go/hy4-preview", name: "Hy4 Preview" },
  { id: "opencode-go/hy3", name: "Hy3" },
  { id: "opencode-go/gpt-5.6-luna", name: "GPT 5.6 Luna" },
  { id: "opencode-go/longcat-2.0", name: "LongCat 2.0" },
];

const TOOL_DONE = new Set(["completed", "done", "success", "finished"]);
const TOOL_FAILED = new Set(["error", "failed", "cancelled", "aborted"]);

/**
 * Build a mapper for one OpenCode run. Unlike Claude, OpenCode is **stateful**:
 *
 *  - text/reasoning parts ship the *cumulative* text each update, so we diff
 *    against the last value per part id and emit only the new suffix;
 *  - tool parts stream status transitions, so we emit `tool_use` once when a
 *    tool starts and `tool_result` once when it ends (dedup by call/part id);
 *  - the first event carrying a `ses_…` id yields a single `session_start`;
 *  - every `step_finish` prices ONE model call (a turn with tool use has
 *    several), so we keep the running cost/token totals and each `result`
 *    restates the whole turn so far — the "last result wins" contract the
 *    engine and live reducer apply.
 *
 * Create a fresh mapper per run so this state never leaks between tasks.
 */
export function createOpenCodeMapper(agent: AgentInstanceId = AGENT): EventMapper {
  let sessionStarted = false;
  /**
   * Running turn totals across `step_finish` events. Unlike codex and Claude,
   * a resumed run (`--session`) needs no baseline: it streams only the new
   * turn's steps, never the session's earlier ones (checked live, 1.18.32).
   */
  let costTotal: number | undefined;
  let tokenTotal: TokenUsage | undefined;
  /** step-finish part ids already counted, so a re-emitted part never double-bills. */
  const stepsCounted = new Set<string>();
  const textSeen = new Map<string, string>();
  const toolStarted = new Set<string>();
  const toolFinished = new Set<string>();

  const diff = (key: string, full: string): string => {
    const prev = textSeen.get(key) ?? "";
    // Non-cumulative replacement that shortens the text is a reset — emitting
    // the whole new value would duplicate earlier output in the UI.
    if (full.length < prev.length) {
      textSeen.set(key, full);
      return "";
    }
    const delta = full.startsWith(prev) ? full.slice(prev.length) : full;
    textSeen.set(key, full);
    return delta;
  };

  const handlePart = (part: OpenCodePart, ts: number, out: AgentEvent[]): void => {
    const ptype = part.type;

    if (ptype === "text") {
      const delta = diff(part.id ?? "text", part.text ?? "");
      if (delta) out.push({ kind: "text_delta", agent, ts, text: delta });
      return;
    }
    if (ptype === "reasoning" || ptype === "thinking") {
      const delta = diff(part.id ?? "reasoning", part.text ?? "");
      if (delta) out.push({ kind: "text_delta", agent, ts, text: delta, thinking: true });
      return;
    }
    if (ptype === "tool" || part.tool) {
      const id = part.callID ?? part.id ?? part.tool ?? "tool";
      const name = part.tool ?? "tool";
      const status = part.state?.status;

      if (status !== undefined && TOOL_FAILED.has(status)) {
        if (!toolFinished.has(id)) {
          toolFinished.add(id);
          out.push({
            kind: "tool_result",
            agent,
            ts,
            id,
            name,
            output: stringifyContent(part.state?.error ?? part.state?.output),
            isError: true,
            status,
          });
        }
        return;
      }
      if (status !== undefined && TOOL_DONE.has(status)) {
        if (!toolFinished.has(id)) {
          toolFinished.add(id);
          out.push({
            kind: "tool_result",
            agent,
            ts,
            id,
            name,
            output: stringifyContent(
              part.state?.output ?? part.state?.metadata ?? part.state?.title,
            ),
            isError: false,
            status,
          });
        }
        return;
      }
      // undefined, a running status, OR an unrecognized status: surface a tool
      // start so an unknown future status is never silently dropped (e.g. so
      // retry never treats a step that already ran a tool as a clean, retryable
      // transport failure).
      if (!toolStarted.has(id)) {
        toolStarted.add(id);
        out.push({ kind: "tool_use", agent, ts, id, name, input: part.state?.input, status });
      }
      return;
    }
    // step-start / step-finish parts and other shapes carry no displayable text.
  };

  return (raw: unknown): AgentEvent[] => {
    const ts = Date.now();
    const parsed = opencodeEvent.safeParse(raw);
    if (!parsed.success) {
      const env = opencodeEnvelope.safeParse(raw);
      return [
        { kind: "unknown", agent, ts, rawType: env.success ? env.data.type : undefined, raw },
      ];
    }

    const e = parsed.data;
    const part = e.part ?? e.properties?.part;
    const out: AgentEvent[] = [];

    const sessionId = e.sessionID ?? part?.sessionID;
    if (!sessionStarted && sessionId && e.type !== "error") {
      sessionStarted = true;
      out.push({ kind: "session_start", agent, ts, sessionId });
    }

    switch (e.type) {
      case "error": {
        const message =
          e.error?.data?.message ?? e.error?.message ?? e.error?.name ?? "opencode error";
        out.push({ kind: "error", agent, ts, message, code: null });
        return out;
      }
      case "step_finish":
      case "step.finish": {
        // Current builds nest the step's usage in `part` (the stored
        // `step-finish` part, verbatim); older ones put it at the top level.
        const partId = part?.id;
        if (partId === undefined || !stepsCounted.has(partId)) {
          if (partId !== undefined) stepsCounted.add(partId);
          const cost = part?.cost ?? e.cost;
          if (cost !== undefined) costTotal = (costTotal ?? 0) + cost;
          const tokens = opencodeTokens(part?.tokens ?? e.tokens);
          if (tokens) tokenTotal = addUsage(tokenTotal, tokens);
        }
        out.push({
          kind: "result",
          agent,
          ts,
          isError: false,
          subtype: "step_finish",
          costUsd: costTotal,
          tokens: tokenTotal,
        });
        return out;
      }
      case "step_start":
      case "step.start": {
        // session_start (above) already covers the meaningful signal.
        return out;
      }
      default: {
        if (part) {
          handlePart(part, ts, out);
          return out;
        }
        if (out.length === 0) out.push({ kind: "unknown", agent, ts, rawType: e.type, raw });
        return out;
      }
    }
  };
}

/**
 * Map OpenCode's per-step token block onto the normalized {@link TokenUsage}.
 * OpenCode reports cache reads/writes under `cache`, so `input` is the uncached
 * prompt count. Its `output` EXCLUDES reasoning (the categories are disjoint),
 * while {@link TokenUsage.output} includes it — so reasoning is folded into
 * `output` and also kept as its (overlapping) own category.
 */
function opencodeTokens(tokens: OpenCodeTokens | undefined): TokenUsage | undefined {
  if (!tokens) return undefined;
  const out: TokenUsage = {};
  if (tokens.output !== undefined || tokens.reasoning !== undefined)
    out.output = (tokens.output ?? 0) + (tokens.reasoning ?? 0);
  if (tokens.input !== undefined) out.input = tokens.input;
  if (tokens.reasoning !== undefined) out.reasoning = tokens.reasoning;
  if (tokens.cache?.read !== undefined) out.cacheRead = tokens.cache.read;
  if (tokens.cache?.write !== undefined) out.cacheWrite = tokens.cache.write;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Field-wise sum that only sets the categories either side reports. */
function addUsage(a: TokenUsage | undefined, b: TokenUsage): TokenUsage {
  const sum: TokenUsage = { ...a };
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning"] as const) {
    if (b[key] !== undefined) sum[key] = (sum[key] ?? 0) + b[key];
  }
  return sum;
}

/**
 * CLI args for one `opencode run`.
 * NOTE: `--format json` (NOT `--command`, which suppresses JSON output).
 * `--session <sessionId>` continues the named recorded session instead of
 * starting a fresh one.
 */
/**
 * Args for one `opencode run` (also used verbatim by the mimo adapter, whose
 * CLI is an opencode fork — both providers map permissions identically).
 */
export function buildOpenCodeRunArgs(opts: AgentRunOptions): string[] {
  return [
    "run",
    "--format",
    "json",
    // Without ERROR logs on stderr, free-tier / rate-limit exhaustion is silent
    // in JSON mode while OpenCode waits (hours) to retry — steamtrain sees a hang
    // with no output. ERROR-level print-logs expose the capacity failure so the
    // shared adapter can abort and failover instead of waiting out the retry.
    "--print-logs",
    "--log-level",
    "ERROR",
    "--model",
    opts.model,
    // OpenCode resolves its project from `--dir`, not from the process cwd.
    // Without this, babysit agents spawned from a camelo worktree still shell
    // into whatever repo OpenCode last attached to (often steamtrain itself)
    // and then "can't find" the PR numbers list-prs just enumerated.
    ...(opts.cwd ? ["--dir", opts.cwd] : []),
    ...(opts.effort ? ["--variant", opts.effort] : []),
    ...(opts.resumeSessionId ? ["--session", opts.resumeSessionId] : []),
    // `--agent plan` is opencode's built-in read-only agent (write/edit/patch/
    // bash disabled); see `permissions.ts` for the profile mapping.
    ...permissionArgs(AGENT, opts.permissions),
    ...(opts.extraArgs ?? []),
  ];
}

/** Runs the real `opencode` CLI in JSON event mode. */
export class OpenCodeAdapter implements AgentAdapter {
  readonly id: AgentId = AGENT;
  readonly binary: string;
  readonly defaultModel = "opencode/mimo-v2.6-flash-free";
  /** `opencode run --session <sessionId>` continues a recorded session headlessly. */
  readonly supportsResume = true;

  constructor(binary = "opencode") {
    this.binary = binary;
  }

  run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
    return runOpenCodeProcess(
      this.id,
      this.binary,
      opts,
      createOpenCodeMapper(opts.agentId ?? this.id),
    );
  }
}

/**
 * One `run` of an OpenCode-protocol CLI (OpenCode, MiMo). A resumed session
 * recorded in another directory is first copied into `opts.cwd`: resumed as
 * is, it would run in its old directory and never report back.
 */
export async function* runOpenCodeProcess(
  id: AgentId,
  binary: string,
  opts: AgentRunOptions,
  map: EventMapper,
): AsyncGenerator<AgentEvent> {
  let run = opts;
  if (opts.resumeSessionId && opts.cwd) {
    try {
      const sessionId = await sessionForDirectory(
        binary,
        opts.resumeSessionId,
        opts.cwd,
        opts.env,
        opts.signal,
      );
      run = { ...opts, resumeSessionId: sessionId };
    } catch (err) {
      yield {
        kind: "error",
        agent: opts.agentId ?? id,
        ts: Date.now(),
        message: `could not continue session ${opts.resumeSessionId} in this step's workspace: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
      return;
    }
  }
  for await (const event of runAgentProcess({
    id,
    binary,
    args: buildOpenCodeRunArgs(run),
    opts: run,
    map,
    prompt: run.prompt,
  })) {
    // The session runs in `--dir`, so a later resume from there skips the export.
    if (event.kind === "session_start" && event.sessionId && run.cwd) {
      rememberSessionDirectory(event.sessionId, run.cwd);
    }
    yield event;
  }
}
