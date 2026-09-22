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
  type ClaudeAssistant,
  type ClaudeModelUsage,
  type ClaudeUsage,
  claudeAssistant,
  claudeContentBlock,
  claudeEnvelope,
  claudeResult,
  claudeStreamEvent,
  claudeSystemInit,
  claudeUser,
} from "../types/raw-claude";
import { type AgentAdapter, type AgentRunOptions, runAgentProcess } from "./adapter";
import type { AgentModel } from "./agent-model";
import { classifyAgentFailure } from "./failure-classify";
import { permissionArgs } from "./permissions";
import { RecentSessionTotals, humanizeAssistantError, stringifyContent } from "./util";

const AGENT: AgentId = "claude";

/**
 * Known Claude Code models (used by `/model` and autocomplete).
 *
 * Current ids from https://platform.claude.com/docs/en/about-claude/models/overview
 * and https://support.claude.com/en/articles/11940350-claude-code-model-configuration
 * (verified against Claude Code 2.1.221: `/model` aliases include opus → Opus 5;
 * Opus 5.5 and Fable 5.1 added from the models.dev Anthropic list, 2026-09-22).
 */
const CLAUDE_MODEL_GROUP_CURRENT = "Current";
const CLAUDE_MODEL_GROUP_ALIASES = "Aliases (latest)";
const CLAUDE_MODEL_GROUP_1M = "1M context";
const CLAUDE_MODEL_GROUP_PREVIOUS = "Previous";
const CLAUDE_MODEL_GROUP_OLDER = "Older snapshots";

