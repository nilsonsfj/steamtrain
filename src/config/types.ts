import { z } from "zod";
import type { AgentId } from "../types/events";
import { MAX_CONCURRENCY, type WorkflowSpec, workflowSpecSchema } from "../workflow/types";

export interface SteamtrainConfig {
  /** Optional per-agent binary path/name overrides. */
  binaries?: Partial<Record<AgentId, string>>;
  /** Per-run wall-clock timeout in ms (workflows and workspace dispatches). */
  timeoutMs?: number;
  /** Project workflows from `steamtrain.json`, keyed by launch name. Merged over bundled and user workflows. */
  workflows?: Record<string, WorkflowSpec>;
  /** Max steps run in parallel within a workflow phase (clamped to MAX_CONCURRENCY). */
  maxConcurrency?: number;
}

/** Schema for a (partial) steamtrain.json — every section is optional and merged onto defaults. */
export const configFileSchema = z
  .object({
    binaries: z
      .object({
        claude: z.string().optional(),
        opencode: z.string().optional(),
        codex: z.string().optional(),
        amp: z.string().optional(),
      })
      .partial()
      .optional(),
    timeoutMs: z.number().positive().optional(),
    workflows: z.record(workflowSpecSchema).optional(),
    maxConcurrency: z.number().int().positive().max(MAX_CONCURRENCY).optional(),
  })
  .strict();

export type ConfigFile = z.infer<typeof configFileSchema>;
