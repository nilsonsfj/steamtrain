import { z } from "zod";

/**
 * Zod schemas for the amp CLI's `--execute --stream-json` lines.
 *
 * amp emits a Claude Code-compatible, *message-level* stream JSON format: one
 * JSON object per line, with `system`/`user`/`assistant`/`result` types. It does
 * NOT emit the partial `stream_event` deltas that `claude --include-partial-
 * messages` does, so (unlike the Claude adapter) the amp mapper surfaces text
 * straight from the full `assistant` message blocks. We therefore reuse Claude's
 * envelope/message/assistant/user schemas and only add the amp-specific bits:
 *
 *  - `system/init` carries `agent_mode` / `reasoning_effort` instead of `model`;
 *  - `result` carries an `error` string when a turn fails (e.g. "requires paid
 *    credits"), which Claude's result shape does not have.
 *
 * Captured from `amp --execute "…" --stream-json --stream-json-thinking`
 * (amp CLI 0.x). Schemas stay permissive (`.passthrough()`).
 */

export {
  claudeAssistant as ampAssistant,
  claudeContentBlock as ampContentBlock,
  claudeEnvelope as ampEnvelope,
  claudeMessage as ampMessage,
  claudeUser as ampUser,
} from "./raw-claude";

/** `{"type":"system","subtype":"init", session_id, tools, agent_mode, reasoning_effort, ...}` */
export const ampSystemInit = z
  .object({
    type: z.literal("system"),
    subtype: z.literal("init"),
    session_id: z.string().optional(),
    agent_mode: z.string().optional(),
    reasoning_effort: z.string().optional(),
    tools: z.array(z.string()).optional(),
  })
  .passthrough();

/** Anthropic-shaped usage block (Amp runs on Claude models). */
export const ampUsage = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
  })
  .passthrough();

/** `{"type":"result","subtype":"success"|"error_during_execution", is_error, error?, result?, usage?, ...}` */
export const ampResult = z
  .object({
    type: z.literal("result"),
    subtype: z.string().optional(),
    is_error: z.boolean().optional(),
    result: z.string().optional(),
    error: z.string().optional(),
    duration_ms: z.number().optional(),
    total_cost_usd: z.number().optional(),
    usage: ampUsage.optional(),
  })
  .passthrough();

export type AmpResult = z.infer<typeof ampResult>;
export type AmpUsage = z.infer<typeof ampUsage>;
