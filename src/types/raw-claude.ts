import { z } from "zod";

/**
 * Zod schemas for Claude Code's `--output-format stream-json` lines.
 *
 * These are intentionally permissive (`.passthrough()`): we validate only the
 * fields we read and let everything else flow through untouched. Lines whose
 * `type` we don't recognize become passthrough `unknown` events at the mapper.
 *
 * Shapes were captured from a real `claude --print --output-format stream-json
 * --verbose --include-partial-messages --model haiku` run (Claude Code 2.1.x).
 */

/** Minimal envelope — every line has a string `type`. */
export const claudeEnvelope = z.object({ type: z.string() }).passthrough();

/** `{"type":"system","subtype":"init", session_id, model, tools, ...}` */
export const claudeSystemInit = z
  .object({
    type: z.literal("system"),
    subtype: z.literal("init"),
    session_id: z.string().optional(),
    model: z.string().optional(),
    tools: z.array(z.string()).optional(),
  })
  .passthrough();

/** A content block inside an assistant/user message. */
export const claudeContentBlock = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    thinking: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    input: z.unknown().optional(),
    tool_use_id: z.string().optional(),
    content: z.unknown().optional(),
    is_error: z.boolean().optional(),
  })
  .passthrough();

/** Anthropic usage block, as reported on Claude Code's `result` (and message) events. */
export const claudeUsage = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
  })
  .passthrough();

export const claudeMessage = z
  .object({
    id: z.string().optional(),
    role: z.string().optional(),
    content: z.array(claudeContentBlock).optional(),
    /**
     * Per-message usage. Claude Code reports it on every `assistant` line, so
     * it is the mid-turn source a live spend readout needs — the `result`
     * line's copy only lands once the whole turn is over.
     */
    usage: claudeUsage.optional(),
  })
  .passthrough();

/** `{"type":"assistant","message":{...}, error?, ...}` */
export const claudeAssistant = z
  .object({
    type: z.literal("assistant"),
    message: claudeMessage,
    error: z.string().optional(),
  })
  .passthrough();

/** `{"type":"user","message":{content:[{type:"tool_result",...}]}}` */
export const claudeUser = z
  .object({
    type: z.literal("user"),
    message: claudeMessage,
  })
  .passthrough();

/** Anthropic SSE event wrapped by `--include-partial-messages`. */
export const claudeStreamEvent = z
  .object({
    type: z.literal("stream_event"),
    event: z
      .object({
        type: z.string(),
        index: z.number().optional(),
        delta: z
          .object({
            type: z.string().optional(),
            text: z.string().optional(),
            thinking: z.string().optional(),
          })
          .passthrough()
          .optional(),
        content_block: z.object({ type: z.string().optional() }).passthrough().optional(),
      })
      .passthrough(),
  })
  .passthrough();

/** `{"type":"result","subtype":"success","is_error":false, result, duration_ms, total_cost_usd, usage, ...}` */
export const claudeResult = z
  .object({
    type: z.literal("result"),
    subtype: z.string().optional(),
    is_error: z.boolean().optional(),
    result: z.string().optional(),
    duration_ms: z.number().optional(),
    total_cost_usd: z.number().optional(),
    usage: claudeUsage.optional(),
  })
  .passthrough();

export type ClaudeContentBlock = z.infer<typeof claudeContentBlock>;
export type ClaudeAssistant = z.infer<typeof claudeAssistant>;
export type ClaudeResult = z.infer<typeof claudeResult>;
export type ClaudeUsage = z.infer<typeof claudeUsage>;