export const CLAUDE_MODELS: readonly AgentModel[] = [
  // Current
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", group: CLAUDE_MODEL_GROUP_CURRENT },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", group: CLAUDE_MODEL_GROUP_CURRENT },
  { id: "claude-fable-5", name: "Claude Fable 5", group: CLAUDE_MODEL_GROUP_CURRENT },
  { id: "claude-opus-5", name: "Claude Opus 5", group: CLAUDE_MODEL_GROUP_CURRENT },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", group: CLAUDE_MODEL_GROUP_CURRENT },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", group: CLAUDE_MODEL_GROUP_CURRENT },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5 (20251001)",
    group: CLAUDE_MODEL_GROUP_CURRENT,
  },
  {
    id: "claude-mythos-5",
    name: "Claude Mythos 5 (limited)",
    group: CLAUDE_MODEL_GROUP_CURRENT,
  },
  // Aliases (https://code.claude.com/docs/en/model-config)
  { id: "fable", name: "Fable (latest)", group: CLAUDE_MODEL_GROUP_ALIASES },
  { id: "sonnet", name: "Sonnet (latest)", group: CLAUDE_MODEL_GROUP_ALIASES },
  { id: "opus", name: "Opus (latest)", group: CLAUDE_MODEL_GROUP_ALIASES },
  { id: "haiku", name: "Haiku (latest)", group: CLAUDE_MODEL_GROUP_ALIASES },
  { id: "best", name: "Best (latest)", group: CLAUDE_MODEL_GROUP_ALIASES },
  { id: "opusplan", name: "Opus Plan", group: CLAUDE_MODEL_GROUP_ALIASES },
  // 1M context
  { id: "fable[1m]", name: "Fable (1M context)", group: CLAUDE_MODEL_GROUP_1M },
  { id: "sonnet[1m]", name: "Sonnet (1M context)", group: CLAUDE_MODEL_GROUP_1M },
  { id: "opus[1m]", name: "Opus (1M context)", group: CLAUDE_MODEL_GROUP_1M },
  {
    id: "claude-fable-5[1m]",
    name: "Claude Fable 5 (1M context)",
    group: CLAUDE_MODEL_GROUP_1M,
  },
  { id: "claude-opus-5[1m]", name: "Claude Opus 5 (1M context)", group: CLAUDE_MODEL_GROUP_1M },
  {
    id: "claude-sonnet-5[1m]",
    name: "Claude Sonnet 5 (1M context)",
    group: CLAUDE_MODEL_GROUP_1M,
  },
  {
    id: "claude-opus-4-8[1m]",
    name: "Claude Opus 4.8 (1M context)",
    group: CLAUDE_MODEL_GROUP_1M,
  },
  {
    id: "claude-opus-4-7[1m]",
    name: "Claude Opus 4.7 (1M context)",
    group: CLAUDE_MODEL_GROUP_1M,
  },
  {
    id: "claude-sonnet-4-6[1m]",
    name: "Claude Sonnet 4.6 (1M context)",
    group: CLAUDE_MODEL_GROUP_1M,
  },
  // Previous / still documented
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", group: CLAUDE_MODEL_GROUP_PREVIOUS },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", group: CLAUDE_MODEL_GROUP_PREVIOUS },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", group: CLAUDE_MODEL_GROUP_PREVIOUS },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", group: CLAUDE_MODEL_GROUP_PREVIOUS },
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", group: CLAUDE_MODEL_GROUP_PREVIOUS },
  {
    id: "claude-sonnet-4-5-20250929",
    name: "Claude Sonnet 4.5 (20250929)",
    group: CLAUDE_MODEL_GROUP_PREVIOUS,
  },
  { id: "claude-opus-4-5", name: "Claude Opus 4.5", group: CLAUDE_MODEL_GROUP_PREVIOUS },
  {
    id: "claude-opus-4-5-20251101",
    name: "Claude Opus 4.5 (20251101)",
    group: CLAUDE_MODEL_GROUP_PREVIOUS,
  },
  // Older snapshots still accepted by Claude Code
  { id: "claude-opus-4-1", name: "Claude Opus 4.1", group: CLAUDE_MODEL_GROUP_OLDER },
  {
    id: "claude-opus-4-1-20250805",
    name: "Claude Opus 4.1 (20250805)",
    group: CLAUDE_MODEL_GROUP_OLDER,
  },
  { id: "claude-sonnet-4-0", name: "Claude Sonnet 4.0", group: CLAUDE_MODEL_GROUP_OLDER },
  {
    id: "claude-sonnet-4-20250514",
    name: "Claude Sonnet 4 (20250514)",
    group: CLAUDE_MODEL_GROUP_OLDER,
  },
  { id: "claude-opus-4-0", name: "Claude Opus 4.0", group: CLAUDE_MODEL_GROUP_OLDER },
  {
    id: "claude-opus-4-20250514",
    name: "Claude Opus 4 (20250514)",
    group: CLAUDE_MODEL_GROUP_OLDER,
  },
];

/**
 * Build a mapper for one Claude Code run.
 *
 * Streaming model (from real `stream-json` output):
 *  - `system/init`                  → session_start
 *  - `stream_event` text/thinking   → text_delta  (live, true deltas)
 *  - `assistant` message            → tool_use only; its text duplicates the
 *                                     already-streamed deltas, so we skip it
 *                                     — plus `usage` for the live token count
 *  - `assistant.error`              → error  (e.g. "Not logged in")
 *  - `user` message                 → tool_result blocks
 *  - `result`                       → result (is_error, cost, duration)
 *  - anything else                  → unknown passthrough
 *
 * Carries one piece of state across lines — the usage already reported per
 * assistant message, so repeated lines for the same message emit only what
 * grew (see `reportUsage`). Everything else is a pure function of the raw line.
 */
