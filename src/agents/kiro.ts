import type {
  AgentEvent,
  AgentId,
  AgentInstanceId,
  EventMapper,
  TokenUsage,
} from "../types/events";
import {
  type KiroUsage,
  kiroAssistant,
  kiroEnvelope,
  kiroResult,
  kiroSystemInit,
  kiroUser,
} from "../types/raw-kiro";
import { type AgentAdapter, type AgentRunOptions, runAgentProcess } from "./adapter";
import type { AgentModel } from "./agent-model";
import { humanizeAssistantError, stringifyContent } from "./util";

const AGENT: AgentId = "kiro";

/**
 * Known Kiro models. Kiro runs on Anthropic Claude models, so it supports the
 * same aliases and full model IDs as Claude Code.
 */
export const KIRO_MODELS: readonly AgentModel[] = [
  { id: "sonnet", name: "Sonnet (latest)" },
  { id: "opus", name: "Opus (latest)" },
  { id: "haiku", name: "Haiku (latest)" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
];

/**
 * Build a mapper for one kiro run.
 *
 * kiro emits a Claude Code-compatible **message-level** stream JSON format -- it
 * does NOT stream partial `stream_event` deltas -- so, like the amp mapper,
 * this one surfaces text directly from the full `assistant` message blocks:
 *
 *  - `system/init`            -> session_start (model from the init payload)
 *  - `assistant` text/think   -> text_delta (the message is the only text we get)
 *  - `assistant` tool_use     -> tool_use
 *  - `assistant.error`        -> error
 *  - `user` tool_result       -> tool_result
 *  - `result`                 -> result; plus an `error` event when the turn
 *                               failed with a message so it surfaces
 *  - anything else            -> unknown passthrough
 *
 * Stateless across lines, so it is also a pure function over each raw line.
 */
export function createKiroMapper(agent: AgentInstanceId = AGENT): EventMapper {
  return (raw: unknown): AgentEvent[] => {
    const ts = Date.now();
    const env = kiroEnvelope.safeParse(raw);
    if (!env.success) return [{ kind: "unknown", agent, ts, raw }];

    switch (env.data.type) {
      case "system": {
        const init = kiroSystemInit.safeParse(raw);
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

      case "assistant": {
        const parsed = kiroAssistant.safeParse(raw);
        if (!parsed.success) return [{ kind: "unknown", agent, ts, rawType: "assistant", raw }];
        const out: AgentEvent[] = [];
        if (parsed.data.error) {
          out.push({ kind: "error", agent, ts, message: humanizeAssistantError(parsed.data) });
        }
        for (const block of parsed.data.message.content ?? []) {
          if (block.type === "text" && typeof block.text === "string" && block.text) {
            out.push({ kind: "text_delta", agent, ts, text: block.text });
          } else if (
            block.type === "thinking" &&
            typeof block.thinking === "string" &&
            block.thinking
          ) {
            out.push({ kind: "text_delta", agent, ts, text: block.thinking, thinking: true });
          } else if (block.type === "tool_use" && block.name) {
            out.push({
              kind: "tool_use",
              agent,
              ts,
              id: block.id,
              name: block.name,
              input: block.input,
            });
          }
        }
        return out;
      }

      case "user": {
        const parsed = kiroUser.safeParse(raw);
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

      case "result": {
        const r = kiroResult.safeParse(raw);
        if (!r.success) return [{ kind: "unknown", agent, ts, rawType: "result", raw }];
        const out: AgentEvent[] = [];
        if (r.data.is_error && r.data.error) {
          out.push({ kind: "error", agent, ts, message: r.data.error, code: null });
        }
        out.push({
          kind: "result",
          agent,
          ts,
          isError: r.data.is_error ?? false,
          text: r.data.result,
          subtype: r.data.subtype,
          durationMs: r.data.duration_ms,
          costUsd: r.data.total_cost_usd,
          tokens: kiroTokens(r.data.usage),
        });
        return out;
      }

      default:
        return [{ kind: "unknown", agent, ts, rawType: env.data.type, raw }];
    }
  };
}

/** Map Kiro's Anthropic-shaped usage onto the normalized {@link TokenUsage}. */
function kiroTokens(usage: KiroUsage | undefined): TokenUsage | undefined {
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
 * Build the `kiro` argv for one print-mode run.
 *
 * kiro uses `--print --output-format stream-json --verbose --model MODEL`
 * plus optional `--effort EFFORT` and any extra args. The prompt is written
 * to stdin (like Claude Code).
 */
export function buildKiroExecArgs(opts: AgentRunOptions): string[] {
  return [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    opts.model,
    ...(opts.effort ? ["--effort", opts.effort] : []),
    ...(opts.extraArgs ?? []),
  ];
}

/** Runs the real `kiro` CLI in print mode with streaming JSON output. */
export class KiroCliAdapter implements AgentAdapter {
  readonly id: AgentId = AGENT;
  readonly binary: string;
  readonly defaultModel = "sonnet";

  constructor(binary = "kiro") {
    this.binary = binary;
  }

  run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
    const args = buildKiroExecArgs(opts);
    return runAgentProcess({
      id: this.id,
      binary: this.binary,
      args,
      opts,
      map: createKiroMapper(opts.agentId ?? this.id),
      prompt: opts.prompt,
    });
  }
}
