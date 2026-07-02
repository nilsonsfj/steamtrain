import type {
  AgentEvent,
  AgentId,
  AgentInstanceId,
  EventMapper,
  TokenUsage,
} from "../types/events";
import {
  type AmpUsage,
  ampAssistant,
  ampEnvelope,
  ampResult,
  ampSystemInit,
  ampUser,
} from "../types/raw-amp";
import { type AgentAdapter, type AgentRunOptions, runAgentProcess } from "./adapter";
import type { AgentModel } from "./agent-model";
import { humanizeAssistantError, stringifyContent } from "./util";

const AGENT: AgentId = "amp";

/**
 * amp selects its model via an agent *mode* (`-m`), not a model id. Each mode
 * picks the model, system prompt and tool selection; "smart" is amp's default.
 * See https://ampcode.com/manual#modes.
 */
export const AMP_MODELS: readonly AgentModel[] = [
  { id: "smart", name: "Smart (state-of-the-art)" },
  { id: "deep", name: "Deep (extended reasoning)" },
  { id: "rush", name: "Rush (fast, low-token)" },
];

/**
 * Build a mapper for one amp run.
 *
 * amp emits a Claude Code-compatible **message-level** stream JSON format — it
 * does NOT stream partial `stream_event` deltas — so, unlike the Claude mapper,
 * this one surfaces text directly from the full `assistant` message blocks:
 *
 *  - `system/init`            → session_start (model = the active agent mode)
 *  - `assistant` text/think   → text_delta (the message is the only text we get)
 *  - `assistant` tool_use     → tool_use
 *  - `assistant.error`        → error
 *  - `user` tool_result       → tool_result
 *  - `result`                 → result; plus an `error` event when the turn
 *                               failed with a message (e.g. "requires paid
 *                               credits") so it surfaces and retry sees it
 *  - anything else            → unknown passthrough
 *
 * Stateless across lines, so it is also a pure function over each raw line.
 */
export function createAmpMapper(agent: AgentInstanceId = AGENT): EventMapper {
  return (raw: unknown): AgentEvent[] => {
    const ts = Date.now();
    const env = ampEnvelope.safeParse(raw);
    if (!env.success) return [{ kind: "unknown", agent, ts, raw }];

    switch (env.data.type) {
      case "system": {
        const init = ampSystemInit.safeParse(raw);
        if (init.success) {
          return [
            {
              kind: "session_start",
              agent,
              ts,
              sessionId: init.data.session_id,
              model: init.data.agent_mode,
              tools: init.data.tools,
            },
          ];
        }
        // system/status and other system subtypes — not surfaced.
        return [];
      }

      case "assistant": {
        const parsed = ampAssistant.safeParse(raw);
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
        const parsed = ampUser.safeParse(raw);
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
        const r = ampResult.safeParse(raw);
        if (!r.success) return [{ kind: "unknown", agent, ts, rawType: "result", raw }];
        const out: AgentEvent[] = [];
        // A failed turn carries a human message in `error` (e.g. no credits).
        // Emit it as an error so it surfaces and retry treats the run as failed.
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
          tokens: ampTokens(r.data.usage),
        });
        return out;
      }

      default:
        return [{ kind: "unknown", agent, ts, rawType: env.data.type, raw }];
    }
  };
}

/** Map Amp's Anthropic-shaped usage onto the normalized {@link TokenUsage}. */
function ampTokens(usage: AmpUsage | undefined): TokenUsage | undefined {
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
 * Build the `amp` argv for one execute-mode run.
 *
 * amp requires the prompt to be the *value* of `-x`/`--execute`; a trailing
 * positional after other flags is rejected. `--stream-json-thinking` implies
 * `--stream-json` and additionally surfaces reasoning blocks. `--effort` is
 * dropped for the `rush` mode, which has no reasoning and rejects the flag.
 */
export function buildAmpExecArgs(opts: AgentRunOptions): string[] {
  const wantsEffort = Boolean(opts.effort) && opts.model !== "rush";
  return [
    "-x",
    "",
    "--stream-json",
    "--stream-json-thinking",
    "-m",
    opts.model,
    ...(wantsEffort ? ["--effort", opts.effort as string] : []),
    ...(opts.extraArgs ?? []),
  ];
}

/** Runs the real `amp` CLI in execute mode with streaming JSON output. */
export class AmpAdapter implements AgentAdapter {
  readonly id: AgentId = AGENT;
  readonly binary: string;

  constructor(binary = "amp") {
    this.binary = binary;
  }

  run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
    const args = buildAmpExecArgs(opts);
    return runAgentProcess({
      id: this.id,
      binary: this.binary,
      args,
      opts,
      map: createAmpMapper(opts.agentId ?? this.id),
      prompt: opts.prompt,
    });
  }
}