export function createClaudeMapper(
  agent: AgentInstanceId = AGENT,
  options: {
    costBaseline?: ClaudeSessionCost;
    /** The session being resumed, until the stream names it. */
    sessionId?: string;
    /** Called with each session-wide running total a `result` reports. */
    onSessionTotal?: (sessionId: string, total: ClaudeSessionCost) => void;
  } = {},
): EventMapper {
  /**
   * Usage already reported, per message id. Per id rather than "the last
   * message": a subagent's (Task) assistant lines interleave with the main
   * loop's, and a single slot would re-bill a message on every switch.
   */
  const usageReported = new Map<string | undefined, TokenUsage>();
  let sessionId = options.sessionId;
  /** The most recent message id — where id-less readings are attributed. */
  let lastMessageId: string | undefined;
  /**
   * The message the API stream (`stream_event`, main loop only) is currently
   * on — `message_delta` carries no id, and a subagent line may have moved
   * `lastMessageId` since `message_start`.
   */
  let streamMessageId: string | undefined;

  /**
   * A `usage` event for what `usage` adds over what was already reported for
   * message `id`, or nothing. An unseen id is a fresh message billed in full.
   * An id-less reading folds into the latest message on purpose: an
   * undercount is recoverable when the `result` totals land, a double count is
   * a number nobody can explain. The watermark is a field-wise max, so a
   * stale, lower restatement can never re-bill the difference.
   */
  const reportUsage = (
    id: string | undefined,
    usage: TokenUsage | undefined,
    ts: number,
  ): AgentEvent[] => {
    if (!usage) return [];
    const key = id ?? lastMessageId;
    lastMessageId = key;
    const already = usageReported.get(key);
    const increment = usageIncrement(already, usage);
    usageReported.set(key, maxUsage(already, usage));
    return increment ? [{ kind: "usage", agent, ts, tokens: increment }] : [];
  };

  return (raw: unknown): AgentEvent[] => {
    const ts = Date.now();
    const env = claudeEnvelope.safeParse(raw);
    if (!env.success) return [{ kind: "unknown", agent, ts, raw }];

    switch (env.data.type) {
      case "system": {
        const init = claudeSystemInit.safeParse(raw);
        if (init.success) {
          if (init.data.session_id) sessionId = init.data.session_id;
          return [
            {
              kind: "session_start",
              agent,
              ts,
              sessionId: init.data.session_id,
              model: init.data.model,
              tools: init.data.tools,
            },
          ];
        }
        // system/status, system/thinking_tokens, ... — not surfaced.
        return [];
      }

      case "stream_event": {
        const se = claudeStreamEvent.safeParse(raw);
        if (!se.success) return [];
        const ev = se.data.event;
        // Live spend, straight from the API stream: `message_start` opens a
        // message (and names it), `message_delta` carries its running usage —
        // the only place the final output count shows up before `result`.
        if (ev.type === "message_start" && ev.message) {
          streamMessageId = ev.message.id;
          return reportUsage(ev.message.id, claudeTokens(ev.message.usage), ts);
        }
        if (ev.type === "message_delta") {
          return reportUsage(streamMessageId, claudeTokens(ev.usage), ts);
        }
        if (ev.type === "content_block_delta" && ev.delta) {
          if (ev.delta.type === "text_delta" && typeof ev.delta.text === "string") {
            return [{ kind: "text_delta", agent, ts, text: ev.delta.text }];
          }
          if (ev.delta.type === "thinking_delta" && typeof ev.delta.thinking === "string") {
            return [{ kind: "text_delta", agent, ts, text: ev.delta.thinking, thinking: true }];
          }
        }
        // message_start/stop, content_block_start/stop, signature_delta, ...
        return [];
      }

      case "assistant": {
        const parsed = claudeAssistant.safeParse(raw);
        if (!parsed.success) return [{ kind: "unknown", agent, ts, rawType: "assistant", raw }];
        const out: AgentEvent[] = [];
        if (parsed.data.error) {
          const message = humanizeAssistantError(parsed.data);
          const category = classifyAgentFailure(message);
          out.push({
            kind: "error",
            agent,
            ts,
            message,
            category: category === "unknown" ? undefined : category,
          });
        }
        for (const block of parsed.data.message.content ?? []) {
          if (block.type === "tool_use" && block.name) {
            out.push({
              kind: "tool_use",
              agent,
              ts,
              id: block.id,
              name: block.name,
              input: block.input,
            });
          }
          // text/thinking blocks are intentionally skipped (already streamed).
        }
        // Live spend. Claude Code repeats an `assistant` line per content block
        // of the same message (same `message.id`), each restating that
        // message's usage — `reportUsage` emits only what grew.
        out.push(
          ...reportUsage(parsed.data.message.id, claudeTokens(parsed.data.message.usage), ts),
        );
        return out;
      }

      case "user": {
        const parsed = claudeUser.safeParse(raw);
        if (!parsed.success) return [];
        const out: AgentEvent[] = [];
        for (const block of parsed.data.message.content ?? []) {
          if (block.type === "tool_result") {
            out.push({
              kind: "tool_result",
              agent,
              ts,
              id: block.tool_use_id ?? block.id,
              output: stringifyContent(block.content),
              isError: block.is_error,
            });
          }
        }
        return out;
      }

      case "tool_use": {
        const b = claudeContentBlock.safeParse(raw);
        if (b.success && b.data.name) {
          return [
            { kind: "tool_use", agent, ts, id: b.data.id, name: b.data.name, input: b.data.input },
          ];
        }
        return [{ kind: "unknown", agent, ts, rawType: "tool_use", raw }];
      }

      case "tool_result": {
        const b = claudeContentBlock.safeParse(raw);
        if (b.success) {
          return [
            {
              kind: "tool_result",
              agent,
              ts,
              id: b.data.tool_use_id ?? b.data.id,
              output: stringifyContent(b.data.content),
              isError: b.data.is_error,
            },
          ];
        }
        return [{ kind: "unknown", agent, ts, rawType: "tool_result", raw }];
      }

      case "result": {
        const r = claudeResult.safeParse(raw);
        if (!r.success) return [{ kind: "unknown", agent, ts, rawType: "result", raw }];
        const resultSession = r.data.session_id ?? sessionId;
        if (resultSession && r.data.total_cost_usd !== undefined) {
          options.onSessionTotal?.(resultSession, {
            costUsd: r.data.total_cost_usd,
            modelUsage: r.data.modelUsage,
          });
        }
        return [
          {
            kind: "result",
            agent,
            ts,
            isError: r.data.is_error ?? false,
            text: r.data.result,
            subtype: r.data.subtype,
            durationMs: r.data.duration_ms,
            // On `--resume`, Claude Code restores the session's cost tracker,
            // so these totals include every earlier run of the session; the
            // baseline (what it had billed before this run) comes off.
            costUsd:
              r.data.total_cost_usd === undefined
                ? undefined
                : Math.max(0, r.data.total_cost_usd - (options.costBaseline?.costUsd ?? 0)),
            // `usage` is the fallback for a result with no `modelUsage`. Claude
            // Code sums it from the same restored ledger, so it takes the
            // baseline off too.
            tokens:
              claudeModelTokens(
                subtractModelUsage(r.data.modelUsage, options.costBaseline?.modelUsage),
              ) ??
              subtractTokens(
                claudeTokens(r.data.usage),
                claudeModelTokens(options.costBaseline?.modelUsage),
              ),
          },
        ];
      }

      default:
        return [{ kind: "unknown", agent, ts, rawType: env.data.type, raw }];
    }
  };
}

