import { z } from "zod";

/**
 * Zod schemas for Codex's `exec --json` JSONL events.
 *
 * Codex emits typed thread events: `thread.started`, `turn.*`, `item.*`, and
 * `error`. Item payloads use a flat `type` discriminator (`agent_message`,
 * `reasoning`, `command_execution`, ...).
 */

export const codexEnvelope = z.object({ type: z.string() }).passthrough();

export const codexThreadItem = z
  .object({
    id: z.string().optional(),
    type: z.string().optional(),
    text: z.string().optional(),
    command: z.string().optional(),
    aggregated_output: z.string().optional(),
    exit_code: z.number().nullable().optional(),
    status: z.string().optional(),
    server: z.string().optional(),
    tool: z.string().optional(),
    arguments: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z
      .union([z.string(), z.object({ message: z.string().optional() }).passthrough()])
      .optional(),
    message: z.string().optional(),
  })
  .passthrough();

export const codexUsage = z
  .object({
    input_tokens: z.number().optional(),
    cached_input_tokens: z.number().optional(),
    /** Subset of `input_tokens` written to the prompt cache (codex 0.15x+). */
    cache_write_input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    reasoning_output_tokens: z.number().optional(),
  })
  .passthrough();

export const codexEvent = z
  .object({
    type: z.string(),
    thread_id: z.string().optional(),
    model: z.string().optional(),
    tools: z.array(z.string()).optional(),
    item: codexThreadItem.optional(),
    usage: codexUsage.optional(),
    error: z
      .union([z.string(), z.object({ message: z.string().optional() }).passthrough()])
      .optional(),
  })
  .passthrough();

export type CodexThreadItem = z.infer<typeof codexThreadItem>;
export type CodexEvent = z.infer<typeof codexEvent>;
export type CodexUsage = z.infer<typeof codexUsage>;
