import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentEvent,
  AgentId,
  AgentInstanceId,
  EventMapper,
  TokenUsage,
} from "../types/events";
import {
  type CodexThreadItem,
  type CodexUsage,
  codexEnvelope,
  codexEvent,
} from "../types/raw-codex";
import { type AgentAdapter, type AgentRunOptions, runAgentProcess } from "./adapter";
import type { AgentModel } from "./agent-model";
import { classifyAgentFailure } from "./failure-classify";
import { permissionArgs } from "./permissions";
import { RecentSessionTotals, stringifyContent } from "./util";

const AGENT: AgentId = "codex";

/**
 * Known Codex models (plain slugs; used by `/model` and autocomplete).
 *
 * Ground truth from `codex debug models` (codex-cli 0.155.1; `visibility: list`
 * entries plus the hidden `codex-auto-review`).
 * Older pins that left this list still resolve via OpenCode family offerings
 * and runtime variant cache refresh on live installs.
 */
export const CODEX_MODELS: readonly AgentModel[] = [
  { id: "gpt-6-astra", name: "GPT-6 Astra" },
  { id: "gpt-6-sol", name: "GPT-6 Sol" },
  { id: "gpt-6-luna", name: "GPT-6 Luna" },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
  { id: "gpt-5.5", name: "GPT-5.5" },
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
 * Codex reports tokens but not cost, so the mapper prices them itself: `model`
 * picks the rate card (the CLI never names the model in its JSON events), and
 * `usageBaseline` — the thread's usage before a `codex exec resume` — is
 * subtracted so only this run's spend is reported.
 *
 * Create a fresh mapper per run so this state never leaks between tasks.
 */
export function createCodexMapper(
  agent: AgentInstanceId = AGENT,
  options: {
    model?: string;
    usageBaseline?: CodexUsage;
    /** The thread being resumed, until `thread.started` names it. */
    threadId?: string;
    /** Called with each thread-wide running total a turn reports. */
    onThreadTotal?: (threadId: string, usage: CodexUsage) => void;
  } = {},
): EventMapper {
  let threadId = options.threadId;
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
        if (e.thread_id) threadId = e.thread_id;
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
        if (e.usage && threadId) options.onThreadTotal?.(threadId, e.usage);
        const usage = subtractCodexUsage(e.usage, options.usageBaseline);
        out.push({
          kind: "result",
          agent,
          ts,
          isError: false,
          subtype: "turn.completed",
          durationMs,
          costUsd: estimateCostUsd(usage, e.model ?? options.model),
          tokens: codexTokens(usage),
        });
        return out;
      }

      case "turn.failed": {
        const message = errorMessage(e.error);
        const durationMs = turnStartedAt !== undefined ? ts - turnStartedAt : undefined;
        turnStartedAt = undefined;
        if (e.usage && threadId) options.onThreadTotal?.(threadId, e.usage);
        const usage = subtractCodexUsage(e.usage, options.usageBaseline);
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
          costUsd: estimateCostUsd(usage, e.model ?? options.model),
          tokens: codexTokens(usage),
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
  /** Cache writes, where the model bills them (GPT-5.6+: 1.25× input); else plain input. */
  cacheWrite?: number;
}

const CODEX_MODEL_PRICES: Record<string, ModelPricing> = {
  // Published standard-tier rates from https://developers.openai.com/api/docs/pricing
  // (checked 2026-09-22). The long-context tier (prompts over 272k tokens)
  // bills more, but a turn's aggregate usage can't tell which calls crossed it.
  "gpt-6-astra": { input: 10.0, cached: 1.0, cacheWrite: 12.5, output: 50.0 },
  "gpt-6-sol": { input: 2.0, cached: 0.2, cacheWrite: 2.5, output: 10.0 },
  "gpt-6-luna": { input: 0.1, cached: 0.01, cacheWrite: 0.125, output: 0.5 },
  "gpt-5.6-sol": { input: 4.0, cached: 0.4, cacheWrite: 5.0, output: 20.0 },
  "gpt-5.6-terra": { input: 2.0, cached: 0.2, cacheWrite: 2.5, output: 12.0 },
  "gpt-5.6-luna": { input: 0.2, cached: 0.02, cacheWrite: 0.25, output: 1.2 },
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
 * Falls back to GPT-5.4-mini rates when the model is unknown or absent. Cache
 * writes use the model's write rate where it has one, else the input rate.
 */
function estimateCostUsd(usage: CodexUsage | undefined, model?: string): number | undefined {
  if (!usage) return undefined;
  const input = usage.input_tokens ?? 0;
  const cached = usage.cached_input_tokens ?? 0;
  const written = usage.cache_write_input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  if (input + cached + written + output === 0) return undefined;
  const price = codexModelPrice(model);
  const uncached = Math.max(0, input - cached - written);
  return (
    (uncached * price.input +
      cached * price.cached +
      written * (price.cacheWrite ?? price.input) +
      output * price.output) /
    1_000_000
  );
}

/**
 * Map Codex usage onto the normalized {@link TokenUsage}. Codex's `input_tokens`
 * is the *total* input: cache reads and cache writes are both itemized subsets
 * of it (codex's own `ResponseCompletedUsage` test: input 100 = cached 40 +
 * write 60), so uncached input is what remains after both. Reasoning is billed
 * inside `output_tokens`, so it is reported as a subset (`reasoning`), not
 * added to the total.
 */
function codexTokens(usage: CodexUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  const cached = usage.cached_input_tokens ?? 0;
  const written = usage.cache_write_input_tokens ?? 0;
  const input = usage.input_tokens ?? 0;
  const tokens: TokenUsage = {};
  if (usage.input_tokens !== undefined) tokens.input = Math.max(0, input - cached - written);
  if (usage.cached_input_tokens !== undefined) tokens.cacheRead = cached;
  if (usage.cache_write_input_tokens !== undefined) tokens.cacheWrite = written;
  if (usage.output_tokens !== undefined) tokens.output = usage.output_tokens;
  if (usage.reasoning_output_tokens !== undefined) tokens.reasoning = usage.reasoning_output_tokens;
  return Object.keys(tokens).length > 0 ? tokens : undefined;
}

const USAGE_KEYS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
] as const;

/**
 * `usage` minus what the thread had already billed before this run, field by
 * field (never below 0). `codex exec` reports the THREAD's running total on
 * `turn.completed`, and `codex exec resume` restores that total from the
 * rollout, so a resumed run would otherwise re-report every earlier turn.
 */
export function subtractCodexUsage(
  usage: CodexUsage | undefined,
  baseline: CodexUsage | undefined,
): CodexUsage | undefined {
  if (!usage || !baseline) return usage;
  const out: CodexUsage = { ...usage };
  for (const key of USAGE_KEYS) {
    const v = usage[key];
    if (v !== undefined) out[key] = Math.max(0, v - (baseline[key] ?? 0));
  }
  return out;
}

/** Thread-wide usage totals codex runs in this process have reported. */
const CODEX_THREAD_TOTALS = new RecentSessionTotals<CodexUsage>();

/** Field-wise max of two thread totals (either may be missing). */
export function maxCodexUsage(
  a: CodexUsage | undefined,
  b: CodexUsage | undefined,
): CodexUsage | undefined {
  if (!a || !b) return a ?? b;
  const out: CodexUsage = { ...a };
  for (const key of USAGE_KEYS) {
    if (b[key] !== undefined) out[key] = Math.max(a[key] ?? 0, b[key]);
  }
  return out;
}

/** Where Codex keeps its session rollouts (`$CODEX_HOME/sessions`, default `~/.codex`). */
function codexSessionsDir(env: Record<string, string | undefined> = process.env): string {
  return path.join(env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
}

/**
 * The thread's billed-so-far usage, read from the last `token_count` event of
 * its rollout (`sessions/YYYY/MM/DD/rollout-…-<threadId>.jsonl`) — the same
 * record Codex restores on resume. `undefined` when the rollout can't be found
 * or carries no usage, in which case the run reports Codex's number unchanged.
 */
export async function readCodexThreadUsage(
  threadId: string,
  sessionsDir: string = codexSessionsDir(),
): Promise<CodexUsage | undefined> {
  const file = await findRollout(sessionsDir, `-${threadId}.jsonl`);
  if (!file) return undefined;
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"token_count"')) continue;
    try {
      const total = JSON.parse(line)?.payload?.info?.total_token_usage;
      if (total && typeof total === "object") return total as CodexUsage;
    } catch {
      // A torn final line — keep looking further back.
    }
  }
  return undefined;
}

/** Newest-first walk of the date-sharded rollout tree for a file ending in `suffix`. */
async function findRollout(dir: string, suffix: string, depth = 0): Promise<string | undefined> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const hit = entries.find((e) => e.isFile() && e.name.endsWith(suffix));
  if (hit) return path.join(dir, hit.name);
  if (depth >= 3) return undefined;
  const subdirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();
  for (const sub of subdirs) {
    const found = await findRollout(path.join(dir, sub), suffix, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** Build argv for `codex exec --json` (shared by the adapter and tests). */
export function buildCodexExecArgs(opts: AgentRunOptions): string[] {
  // Codex is the one CLI with a real sandbox, so the step's profile picks the
  // `--sandbox` level directly. Without a declared profile the historical
  // default (`workspace-write`) stands. `approval_policy="never"` is
  // unconditional either way: a headless run has nobody to approve anything,
  // so an escalation prompt would just hang until the step timeout.
  // `codex exec` itself also forces `never`. Enterprise requirements that
  // allow only `on-request` reject that value, log an error item, and fall
  // back. The engine treats a following successful turn as success.
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

  async *run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
    // A resumed thread re-reports its earlier turns' usage; subtract what it
    // had billed before this run so only the new turn is counted. The rollout
    // is what codex restores from, but a previous attempt that already
    // reported its turn (turn.completed or turn.failed both carry usage) may
    // have died before the rollout caught up — so the baseline is the larger
    // of the rollout and the last total this process saw for the thread.
    const usageBaseline = opts.resumeSessionId
      ? maxCodexUsage(
          await readCodexThreadUsage(
            opts.resumeSessionId,
            codexSessionsDir({ ...process.env, ...opts.env }),
          ),
          CODEX_THREAD_TOTALS.get(opts.resumeSessionId),
        )
      : undefined;
    yield* runAgentProcess({
      id: this.id,
      binary: this.binary,
      args: buildCodexExecArgs(opts),
      opts,
      map: createCodexMapper(opts.agentId ?? this.id, {
        model: opts.model,
        usageBaseline,
        threadId: opts.resumeSessionId,
        onThreadTotal: (id, usage) => CODEX_THREAD_TOTALS.set(id, usage),
      }),
      prompt: opts.prompt,
    });
  }
}
