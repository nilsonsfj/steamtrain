import { z } from "zod";
import type { AgentInstanceId, AgentProviderId } from "../types/events";
import {
  LOOP_MAX_ITERATIONS_CEILING,
  MAX_CONCURRENCY,
  type WorkflowSpec,
  workflowSpecSchema,
} from "../workflow/types";

export interface SteamtrainConfig {
  /** Optional per-agent binary path/name overrides. */
  binaries?: Partial<Record<AgentProviderId, string>>;
  /** Optional runnable agent instances. Omitted means all built-in agents are enabled. */
  agents?: AgentInstanceConfig[];
  /** Per-agent subprocess wall-clock limit in seconds (workspace dispatches and workflow steps). */
  stepTimeoutSec?: number;
  /** Whole-workflow wall-clock abort limit in seconds. Omitted → stepCount × stepTimeoutSec. */
  workflowTimeoutSec?: number;
  /** Project workflows from `steamtrain.json`, keyed by launch name. Merged over bundled and user workflows. */
  workflows?: Record<string, WorkflowSpec>;
  /** Max steps run in parallel within a workflow phase (clamped to MAX_CONCURRENCY). */
  maxConcurrency?: number;
  /** Default per-loop iteration cap; a loop gate's own `maxIterations` overrides it. */
  loopMaxIterations?: number;
}

export interface AgentInstanceConfig {
  /** Instance id referenced by workspaces and workflow steps. */
  id: AgentInstanceId;
  /** Adapter/model provider this instance uses. */
  provider: AgentProviderId;
  /** Defaults to true. Disabled instances are hidden outside config surfaces. */
  enabled?: boolean;
  /** Optional display name for config surfaces. */
  label?: string;
  /** Binary path/name override for this instance. */
  binary?: string;
  /** Env vars merged over process.env for every run on this instance. */
  env?: Record<string, string>;
  /** Extra flags appended to this instance's adapter args for every run. */
  extraArgs?: string[];
  /** Default model used when this instance is selected. */
  defaultModel?: string;
}

const legacyTimeoutFields = {
  stepTimeoutMs: z.number().positive().optional(),
  workflowTimeoutMs: z.number().positive().optional(),
  timeoutMs: z.number().positive().optional(),
};

const nonEmptyString = z
  .string()
  .refine((s) => s.trim().length > 0, "must not be empty or whitespace");
const agentProviderId = z.enum(["claude", "opencode", "codex", "amp"]);
const agentInstanceSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9_.-]+$/, "must contain only letters, numbers, '.', '_', or '-'"),
    provider: agentProviderId,
    enabled: z.boolean().optional(),
    label: nonEmptyString.optional(),
    binary: nonEmptyString.optional(),
    env: z.record(z.string()).optional(),
    extraArgs: z.array(z.string()).optional(),
    defaultModel: nonEmptyString.optional(),
  })
  .strict();

/** Schema for a (partial) steamtrain.json — every section is optional and merged onto defaults. */
export const configFileSchema = z
  .object({
    binaries: z
      .object({
        claude: nonEmptyString.optional(),
        opencode: nonEmptyString.optional(),
        codex: nonEmptyString.optional(),
        amp: nonEmptyString.optional(),
      })
      .partial()
      .optional(),
    agents: z
      .array(agentInstanceSchema)
      .superRefine((agents, ctx) => {
        const seen = new Set<string>();
        for (const [index, agent] of agents.entries()) {
          if (seen.has(agent.id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index, "id"],
              message: `duplicate agent id '${agent.id}'`,
            });
          }
          seen.add(agent.id);
        }
      })
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

/** Validate an agents array from API/CLI input before merging into project config. */
export function parseAgentsConfig(agents: unknown): AgentInstanceConfig[] {
  const parsed = configFileSchema.partial().safeParse({ agents });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const detail = issue
      ? `${issue.path.join(".") || "agents"}: ${issue.message}`
      : "invalid agents";
    throw new Error(detail);
  }
  return parsed.data.agents ?? [];
}
