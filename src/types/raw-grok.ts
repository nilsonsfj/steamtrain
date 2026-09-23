import { z } from "zod";

/** Loose envelope for Grok Build `--output-format streaming-json` lines. */
export const grokEnvelope = z.object({ type: z.string() }).passthrough();

export const grokUsage = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    reasoning_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
  })
  .passthrough();

export const grokText = z
  .object({
    type: z.enum(["text", "thought"]),
    data: z.string().optional(),
  })
  .passthrough();

export const grokToolCall = z
  .object({
    type: z.literal("tool_call"),
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
    title: z.string().optional(),
    kind: z.string().optional(),
    status: z.string().optional(),
    rawInput: z.unknown().optional(),
    rawOutput: z.unknown().optional(),
    content: z.unknown().optional(),
  })
  .passthrough();

export const grokToolUpdate = z
  .object({
    type: z.literal("tool_call_update"),
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
    title: z.string().optional(),
    status: z.string().optional(),
    rawOutput: z.unknown().optional(),
    content: z.unknown().optional(),
  })
  .passthrough();

export const grokUsageLine = z
  .object({
    type: z.literal("usage"),
    usage: grokUsage.optional(),
  })
  .passthrough();

const grokSpend = {
  usage: grokUsage.optional(),
  total_cost_usd: z.number().optional(),
  cost_is_partial: z.boolean().optional(),
  usage_is_incomplete: z.boolean().optional(),
};

export const grokEnd = z
  .object({
    type: z.literal("end"),
    stopReason: z.string().optional(),
    sessionId: z.string().optional(),
    text: z.string().optional(),
    data: z.string().optional(),
    ...grokSpend,
  })
  .passthrough();

export const grokError = z
  .object({
    type: z.literal("error"),
    message: z.string().optional(),
    sessionId: z.string().optional(),
    ...grokSpend,
  })
  .passthrough();

export type GrokUsage = z.infer<typeof grokUsage>;
export type GrokEnd = z.infer<typeof grokEnd>;
export type GrokError = z.infer<typeof grokError>;
