import type { AgentEvent, AgentId, EventMapper } from "../types/events";
import {
  type ClaudeAssistant,
  claudeAssistant,
  claudeContentBlock,
  claudeEnvelope,
  claudeResult,
  claudeStreamEvent,
  claudeSystemInit,
  claudeUser,
} from "../types/raw-claude";
import { type AgentAdapter, type AgentRunOptions, runAgentProcess } from "./adapter";
import { stringifyContent } from "./util";

const AGENT: AgentId = "claude";

/** Known Claude Code model ids (used by `/model` and autocomplete). */
export const CLAUDE_MODELS = [
  // Current (https://platform.claude.com/docs/en/about-claude/models/overview)
  "claude-sonnet-4-6",
  "claude-opus-4-8",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
  // Aliases (https://code.claude.com/docs/en/model-config)
  "sonnet",
  "opus",
  "haiku",
  "best",
  "opusplan",
  // 1M context
  "sonnet[1m]",
  "opus[1m]",
  "claude-sonnet-4-6[1m]",
  "claude-opus-4-8[1m]",
  "claude-opus-4-7[1m]",
  // Legacy
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-5",
  "claude-opus-4-5-20251101",
  "claude-opus-4-1",
  "claude-opus-4-1-20250805",
  "claude-sonnet-4-0",
  "claude-sonnet-4-20250514",
  "claude-opus-4-0",
  "claude-opus-4-20250514",
] as const;

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
export function createClaudeMapper(agent: AgentId = AGENT): EventMapper {
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
          out.push({ kind: "error", agent, ts, message: humanizeAssistantError(parsed.data) });
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
          },
        ];
      }

      default:
        return [{ kind: "unknown", agent, ts, rawType: env.data.type, raw }];
    }
  };
}

function humanizeAssistantError(a: ClaudeAssistant): string {
  const firstText = a.message.content?.find((b) => b.type === "text")?.text;
  const code = a.error;
  if (firstText && code) return `${firstText} (${code})`;
  return firstText ?? code ?? "assistant error";
}

/** Runs the real `claude` CLI in streaming JSON mode. */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id: AgentId = AGENT;
  readonly binary: string;

  constructor(binary = "claude") {
    this.binary = binary;
  }

  run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model",
      opts.model,
      ...(opts.extraArgs ?? []),
      opts.prompt,
    ];
    return runAgentProcess({
      id: this.id,
      binary: this.binary,
      args,
      opts,
      map: createClaudeMapper(this.id),
    });
  }
}
