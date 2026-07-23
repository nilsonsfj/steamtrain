import { z } from "zod";

/**
 * Zod schemas for Kimi Code's `-p <prompt> --output-format stream-json` lines.
 *
 * Intentionally permissive (`.passthrough()`): we validate only the fields we
 * read and let everything else flow through. Lines whose `role` (or meta
 * `type`) we don't recognize become passthrough `unknown` events at the mapper.
 *
 * Shapes were captured from a real `kimi -p … --output-format stream-json` run
 * (Kimi Code CLI 0.29.x):
 *   {"role":"assistant","content":"…"}                        assistant message (whole, not a delta)
 *   {"role":"assistant","tool_calls":[…]}                     tool invocation
 *   {"role":"tool","tool_call_id":"…","content":"…"}          tool result
 *   {"role":"meta","type":"session.resume_hint","session_id":…}  session id carrier
 */

/** Minimal envelope — every line has a string `role`. */
export const kimiEnvelope = z.object({ role: z.string() }).passthrough();

/** One OpenAI-style function call inside an assistant message. */
export const kimiToolCall = z
  .object({
    type: z.string().optional(),
    id: z.string().optional(),
    function: z
      .object({
        name: z.string().optional(),
        /** JSON-encoded argument string (not a parsed object). */
        arguments: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** Any stream-json line (discriminated on `role` at the mapper). */
export const kimiMessage = z
  .object({
    role: z.string(),
    content: z.unknown().optional(),
    tool_calls: z.array(kimiToolCall).optional(),
    tool_call_id: z.string().optional(),
    type: z.string().optional(),
    session_id: z.string().optional(),
  })
  .passthrough();

export type KimiMessage = z.infer<typeof kimiMessage>;