/**
 * Map Anthropic's usage block onto the normalized {@link TokenUsage}. Anthropic
 * reports cache reads/writes separately from `input_tokens`, so `input` is
 * already the uncached prompt count.
 */
function claudeTokens(usage: ClaudeUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  const tokens: TokenUsage = {};
  if (usage.input_tokens !== undefined) tokens.input = usage.input_tokens;
  if (usage.output_tokens !== undefined) tokens.output = usage.output_tokens;
  if (usage.cache_read_input_tokens !== undefined) tokens.cacheRead = usage.cache_read_input_tokens;
  if (usage.cache_creation_input_tokens !== undefined)
    tokens.cacheWrite = usage.cache_creation_input_tokens;
  return Object.keys(tokens).length > 0 ? tokens : undefined;
}

/**
 * Sum the `result`'s per-model `modelUsage` map. Preferred over `usage`, which
 * covers only the main loop: a turn that delegates to subagents (Task) bills
 * their calls into `total_cost_usd` and `modelUsage` but not into `usage`, so
 * tokens read from `usage` would not add up to the reported cost.
 */
function claudeModelTokens(
  modelUsage: Record<string, ClaudeModelUsage> | undefined,
): TokenUsage | undefined {
  const models = Object.values(modelUsage ?? {});
  if (models.length === 0) return undefined;
  const tokens: TokenUsage = {};
  const add = (key: keyof TokenUsage, n: number | undefined) => {
    if (n !== undefined) tokens[key] = (tokens[key] ?? 0) + n;
  };
  for (const m of models) {
    add("input", m.inputTokens);
    add("output", m.outputTokens);
    add("cacheRead", m.cacheReadInputTokens);
    add("cacheWrite", m.cacheCreationInputTokens);
  }
  return Object.keys(tokens).length > 0 ? tokens : undefined;
}

