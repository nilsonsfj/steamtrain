import { z } from "zod";

/**
 * Zod schemas for the Cursor Agent CLI's `--output-format stream-json` lines.
 *
 * Permissive (`.passthrough()`): validate only fields the mapper reads. Unrecognized
 * `type` values become passthrough `unknown` events at the mapper.
 */

/** Minimal envelope — every line has a string `type`. */
export const cursorEnvelope = z.object({ type: z.string() }).passthrough();

/** `{"type":"system","subtype":"init", session_id, model, tools, ...}` */
export const cursorSystemInit = z
  .object({
    type: z.literal("system"),
    subtype: z.literal("init"),
    session_id: z.string().optional(),
    model: z.string().optional(),
    tools: z.array(z.string()).optional(),
  })
  .passthrough();

export const cursorContentBlock = z
  .object({
    type: z.string(),
    text: z.string().optional(),
  })
  .passthrough();

export const cursorMessage = z
  .object({
    role: z.string().optional(),
    content: z.array(cursorContentBlock).optional(),
  })
  .passthrough();

/** `{"type":"assistant", timestamp_ms?, model_call_id?, message, ...}` */
export const cursorAssistant = z
  .object({
    type: z.literal("assistant"),
    timestamp_ms: z.number().optional(),
    model_call_id: z.string().optional(),
    message: cursorMessage,
  })
  .passthrough();

export const cursorFunctionTool = z
  .object({
    name: z.string().optional(),
    arguments: z.string().optional(),
    result: z.unknown().optional(),
  })
  .passthrough();

export const cursorToolCallPayload = z
  .object({
    readToolCall: z
      .object({ args: z.unknown().optional(), result: z.unknown().optional() })
      .passthrough()
      .optional(),
    writeToolCall: z
      .object({ args: z.unknown().optional(), result: z.unknown().optional() })
      .passthrough()
      .optional(),
    function: cursorFunctionTool.optional(),
  })
  .passthrough();

/** `{"type":"tool_call", subtype, call_id, tool_call, ...}` */
export const cursorToolCall = z
  .object({
    type: z.literal("tool_call"),
    subtype: z.string().optional(),
    call_id: z.string().optional(),
    tool_call: cursorToolCallPayload.optional(),
  })
  .passthrough();

/**
 * The `result` line's `usage`. Cursor Agent CLI (2026.07.x) writes it in
 * camelCase — `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`
 * — with `inputTokens` already net of cache reads and writes (it subtracts them
 * before printing). The snake_case Anthropic-style names are kept for older
 * builds and hand-written fixtures.
 */
export const cursorUsage = z
  .object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    cacheReadTokens: z.number().optional(),
    cacheWriteTokens: z.number().optional(),
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
  })
  .passthrough();

/** `{"type":"result", subtype?, is_error?, result?, error?, duration_ms?, usage?, ...}` */
export const cursorResult = z
  .object({
    type: z.literal("result"),
    subtype: z.string().optional(),
    is_error: z.boolean().optional(),
    result: z.string().optional(),
    error: z.string().optional(),
    duration_ms: z.number().optional(),
    total_cost_usd: z.number().optional(),
    usage: cursorUsage.optional(),
  })
  .passthrough();

export type CursorToolCallPayload = z.infer<typeof cursorToolCallPayload>;
export type CursorResult = z.infer<typeof cursorResult>;
export type CursorUsage = z.infer<typeof cursorUsage>;
