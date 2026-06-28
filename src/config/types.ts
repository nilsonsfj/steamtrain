import { z } from "zod";
import type { AgentId } from "../types/events";
import {
  LOOP_MAX_ITERATIONS_CEILING,
  MAX_CONCURRENCY,
  type WorkflowSpec,
  workflowSpecSchema,
} from "../workflow/types";

export interface SteamtrainConfig {
  /** Optional per-agent binary path/name overrides. */
  binaries?: Partial<Record<AgentId, string>>;
  /** Per-agent subprocess wall-clock limit in seconds (workspace dispatches and workflow steps). */
  stepTimeoutSec?: number;
  /** Whole-workflow wall-clock abort limit in seconds. Omitted → stepCount × stepTimeoutSec. */
  workflowTimeoutSec?: number;
  /**
   * @deprecated Legacy millisecond timeout from older configs. Converted to seconds at load;
   * not written back on save.
   */
  timeoutMs?: number;
  /** Project workflows from `steamtrain.json`, keyed by launch name. Merged over bundled and user workflows. */
  workflows?: Record<string, WorkflowSpec>;
  /** Max steps run in parallel within a workflow phase (clamped to MAX_CONCURRENCY). */
  maxConcurrency?: number;
  /** Default per-loop iteration cap; a loop gate's own `maxIterations` overrides it. */
  loopMaxIterations?: number;
}

const legacyTimeoutFields = {
  stepTimeoutMs: z.number().positive().optional(),
  workflowTimeoutMs: z.number().positive().optional(),
  timeoutMs: z.number().positive().optional(),
};

/** Schema for a (partial) steamtrain.json — every section is optional and merged onto defaults. */
export const configFileSchema = z
  .object({
    binaries: z
      .object({
        claude: z
          .string()
          .refine((s) => s.trim().length > 0, "must not be empty or whitespace")
          .optional(),
        opencode: z
          .string()
          .refine((s) => s.trim().length > 0, "must not be empty or whitespace")
          .optional(),
        codex: z
          .string()
          .refine((s) => s.trim().length > 0, "must not be empty or whitespace")
          .optional(),
        amp: z
          .string()
          .refine((s) => s.trim().length > 0, "must not be empty or whitespace")
          .optional(),
      })
      .partial()
      .optional(),
    stepTimeoutSec: z.number().positive().optional(),
    workflowTimeoutSec: z.number().positive().optional(),
    ...legacyTimeoutFields,
    workflows: z.record(workflowSpecSchema).optional(),
    maxConcurrency: z.number().int().positive().max(MAX_CONCURRENCY).optional(),
    loopMaxIterations: z.number().int().min(1).max(LOOP_MAX_ITERATIONS_CEILING).optional(),
  })
  .strict();

export type ConfigFile = z.infer<typeof configFileSchema>;
