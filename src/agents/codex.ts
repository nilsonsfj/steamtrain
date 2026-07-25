import type {
  AgentEvent,
  AgentId,
  AgentInstanceId,
  EventMapper,
  TokenUsage,
} from "../types/events";
import { type CodexThreadItem, codexEnvelope, codexEvent } from "../types/raw-codex";
import { type AgentAdapter, type AgentRunOptions, runAgentProcess } from "./adapter";
import type { AgentModel } from "./agent-model";
import { classifyAgentFailure } from "./failure-classify";
import { permissionArgs } from "./permissions";
import { stringifyContent } from "./util";

const AGENT: AgentId = "codex";

/** Known Codex models (plain slugs; used by `/model` and autocomplete). */
export const CODEX_MODELS: readonly AgentModel[] = [
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
  { id: "gpt-5.5", name: "GPT-5.5" },
  { id: "gpt-5.4", name: "GPT-5.4" },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
  { id: "gpt-5.3-codex-mini", name: "GPT-5.3 Codex Mini" },
  { id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark" },
  { id: "gpt-5.3-codex-max", name: "GPT-5.3 Codex Max" },
  { id: "gpt-5.2", name: "GPT-5.2" },
  { id: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
  { id: "gpt-5.1", name: "GPT-5.1" },
  { id: "gpt-5.1-codex", name: "GPT-5.1 Codex" },
  { id: "gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini" },
  { id: "gpt-5.1-codex-max", name: "GPT-5.1 Codex Max" },
  { id: "gpt-5", name: "GPT-5" },
  { id: "gpt-5-codex", name: "GPT-5 Codex" },
  { id: "codex-auto-review", name: "Codex Auto Review" },
];

const COMMAND_DONE = new Set(["completed", "done", "success", "finished"]);
const COMMAND_FAILED = new Set(["failed", "error", "declined"]);

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "codex error";
}

/**
 * Build a mapper for one Codex run. Like OpenCode, Codex is **stateful**:
 *
 *  - agent_message/reasoning items may stream via `item.updated`, so we diff
 *    cumulative text per item id and emit only the new suffix;
 *  - command/tool items emit `tool_use` once when they start and `tool_result`
 *    once when they complete (dedup by item id).
 *
 * Create a fresh mapper per run so this state never leaks between tasks.
 */
export function createCodexMapper(agent: AgentInstanceId = AGENT): EventMapper {
  const textSeen = new Map<string, string>();
  const toolStarted = new Set<string>();
  const toolFinished = new Set<string>();
  let turnStartedAt: number | undefined;

  const diff = (key: string, full: string): string => {
    const prev = textSeen.get(key) ?? "";
    const delta = full.startsWith(prev) ? full.slice(prev.length) : full;
    textSeen.set(key, full);
    return delta;
  };

  const handleTextItem = (item: CodexThreadItem, ts: number, out: AgentEvent[]): void => {
    const text = item.text ?? "";
    if (!text) return;
    const key = item.id ?? item.type ?? "text";
    const thinking = item.type === "reasoning";
    const delta = diff(key, text);
    if (delta) out.push({ kind: "text_delta", agent, ts, text: delta, thinking });
  };

  const emitCommandResult = (item: CodexThreadItem, ts: number, out: AgentEvent[]): void => {
    const id = item.id ?? item.command ?? "command";
    if (toolFinished.has(id)) return;
    toolFinished.add(id);

    const name = item.command ? "command_execution" : "tool";
    const status = item.status;
    const failed = status !== undefined && COMMAND_FAILED.has(status);
    const output = item.aggregated_output ?? stringifyContent(item.result ?? item.error);
    out.push({
      kind: "tool_result",
      agent,
      ts,
      id,
      name,
      output,
      isError: failed || (item.exit_code != null && item.exit_code !== 0),
      status,
    });
  };

  const handleCommandItem = (
    item: CodexThreadItem,
    ts: number,
    out: AgentEvent[],
    terminal: boolean,
  ): void => {
    const id = item.id ?? item.command ?? "command";
    const name = item.command ? "command_execution" : "tool";
    const status = item.status;

    if (!terminal) {
      if (status !== undefined && (COMMAND_DONE.has(status) || COMMAND_FAILED.has(status))) {
        emitCommandResult(item, ts, out);
        return;
      }
      // undefined, a running status, OR an unrecognized status: surface a tool
      // start. An unknown future status must never be silently dropped — the
      // invocation has to stay visible (e.g. so retry never treats a step that
      // already ran a tool as a clean, retryable transport failure).
      if (!toolStarted.has(id)) {
        toolStarted.add(id);
        out.push({
          kind: "tool_use",
          agent,
          ts,
          id,
          name,
          input: item.command ? { command: item.command } : item.arguments,
          status,
        });
      }
      return;
    }

    emitCommandResult(item, ts, out);
  };

  const emitMcpResult = (item: CodexThreadItem, ts: number, out: AgentEvent[]): void => {
    const id = item.id ?? `${item.server ?? "mcp"}/${item.tool ?? "tool"}`;
    if (toolFinished.has(id)) return;
    toolFinished.add(id);

    const name = item.tool ?? "mcp_tool_call";
    const failed = item.status !== undefined && COMMAND_FAILED.has(item.status);
    out.push({
      kind: "tool_result",
      agent,
      ts,
      id,
      name,
      output: stringifyContent(item.result ?? item.error),
      isError: failed || item.error != null,
      status: item.status,
    });
  };

  const handleMcpItem = (
    item: CodexThreadItem,
    ts: number,
    out: AgentEvent[],
    terminal: boolean,
  ): void => {
    const id = item.id ?? `${item.server ?? "mcp"}/${item.tool ?? "tool"}`;
    const name = item.tool ?? "mcp_tool_call";

    if (!terminal) {
      if (
        item.status !== undefined &&
        (COMMAND_DONE.has(item.status) || COMMAND_FAILED.has(item.status))
      ) {
        emitMcpResult(item, ts, out);
        return;
      }
      // undefined, a running status, OR an unrecognized status: surface a tool
      // start so an unknown future status is never silently dropped.
      if (!toolStarted.has(id)) {
        toolStarted.add(id);
        out.push({
          kind: "tool_use",
          agent,
          ts,
          id,
          name,
          input: item.arguments,
          status: item.status,
        });
      }
      return;
    }

    emitMcpResult(item, ts, out);
  };

  const handleItem = (
    item: CodexThreadItem,
    ts: number,
    out: AgentEvent[],
    phase: "started" | "updated" | "completed",
  ): void => {
    const terminal = phase === "completed";
    switch (item.type) {
      case "agent_message":
      case "reasoning":
        if (phase !== "started") handleTextItem(item, ts, out);
        return;
      case "command_execution":
        handleCommandItem(item, ts, out, terminal);
        return;
      case "mcp_tool_call":
        handleMcpItem(item, ts, out, terminal);
        return;
      case "error":
        if (terminal) {
          out.push({
            kind: "error",
            agent,
            ts,
            message: item.message ?? item.text ?? "codex item error",
          });
        }
        return;
      default:
        return;
    }
  };

  return (raw: unknown): AgentEvent[] => {
    const ts = Date.now();
    const parsed = codexEvent.safeParse(raw);
    if (!parsed.success) {
      const env = codexEnvelope.safeParse(raw);
      return [
        { kind: "unknown", agent, ts, rawType: env.success ? env.data.type : undefined, raw },
      ];
    }

    const e = parsed.data;
    const out: AgentEvent[] = [];

    switch (e.type) {
      case "thread.started": {
        const event: AgentEvent & { kind: "session_start" } = {
          kind: "session_start",
          agent,
          ts,
          sessionId: e.thread_id,
        };
        if (e.model !== undefined) event.model = e.model;
        if (e.tools !== undefined) event.tools = e.tools;
        out.push(event);
        return out;
      }

      case "turn.started":
        // Record wall-clock time for duration estimation. Unlike Claude/Amp
        // which use API-reported duration_ms, Codex does not expose turn
        // latency — this is mapper-local and sufficient for TUI display.
        turnStartedAt = ts;
        return out;

      case "turn.completed": {
        const durationMs = turnStartedAt !== undefined ? ts - turnStartedAt : undefined;
        turnStartedAt = undefined;
        out.push({
          kind: "result",
          agent,
          ts,
          isError: false,
          subtype: "turn.completed",
          durationMs,
          costUsd: estimateCostUsd(e.usage, e.model),
          tokens: codexTokens(e.usage),
        });
        return out;
      }

      case "turn.failed": {
        const message = errorMessage(e.error);
        const durationMs = turnStartedAt !== undefined ? ts - turnStartedAt : undefined;
        turnStartedAt = undefined;
        const category = classifyAgentFailure(message);
        out.push({
          kind: "error",
          agent,
          ts,
          message,
          category: category === "unknown" ? undefined : category,
        });
        out.push({
          kind: "result",
          agent,
          ts,
          isError: true,
          subtype: "turn.failed",
          text: message,
          durationMs,
          costUsd: estimateCostUsd(e.usage, e.model),
          tokens: codexTokens(e.usage),
        });
        return out;
      }

      case "error": {
        const message = errorMessage(e.error);
        const category = classifyAgentFailure(message);
        out.push({
          kind: "error",
          agent,
          ts,
          message,
          category: category === "unknown" ? undefined : category,
        });
        return out;
      }

      case "item.started":
        if (e.item) handleItem(e.item, ts, out, "started");
        return out;

      case "item.updated":
        if (e.item) handleItem(e.item, ts, out, "updated");
        return out;

      case "item.completed":
        if (e.item) handleItem(e.item, ts, out, "completed");
        return out;

      default:
        if (out.length === 0) out.push({ kind: "unknown", agent, ts, rawType: e.type, raw });
        return out;
    }
  };
}

/**
 * Per-model pricing in USD per million tokens.
 *
 * Codex reports token counts but not cost. We estimate using these published
 * OpenAI rates. Reasoning tokens are billed as output (OpenAI charges reasoning
 * within `output_tokens`, so `reasoning_output_tokens` is a subset, not extra).
 */
interface ModelPricing {
  input: number;
  cached: number;
  output: number;
}

const CODEX_MODEL_PRICES: Record<string, ModelPricing> = {
  // Published rates from https://developers.openai.com/api/docs/pricing
  "gpt-5.6-sol": { input: 5.0, cached: 0.5, output: 30.0 },
  "gpt-5.6-terra": { input: 2.5, cached: 0.25, output: 15.0 },
  "gpt-5.6-luna": { input: 1.0, cached: 0.1, output: 6.0 },
  "gpt-5.5": { input: 5.0, cached: 0.5, output: 30.0 },
  "gpt-5.4": { input: 2.5, cached: 0.25, output: 15.0 },
  "gpt-5.4-mini": { input: 0.75, cached: 0.075, output: 4.5 },
  "gpt-5.3-codex": { input: 1.75, cached: 0.175, output: 14.0 },
  // Codex-specific variants not listed on the pricing page — estimated from
  // naming convention (mini/spark = mini-tier, max = full-tier).
  "gpt-5.3-codex-mini": { input: 0.75, cached: 0.075, output: 4.5 },
  "gpt-5.3-codex-spark": { input: 0.75, cached: 0.075, output: 4.5 },
  "gpt-5.3-codex-max": { input: 2.5, cached: 0.25, output: 15.0 },
  "gpt-5.2": { input: 2.5, cached: 0.25, output: 15.0 },
  "gpt-5.2-codex": { input: 1.75, cached: 0.175, output: 14.0 },
  "gpt-5.1": { input: 2.5, cached: 0.25, output: 15.0 },
  "gpt-5.1-codex": { input: 1.75, cached: 0.175, output: 14.0 },
  "gpt-5.1-codex-mini": { input: 0.75, cached: 0.075, output: 4.5 },
  "gpt-5.1-codex-max": { input: 2.5, cached: 0.25, output: 15.0 },
  "gpt-5": { input: 2.5, cached: 0.25, output: 15.0 },
  "gpt-5-codex": { input: 1.75, cached: 0.175, output: 14.0 },
  "codex-auto-review": { input: 1.75, cached: 0.175, output: 14.0 },
};

const DEFAULT_MODEL_PRICING: ModelPricing = {
  input: 0.75,
  cached: 0.075,
  output: 4.5,
};

function codexModelPrice(model: string | undefined): ModelPricing {
  if (model) {
    const price = CODEX_MODEL_PRICES[model];
    if (price) return price;
  }
  return DEFAULT_MODEL_PRICING;
}

/**
 * Estimate USD cost from Codex usage tokens.
 *
 * Pricing varies by model; we look up per-model rates from {@link CODEX_MODEL_PRICES}.
 * Falls back to GPT-5.4-mini rates when the model is unknown or absent.
 */
function estimateCostUsd(
  usage:
    | {
        input_tokens?: number;
        cached_input_tokens?: number;
        output_tokens?: number;
        reasoning_output_tokens?: number;
      }
    | undefined,
  model?: string,
): number | undefined {
  if (!usage) return undefined;
  const input = usage.input_tokens ?? 0;
  const cached = usage.cached_input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const total = input + cached + output;
  if (total === 0) return undefined;
  const { input: inputRate, cached: cachedRate, output: outputRate } = codexModelPrice(model);
  const uncached = Math.max(0, input - cached);
  return (uncached * inputRate + cached * cachedRate + output * outputRate) / 1_000_000;
}

/**
 * Map Codex usage onto the normalized {@link TokenUsage}. Codex's `input_tokens`
 * is the *total* input including cached, so uncached input is `input_tokens -
 * cached_input_tokens`. Reasoning is billed inside `output_tokens`, so it is
 * reported as a subset (`reasoning`), not added to the total.
 */
function codexTokens(
  usage:
    | {
        input_tokens?: number;
        cached_input_tokens?: number;
        output_tokens?: number;
        reasoning_output_tokens?: number;
      }
    | undefined,
): TokenUsage | undefined {
  if (!usage) return undefined;
  const cached = usage.cached_input_tokens ?? 0;
  const input = usage.input_tokens ?? 0;
  const tokens: TokenUsage = {};
  if (usage.input_tokens !== undefined) tokens.input = Math.max(0, input - cached);
  if (usage.cached_input_tokens !== undefined) tokens.cacheRead = cached;
  if (usage.output_tokens !== undefined) tokens.output = usage.output_tokens;
  if (usage.reasoning_output_tokens !== undefined) tokens.reasoning = usage.reasoning_output_tokens;
  return Object.keys(tokens).length > 0 ? tokens : undefined;
}

/** Build argv for `codex exec --json` (shared by the adapter and tests). */
export function buildCodexExecArgs(opts: AgentRunOptions): string[] {
  // Codex is the one CLI with a real sandbox, so the step's profile picks the
  // `--sandbox` level directly. Without a declared profile the historical
  // default (`workspace-write`) stands. `approval_policy="never"` is
  // unconditional either way: a headless run has nobody to approve anything,
  // so an escalation prompt would just hang until the step timeout.
  const sandbox = permissionArgs(AGENT, opts.permissions);
  return [
    "exec",
    // `codex exec resume <sessionId>` continues a recorded session (the
    // `thread_id` from `thread.started`); the remaining flags apply unchanged.
    ...(opts.resumeSessionId ? ["resume", opts.resumeSessionId] : []),
    "--json",
    ...(sandbox.length > 0 ? sandbox : ["--sandbox", "workspace-write"]),
    "-c",
    'approval_policy="never"',
    "--skip-git-repo-check",
    "--model",
    opts.model,
    ...(opts.effort ? ["-c", `model_reasoning_effort="${opts.effort}"`] : []),
    ...(opts.extraArgs ?? []),
  ];
}

/** Runs the real `codex` CLI in JSON event mode. */
export class CodexAdapter implements AgentAdapter {
  readonly id: AgentId = AGENT;
  readonly binary: string;
  readonly defaultModel = "gpt-5.5";
  /** `codex exec resume <sessionId>` continues a recorded session headlessly. */
  readonly supportsResume = true;

  constructor(binary = "codex") {
    this.binary = binary;
  }

  run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
    return runAgentProcess({
      id: this.id,
      binary: this.binary,
      args: buildCodexExecArgs(opts),
      opts,
      map: createCodexMapper(opts.agentId ?? this.id),
      prompt: opts.prompt,
    });
  }
}
