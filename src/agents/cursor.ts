import type {
  AgentEvent,
  AgentInstanceId,
  EventMapper,
  TokenUsage,
} from "../types/events";
import {
  type CursorToolCallPayload,
  type CursorUsage,
  cursorAssistant,
  cursorEnvelope,
  cursorResult,
  cursorSystemInit,
  cursorToolCall,
} from "../types/raw-cursor";
import { stringifyContent } from "./util";

const AGENT: AgentInstanceId = "cursor";

function cursorTokens(usage: CursorUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  const tokens: TokenUsage = {};
  if (usage.input_tokens !== undefined) tokens.input = usage.input_tokens;
  if (usage.output_tokens !== undefined) tokens.output = usage.output_tokens;
  if (usage.cache_read_input_tokens !== undefined) tokens.cacheRead = usage.cache_read_input_tokens;
  if (usage.cache_creation_input_tokens !== undefined)
    tokens.cacheWrite = usage.cache_creation_input_tokens;
  return Object.keys(tokens).length > 0 ? tokens : undefined;
}

function extractToolInfo(
  toolCall: CursorToolCallPayload | undefined,
): { name: string; input?: unknown; result?: unknown } | undefined {
  if (!toolCall) return undefined;

  if (toolCall.readToolCall) {
    return {
      name: "read",
      input: toolCall.readToolCall.args,
      result: toolCall.readToolCall.result,
    };
  }

  if (toolCall.writeToolCall) {
    return {
      name: "write",
      input: toolCall.writeToolCall.args,
      result: toolCall.writeToolCall.result,
    };
  }

  if (toolCall.function) {
    const name = toolCall.function.name ?? "function";
    let input: unknown;
    if (typeof toolCall.function.arguments === "string") {
      try {
        input = JSON.parse(toolCall.function.arguments);
      } catch {
        input = { arguments: toolCall.function.arguments };
      }
    }
    return { name, input };
  }

  return undefined;
}

/**
 * Build a mapper for one Cursor Agent CLI run.
 *
 * Cursor emits NDJSON with streaming assistant deltas (`timestamp_ms` present,
 * `model_call_id` absent), buffered assistant flushes (skipped), tool_call
 * start/complete pairs, and a terminal result line.
 */
export function createCursorMapper(agent: AgentInstanceId = AGENT): EventMapper {
  return (raw: unknown): AgentEvent[] => {
    const ts = Date.now();
    const env = cursorEnvelope.safeParse(raw);
    if (!env.success) return [{ kind: "unknown", agent, ts, raw }];

    switch (env.data.type) {
      case "system": {
        const init = cursorSystemInit.safeParse(raw);
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
        return [];
      }

      case "user":
        return [];

      case "assistant": {
        const parsed = cursorAssistant.safeParse(raw);
        if (!parsed.success) return [{ kind: "unknown", agent, ts, rawType: "assistant", raw }];
        if ("timestamp_ms" in parsed.data && !("model_call_id" in parsed.data)) {
          const texts: string[] = [];
          for (const block of parsed.data.message.content ?? []) {
            if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
          }
          const text = texts.join("");
          if (text) return [{ kind: "text_delta", agent, ts, text }];
        }
        return [];
      }

      case "tool_call": {
        const parsed = cursorToolCall.safeParse(raw);
        if (!parsed.success) return [{ kind: "unknown", agent, ts, rawType: "tool_call", raw }];
        const info = extractToolInfo(parsed.data.tool_call);
        if (!info) return [{ kind: "unknown", agent, ts, rawType: "tool_call", raw }];

        if (parsed.data.subtype === "started") {
          return [
            {
              kind: "tool_use",
              agent,
              ts,
              id: parsed.data.call_id,
              name: info.name,
              input: info.input,
            },
          ];
        }

        if (parsed.data.subtype === "completed") {
          return [
            {
              kind: "tool_result",
              agent,
              ts,
              id: parsed.data.call_id,
              name: info.name,
              output: stringifyContent(info.result),
            },
          ];
        }

        return [];
      }

      case "result": {
        const r = cursorResult.safeParse(raw);
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
            tokens: cursorTokens(r.data.usage),
          },
        ];
      }

      default:
        return [{ kind: "unknown", agent, ts, rawType: env.data.type, raw }];
    }
  };
}
