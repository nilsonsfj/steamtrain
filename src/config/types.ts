import { z } from "zod";
import type {
  AgentInstanceId,
  AgentProviderId,
  ApiInstanceId,
  ApiProviderId,
} from "../types/events";
import type { NotifyConfig } from "../workflow/notify";
import {
  LOOP_MAX_ITERATIONS_CEILING,
  type LlmPricing,
  MAX_CONCURRENCY,
  MAX_PARALLEL_RUNS_CEILING,
  type WorkflowSpec,
  llmPricingSchema,
  workflowSpecSchema,
} from "../workflow/types";

export interface SteamtrainConfig {
  /** Optional per-agent binary path/name overrides. */
  binaries?: Partial<Record<AgentProviderId, string>>;
  /** Optional runnable agent instances. Omitted means all built-in agents are enabled. */
  agents?: AgentInstanceConfig[];
  /** Optional LLM API endpoint instances for `llm` steps. Omitted means the built-in providers are enabled. */
  apis?: ApiInstanceConfig[];
  /** Per-agent subprocess wall-clock limit in seconds (workspace dispatches and workflow steps). */
  stepTimeoutSec?: number;
  /** Whole-workflow wall-clock abort limit in seconds. Omitted → stepCount × stepTimeoutSec. */
  workflowTimeoutSec?: number;
  /** Project workflows from `steamtrain.json`, keyed by launch name. Merged over bundled and user workflows. */
  workflows?: Record<string, WorkflowSpec>;
  /** Max steps run in parallel within a workflow phase (clamped to MAX_CONCURRENCY). */
  maxConcurrency?: number;
  /** Max workflow runs executing at once (whole runs, across processes); excess runs queue. */
  maxParallelRuns?: number;
  /** Default per-loop iteration cap; a loop gate's own `maxIterations` overrides it. */
  loopMaxIterations?: number;
  /**
   * Run notifications: terminal bell / OS desktop notification / webhook,
   * fired on run completion, failure, budget-exceeded, and human-in-the-loop
   * waits (approval-pending, input-pending). See `src/workflow/notify.ts`.
   */
  notify?: NotifyConfig;
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

/**
 * A configured LLM API endpoint instance — the direct-inference analog of an
 * {@link AgentInstanceConfig}. `llm` workflow steps reference an instance by
 * `api: <id>` and inherit its provider, endpoint, key env var, default model,
 * and pricing; a step's own fields override them individually. The built-in
 * `anthropic` and `openai` instances exist with zero config; adding an entry
 * with one of those ids customizes the built-in, any other id defines a new
 * instance (a proxy, Groq, Together, Ollama, vLLM, …).
 */
export interface ApiInstanceConfig {
  /** Instance id referenced by `llm` workflow steps via their `api` field. */
  id: ApiInstanceId;
  /** API dialect this instance speaks. */
  provider: ApiProviderId;
  /** Defaults to true. Disabled instances are hidden outside config surfaces and refuse runs. */
  enabled?: boolean;
  /** Optional display name for config surfaces. */
  label?: string;
  /** Endpoint base URL override (OpenAI convention: include `/v1`). */
  baseUrl?: string;
  /** Env var holding the API key. Defaults to `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` by provider. */
  apiKeyEnv?: string;
  /** Endpoint serves models without a key (local server, opencode-zen free tier); a key is used if present. */
  keyless?: boolean;
  /** Model used when a step referencing this instance omits `model`. */
  defaultModel?: string;
  /**
   * Default per-MTok USD rates for steps on this instance that don't declare
   * their own `pricing` — most useful when the instance fronts one model
   * family (a proxy, a local server) with uniform billing.
   */
  pricing?: LlmPricing;
}

const legacyTimeoutFields = {
  stepTimeoutMs: z.number().positive().optional(),
  workflowTimeoutMs: z.number().positive().optional(),
  timeoutMs: z.number().positive().optional(),
};

const nonEmptyString = z
  .string()
  .refine((s) => s.trim().length > 0, "must not be empty or whitespace");
const agentProviderId = z.enum([
  "claude",
  "opencode",
  "codex",
  "amp",
  "kiro",
  "cursor",
  "antigravity",
]);
const apiProviderId = z.enum(["anthropic", "openai"]);
const instanceIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_.-]+$/, "must contain only letters, numbers, '.', '_', or '-'");
const apiInstanceSchema = z
  .object({
    id: instanceIdSchema,
    provider: apiProviderId,
    enabled: z.boolean().optional(),
    label: nonEmptyString.optional(),
    // baseUrl / apiKeyEnv stay loosely typed at load so a single bad entry
    // cannot discard the whole config file; interactive add paths validate
    // via isAllowedApiBaseUrl / isValidApiKeyEnvName.
    baseUrl: nonEmptyString.optional(),
    apiKeyEnv: nonEmptyString.optional(),
    keyless: z.boolean().optional(),
    defaultModel: nonEmptyString.optional(),
    pricing: llmPricingSchema.optional(),
  })
  .strict();