/** `tokens` less `baseline`, field by field, never below zero. */
function subtractTokens(
  tokens: TokenUsage | undefined,
  baseline: TokenUsage | undefined,
): TokenUsage | undefined {
  if (!tokens || !baseline) return tokens;
  const out: TokenUsage = {};
  for (const [key, n] of Object.entries(tokens) as [keyof TokenUsage, number | undefined][]) {
    if (n !== undefined) out[key] = Math.max(0, n - (baseline[key] ?? 0));
  }
  return out;
}

/** What a Claude session had billed so far, from its transcript's `cost-state` record. */
export interface ClaudeSessionCost {
  costUsd?: number;
  modelUsage?: Record<string, ClaudeModelUsage>;
}

const MODEL_USAGE_KEYS = [
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
] as const;

/** `modelUsage` minus a baseline, per model and field (never below 0). */
function subtractModelUsage(
  modelUsage: Record<string, ClaudeModelUsage> | undefined,
  baseline: Record<string, ClaudeModelUsage> | undefined,
): Record<string, ClaudeModelUsage> | undefined {
  if (!modelUsage || !baseline) return modelUsage;
  const out: Record<string, ClaudeModelUsage> = {};
  for (const [model, usage] of Object.entries(modelUsage)) {
    const before = baseline[model];
    const row: ClaudeModelUsage = { ...usage };
    for (const key of MODEL_USAGE_KEYS) {
      const v = usage[key];
      if (v !== undefined) row[key] = Math.max(0, v - (before?.[key] ?? 0));
    }
    out[model] = row;
  }
  return out;
}

/** Session-wide cost totals Claude runs in this process have reported. */
const CLAUDE_SESSION_TOTALS = new RecentSessionTotals<ClaudeSessionCost>();

/** Field-wise max of two session totals (either may be missing). */
export function maxSessionCost(
  a: ClaudeSessionCost | undefined,
  b: ClaudeSessionCost | undefined,
): ClaudeSessionCost | undefined {
  if (!a || !b) return a ?? b;
  const modelUsage: Record<string, ClaudeModelUsage> = { ...a.modelUsage };
  for (const [model, usage] of Object.entries(b.modelUsage ?? {})) {
    const row: ClaudeModelUsage = { ...modelUsage[model] };
    for (const key of MODEL_USAGE_KEYS) {
      if (usage[key] !== undefined) row[key] = Math.max(row[key] ?? 0, usage[key]);
    }
    modelUsage[model] = row;
  }
  const costUsd =
    a.costUsd === undefined && b.costUsd === undefined
      ? undefined
      : Math.max(a.costUsd ?? 0, b.costUsd ?? 0);
  return { costUsd, modelUsage };
}

/** Claude Code's config root: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
function claudeConfigDir(env: Record<string, string | undefined>): string {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

/**
 * The session's billed-so-far totals: the last `{"type":"cost-state",
 * totalCostUSD, modelUsage}` line of `projects/<cwd>/<sessionId>.jsonl` —
 * the record Claude Code restores its cost tracker from on `--resume`.
 * `undefined` when the transcript or record can't be found, in which case
 * the run reports Claude's totals unchanged.
 */
