import type {
  AgentEvent,
  AgentId,
  AgentInstanceId,
  EventMapper,
  TokenUsage,
} from "../types/events";
import {
  type ClaudeAssistant,
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
import { humanizeAssistantError, stringifyContent } from "./util";

const AGENT: AgentId = "claude";

/** Known Claude Code models (used by `/model` and autocomplete). */
export const CLAUDE_MODELS: readonly AgentModel[] = [
  // Current (https://platform.claude.com/docs/en/about-claude/models/overview)
  { id: "claude-fable-5", name: "Claude Fable 5" },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5 (20251001)" },
  { id: "claude-mythos-5", name: "Claude Mythos 5 (limited)" },
  // Aliases (https://code.claude.com/docs/en/model-config)
  { id: "fable", name: "Fable (latest)" },
  { id: "sonnet", name: "Sonnet (latest)" },
  { id: "opus", name: "Opus (latest)" },
  { id: "haiku", name: "Haiku (latest)" },
  { id: "best", name: "Best (latest)" },
  { id: "opusplan", name: "Opus Plan" },
  // 1M context
  { id: "fable[1m]", name: "Fable (1M context)" },
  { id: "sonnet[1m]", name: "Sonnet (1M context)" },
  { id: "opus[1m]", name: "Opus (1M context)" },
  { id: "claude-fable-5[1m]", name: "Claude Fable 5 (1M context)" },
  { id: "claude-sonnet-5[1m]", name: "Claude Sonnet 5 (1M context)" },
  { id: "claude-opus-4-8[1m]", name: "Claude Opus 4.8 (1M context)" },
  { id: "claude-opus-4-7[1m]", name: "Claude Opus 4.7 (1M context)" },
  { id: "claude-sonnet-4-6[1m]", name: "Claude Sonnet 4.6 (1M context)" },
  // Legacy
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
  { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5 (20250929)" },
  { id: "claude-opus-4-5", name: "Claude Opus 4.5" },
  { id: "claude-opus-4-5-20251101", name: "Claude Opus 4.5 (20251101)" },
  { id: "claude-opus-4-1", name: "Claude Opus 4.1" },
  { id: "claude-opus-4-1-20250805", name: "Claude Opus 4.1 (20250805)" },
  { id: "claude-sonnet-4-0", name: "Claude Sonnet 4.0" },
  { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4 (20250514)" },
  { id: "claude-opus-4-0", name: "Claude Opus 4.0" },
  { id: "claude-opus-4-20250514", name: "Claude Opus 4 (20250514)" },
];

/**
 * Build a mapper for one Claude Code run.
 *
 * Streaming model (from real `stream-json` output):
 *  - `system/init`                  → session_start
 *  - `stream_event` text/thinking   → text_delta  (live, true deltas)
 *  - `assistant` message            → tool_use only; its text duplicates the
 *                                     already-streamed deltas, so we skip it
 *  - `assistant.error`              → error  (e.g. "Not logged in")
 *  - `user` message                 → tool_result blocks
 *  - `result`                       → result (is_error, cost, duration)
 *  - anything else                  → unknown passthrough
 *
 * Stateless across lines, so it is also a pure function over each raw line.
 */
export function createClaudeMapper(agent: AgentInstanceId = AGENT): EventMapper {
  return (raw: unknown): AgentEvent[] => {
    const ts = Date.now();
    const env = claudeEnvelope.safeParse(raw);
    if (!env.success) return [{ kind: "unknown", agent, ts, raw }];

    switch (env.data.type) {
      case "system": {
        const init = claudeSystemInit.safeParse(raw);
        if (init.success) {
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
        return [
          {
            kind: "result",
            agent,
            ts,
            isError: r.data.is_error ?? false,
            text: r.data.result,
            subtype: r.data.subtype,
            durationMs: r.data.duration_ms,
            costUsd: r.data.total_cost_usd,
            tokens: claudeTokens(r.data.usage),
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

  run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
    return runAgentProcess({
      id: this.id,
      binary: this.binary,
      args: buildClaudeRunArgs(opts),
      opts,
      map: createClaudeMapper(opts.agentId ?? this.id),
      prompt: opts.prompt,
    });
  }
}
