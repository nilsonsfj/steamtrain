import { z } from "zod";

/**
 * Zod schemas for OpenCode's `run --format json` JSONL events.
 *
 * OpenCode emits flat top-level events: `{ type, sessionID, timestamp, part?,
 * error? }`. Tool and text activity arrives inside a nested `part` object; some
 * builds nest it under `properties.part`, so we accept both. As with Claude, the
 * schemas are permissive and unknown `type`s pass through as `unknown` events.
 *
 * The `error` shape was captured from a real `opencode run --format json` run
 * (opencode 1.15.x): `{"type":"error","sessionID":"ses_...","error":{"name":
 * "UnknownError","data":{"message":"...","ref":"..."}}}`.
 */

export const opencodeEnvelope = z.object({ type: z.string() }).passthrough();

/** `part.state` for tool parts: status drives tool_use vs tool_result. */
export const opencodeToolState = z
  .object({
    status: z.string().optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    metadata: z.unknown().optional(),
    error: z.unknown().optional(),
    title: z.string().optional(),
  })
  .passthrough();

/** A message part: text/reasoning carry `text`; tool parts carry `tool`+`state`. */
export const opencodePart = z
  .object({
    id: z.string().optional(),
    sessionID: z.string().optional(),
    messageID: z.string().optional(),
    type: z.string().optional(),
    text: z.string().optional(),
    tool: z.string().optional(),
    callID: z.string().optional(),
    state: opencodeToolState.optional(),
  })
  .passthrough();

export const opencodeError = z
  .object({
    name: z.string().optional(),
    message: z.string().optional(),
    data: z
      .object({ message: z.string().optional(), ref: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** OpenCode's per-step token block: `{ input, output, reasoning, cache: { read, write } }`. */
export const opencodeTokens = z
  .object({
    input: z.number().optional(),
    output: z.number().optional(),
    reasoning: z.number().optional(),
    cache: z
      .object({ read: z.number().optional(), write: z.number().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const opencodeEvent = z
  .object({
    type: z.string(),
    sessionID: z.string().optional(),
    timestamp: z.number().optional(),
    part: opencodePart.optional(),
    properties: z.object({ part: opencodePart.optional() }).passthrough().optional(),
    error: opencodeError.optional(),
    cost: z.number().optional(),
    tokens: opencodeTokens.optional(),
  })
  .passthrough();

export type OpenCodePart = z.infer<typeof opencodePart>;
export type OpenCodeEvent = z.infer<typeof opencodeEvent>;
export type OpenCodeTokens = z.infer<typeof opencodeTokens>;