export async function readClaudeSessionCost(
  sessionId: string,
  configDir: string,
): Promise<ClaudeSessionCost | undefined> {
  const projectsDir = path.join(configDir, "projects");
  let projects: string[];
  try {
    projects = await fs.readdir(projectsDir);
  } catch {
    return undefined;
  }
  for (const project of projects) {
    let text: string;
    try {
      text = await fs.readFile(path.join(projectsDir, project, `${sessionId}.jsonl`), "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (!line.includes('"cost-state"')) continue;
      try {
        const record = JSON.parse(line);
        if (record?.type !== "cost-state") continue;
        return {
          costUsd: typeof record.totalCostUSD === "number" ? record.totalCostUSD : undefined,
          modelUsage: record.modelUsage,
        };
      } catch {
        // A torn line — keep looking further back.
      }
    }
    return undefined;
  }
  return undefined;
}

/**
 * What `next` adds over `already` field by field, or `undefined` when it adds
 * nothing. A counter that went backwards contributes 0 rather than a negative:
 * the stream is a report, not an arithmetic identity, and a live readout that
 * ticks down would be read as a bug.
 */
function usageIncrement(already: TokenUsage | undefined, next: TokenUsage): TokenUsage | undefined {
  if (!already) return next;
  const delta: TokenUsage = {};
  let any = false;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning"] as const) {
    const grew = (next[key] ?? 0) - (already[key] ?? 0);
    if (grew > 0) {
      delta[key] = grew;
      any = true;
    }
  }
  return any ? delta : undefined;
}

/** Field-wise max of two usage readings of the same message. */
function maxUsage(a: TokenUsage | undefined, b: TokenUsage): TokenUsage {
  if (!a) return b;
  const out: TokenUsage = { ...a };
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning"] as const) {
    if (b[key] !== undefined) out[key] = Math.max(a[key] ?? 0, b[key]);
  }
  return out;
}

/**
 * Args for one `claude` run. Permission flags land *before* `extraArgs` so a
 * hand-written flag can still override the profile's translation.
 */
export function buildClaudeRunArgs(opts: AgentRunOptions): string[] {
  return [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    opts.model,
    ...(opts.effort ? ["--effort", opts.effort] : []),
    ...(opts.resumeSessionId ? ["--resume", opts.resumeSessionId] : []),
    ...permissionArgs(AGENT, opts.permissions),
    ...(opts.extraArgs ?? []),
  ];
}

/** Runs the real `claude` CLI in streaming JSON mode. */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id: AgentId = AGENT;
  readonly binary: string;
  readonly defaultModel = "claude-sonnet-5";
  /** `claude --resume <sessionId>` continues a recorded session headlessly. */
  readonly supportsResume = true;

  constructor(binary = "claude") {
    this.binary = binary;
  }

  async *run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
    // A resumed session reports its whole history's cost; subtract what it
    // had billed before this run so only the new turn is counted. The
    // transcript's cost-state is what Claude Code restores from, but a
    // previous attempt that already printed its result may have died before
    // writing it — so the baseline is the larger of the two.
    const costBaseline = opts.resumeSessionId
      ? maxSessionCost(
          await readClaudeSessionCost(
            opts.resumeSessionId,
            claudeConfigDir({ ...process.env, ...opts.env }),
          ),
          CLAUDE_SESSION_TOTALS.get(opts.resumeSessionId),
        )
      : undefined;
    yield* runAgentProcess({
      id: this.id,
      binary: this.binary,
      args: buildClaudeRunArgs(opts),
      opts,
      map: createClaudeMapper(opts.agentId ?? this.id, {
        costBaseline,
        sessionId: opts.resumeSessionId,
        // Session totals only grow; keep the high-water mark so a partial
        // report never lowers the next attempt's baseline.
        onSessionTotal: (id, total) =>
          CLAUDE_SESSION_TOTALS.set(
            id,
            maxSessionCost(CLAUDE_SESSION_TOTALS.get(id), total) ?? total,
          ),
      }),
      prompt: opts.prompt,
    });
  }
}
