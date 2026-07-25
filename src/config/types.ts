import { z } from "zod";
import type { PermissionsSpec } from "../agents/permissions";
import type {
  AgentInstanceId,
  AgentProviderId,
  ApiInstanceId,
  ApiProviderId,
} from "../types/events";
import type { ModelFailoverPolicy } from "../workflow/model-failover";
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
  /**
   * Optional display name for this project. Shown in the TUI status bar and
   * web header. When omitted, steamtrain falls back to package.json `name`,
   * then the directory basename.
   */
  name?: string;
  /** Optional per-agent binary path/name overrides. */
  binaries?: Partial<Record<AgentProviderId, string>>;
  /** Optional runnable agent instances. Omitted means all built-in agents are enabled. */
  agents?: AgentInstanceConfig[];
  /** Optional LLM API endpoint instances for `llm` steps. Omitted means the built-in providers are enabled. */
  apis?: ApiInstanceConfig[];
  /**
   * Optional overrides for built-in model classes (`thinker`, `ultrathinker`,
   * `implementer`, `reviewer`, `deep-reviewer`, `simple`, `balanced`).
   * Workflows may pin `modelClass` instead of a concrete model; resolution
   * walks each class's preferred family list.
   */
  modelClasses?: ModelClassesConfig;
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
  /**
   * Default mid-flight model failover policy for agent steps. Workflow and
   * per-step `modelFailover` override this. When an agent hits quota /
   * rate-limit / transient failures, steamtrain walks `fallbackModels` (and
   * same-family remaps) so the run is not ruined by a single provider's
   * budget. See `docs/model-binding.md`.
   */
  modelFailover?: ModelFailoverPolicy;
  /**
   * Project/user-wide default tool permissions for every agent-backed workflow
   * step (`"read-only"` | `"edit"` | `"full"`, or the object form). It is the
   * LAST layer: a step's own `permissions` wins, then the workflow's. Setting
   * `"read-only"` here is the strongest statement a repository can make — every
   * agent step in every workflow becomes read-only until it says otherwise, so
   * a workflow that was never audited cannot quietly rewrite the checkout. See
   * `docs/permissions.md`.
   */
  permissions?: PermissionsSpec;
}

/** Per-class override for {@link SteamtrainConfig.modelClasses}. */
export interface ModelClassConfigOverride {
  /** Replace the preferred family id list for this class. */
  preferred?: string[];
  /** Replace preferred effort ladder for this class. */
  preferredEfforts?: string[];
  /** Optional display name override. */
  name?: string;
  /** Optional description override. */
  description?: string;
}

/** Config-layer overrides for built-in model classes. */
export type ModelClassesConfig = Partial<
  Record<
    | "thinker"
    | "ultrathinker"
    | "implementer"
    | "reviewer"
    | "deep-reviewer"
    | "simple"
    | "balanced",
    ModelClassConfigOverride
  >
>;

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
  "mimo",
  "kimi",
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

const modelClassOverrideSchema = z
  .object({
    preferred: z.array(z.string().min(1)).min(1).optional(),
    preferredEfforts: z.array(z.string().min(1)).min(1).optional(),
    name: nonEmptyString.optional(),
    description: nonEmptyString.optional(),
  })
  .strict();

const modelClassesSchema = z
  .object({
    thinker: modelClassOverrideSchema.optional(),
    ultrathinker: modelClassOverrideSchema.optional(),
    implementer: modelClassOverrideSchema.optional(),
    reviewer: modelClassOverrideSchema.optional(),
    "deep-reviewer": modelClassOverrideSchema.optional(),
    simple: modelClassOverrideSchema.optional(),
    balanced: modelClassOverrideSchema.optional(),
  })
  .strict()
  .optional();

/** Schema for a (partial) steamtrain.json — every section is optional and merged onto defaults. */
export const configFileSchema = z
  .object({
    name: z
      .string()
      .max(80)
      .refine((s) => s.trim().length > 0, "must not be empty or whitespace")
      .optional(),
    binaries: z
      .object({
        claude: nonEmptyString.optional(),
        opencode: nonEmptyString.optional(),
        codex: nonEmptyString.optional(),
        amp: nonEmptyString.optional(),
        kiro: nonEmptyString.optional(),
        mimo: nonEmptyString.optional(),
        kimi: nonEmptyString.optional(),
        cursor: nonEmptyString.optional(),
        antigravity: nonEmptyString.optional(),
      })
      .partial()
      .optional(),
    agents: z.array(agentInstanceSchema).superRefine(uniqueIds("agent")).optional(),
    apis: z.array(apiInstanceSchema).superRefine(uniqueIds("api")).optional(),
    modelClasses: modelClassesSchema,
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
        webhookFormat: z.enum(["raw", "slack", "discord", "teams"]).optional(),
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
    modelFailover: z
      .object({
        enabled: z.boolean().optional(),
        on: z
          .array(z.enum(["quota", "rate_limit", "transient", "auth", "any"]))
          .min(1)
          .optional(),
        onCapacityResult: z.boolean().optional(),
        allowAfterToolUse: z.boolean().optional(),
        preferNextModel: z.boolean().optional(),
        failoverDelayMs: z.number().int().min(0).max(60000).optional(),
      })
      .strict()
      .optional(),
    permissions: z
      .union([
        z.enum(["read-only", "edit", "full"]),
        z
          .object({
            profile: z.enum(["read-only", "edit", "full"]),
            allow: z.array(z.string().min(1)).min(1).optional(),
            deny: z.array(z.string().min(1)).min(1).optional(),
            onUnsupported: z.enum(["fail", "warn"]).optional(),
            verify: z.boolean().optional(),
          })
          .strict(),
      ])
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
  name: true,
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