/** Reject duplicate `id`s inside one config file's instance list. */
function uniqueIds(kind: "agent" | "api") {
  return (items: readonly { id: string }[], ctx: z.RefinementCtx): void => {
    const seen = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (seen.has(item.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "id"],
          message: `duplicate ${kind} id '${item.id}'`,
        });
      }
      seen.add(item.id);
    }
  };
}
const agentInstanceSchema = z
  .object({
    id: instanceIdSchema,
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
        kiro: nonEmptyString.optional(),
        cursor: nonEmptyString.optional(),
        antigravity: nonEmptyString.optional(),
      })
      .partial()
      .optional(),
    agents: z.array(agentInstanceSchema).superRefine(uniqueIds("agent")).optional(),
    apis: z.array(apiInstanceSchema).superRefine(uniqueIds("api")).optional(),
    stepTimeoutSec: z.number().positive().optional(),
    workflowTimeoutSec: z.number().positive().optional(),
    ...legacyTimeoutFields,
    workflows: z.record(workflowSpecSchema).optional(),
    maxConcurrency: z.number().int().positive().max(MAX_CONCURRENCY).optional(),
    maxParallelRuns: z.number().int().min(1).max(MAX_PARALLEL_RUNS_CEILING).optional(),
    loopMaxIterations: z.number().int().min(1).max(LOOP_MAX_ITERATIONS_CEILING).optional(),
    notify: z
      .object({
        bell: z.boolean().optional(),
        desktop: z.boolean().optional(),
        webhook: z.string().url().optional(),
        events: z
          .array(
            z.enum([
              "run-completed",
              "run-failed",
              "budget-exceeded",
              "approval-pending",
              "input-pending",
            ]),
          )
          .min(1)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ConfigFile = z.infer<typeof configFileSchema>;

/**
 * Schema for the global `~/.steamtrain/config.json` — same shape as the project
 * file minus `workflows` (user workflows already live in `~/.steamtrain/workflows.json`)
 * and the legacy timeout keys (which predate the global file).
 */
export const userConfigFileSchema = configFileSchema.omit({
  workflows: true,
  timeoutMs: true,
  stepTimeoutMs: true,
  workflowTimeoutMs: true,
});

export type UserConfigFile = z.infer<typeof userConfigFileSchema>;

/** Which config file an agent instance entry is written in. */
export type AgentConfigScope = "user" | "project";

/** Which config file an API instance entry is written in (same scopes as agents). */
export type ApiConfigScope = AgentConfigScope;

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

/** Validate an apis array from API/CLI input before merging into project config. */
export function parseApisConfig(apis: unknown): ApiInstanceConfig[] {
  const parsed = configFileSchema.partial().safeParse({ apis });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const detail = issue ? `${issue.path.join(".") || "apis"}: ${issue.message}` : "invalid apis";
    throw new Error(detail);
  }
  return parsed.data.apis ?? [];
}
