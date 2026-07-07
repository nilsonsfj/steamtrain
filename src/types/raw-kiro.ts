import { z } from "zod";

/**
 * Zod schemas for the kiro CLI's `--output-format stream-json` lines.
 *
 * kiro emits a Claude Code-compatible, *message-level* stream JSON format: one
 * JSON object per line, with `system`/`user`/`assistant`/`result` types. It does
 * NOT emit the partial `stream_event` deltas that `claude --include-partial-
 * messages` does, so (like the amp adapter) the kiro mapper surfaces text
 * straight from the full `assistant` message blocks. We therefore reuse Claude's
 * envelope/message/assistant/user schemas and only add the kiro-specific bits:
 *
 *  - `system/init` carries `session_id`, `model`, and `tools`;
 *  - `result` carries an optional `error` string when a turn fails.
 *
 * Schemas stay permissive (`.passthrough()`).
 */

export {
  claudeAssistant as kiroAssistant,
  claudeContentBlock as kiroContentBlock,
  claudeEnvelope as kiroEnvelope,
  claudeMessage as kiroMessage,
  claudeUser as kiroUser,
} from "./raw-claude";

/** `{"type":"system","subtype":"init", session_id, model, tools, ...}` */
export const kiroSystemInit = z
  .object({
    type: z.literal("system"),
    subtype: z.literal("init"),
    session_id: z.string().optional(),
    model: z.string().optional(),
    tools: z.array(z.string()).optional(),
  })
  .passthrough();

/** Anthropic-shaped usage block (Kiro runs on Claude models). */
export const kiroUsage = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
  })
  .passthrough();

/** `{"type":"result","subtype":"success"|"error_during_execution", is_error, error?, result?, usage?, ...}` */
export const kiroResult = z
  .object({
    type: z.literal("result"),
    subtype: z.string().optional(),
    is_error: z.boolean().optional(),
    result: z.string().optional(),
    error: z.string().optional(),
    duration_ms: z.number().optional(),
    total_cost_usd: z.number().optional(),
    usage: kiroUsage.optional(),
  })
  .passthrough();

export type KiroResult = z.infer<typeof kiroResult>;
export type KiroUsage = z.infer<typeof kiroUsage>;
