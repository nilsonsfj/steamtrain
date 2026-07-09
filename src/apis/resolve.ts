import type { SteamtrainConfig } from "../config/types";
import type { ApiProviderId } from "../types/events";
import { llmStepApiId, resolveLlmProvider } from "../workflow/llm";
import type { LlmPricing, LlmStep, WorkflowSpec } from "../workflow/types";
import { workflowLlmSteps } from "../workflow/types";
import { type ResolvedApiInstance, resolveApiInstance } from "./config";

export { llmStepApiId };

/**
 * Resolution of an `llm` step's effective call settings against the configured
 * API instances: the step's `api` reference (or the built-in instance for its
 * explicit/inferred provider) supplies provider, endpoint, key env var,
 * default model, and pricing; the step's own fields override them one by one.
 */

/** The subset of an `llm` step the API resolution reads. */
export type LlmStepApiFields = Pick<
  LlmStep,
  "api" | "provider" | "model" | "apiKeyEnv" | "baseUrl" | "pricing"
>;

export type LlmStepApiResolution =
  | {
      ok: true;
      /** The configured (or built-in) instance the step runs on. */
      api: ResolvedApiInstance;
      provider: ApiProviderId;
      /** Effective model: the step's own, else the instance's `defaultModel`. */
      model: string;
      /** Env var the key is read from: step override, else the instance's. */
      apiKeyEnv: string;
      /** Endpoint override: step's own, else the instance's (unset ⇒ provider env/default). */
      baseUrl?: string;
      /** Effective per-MTok rates: the step's own, else the instance's. */
      pricing?: LlmPricing;
      /** Instance serves free models without a key (e.g. opencode-zen). */
      keyless?: boolean;
    }
  | { ok: false; error: string };

const CONFIGURE_HINT =
  "configure it under 'apis' in steamtrain.json or ~/.steamtrain/config.json (TUI: /apis · web: the config page)";

/** Resolve an `llm` step's effective API settings, or a clear configuration error. */
export function resolveLlmStepApi(
  step: LlmStepApiFields,
  config?: SteamtrainConfig,
): LlmStepApiResolution {
  let api: ResolvedApiInstance | undefined;
  if (step.api) {
    api = resolveApiInstance(config, step.api, { includeDisabled: true });
    if (!api) {
      return {
        ok: false,
        error: `llm step references unknown api '${step.api}' — ${CONFIGURE_HINT}`,
      };
    }
    if (step.provider && step.provider !== api.provider) {
      return {
        ok: false,
        error: `llm step provider '${step.provider}' conflicts with api '${api.id}' (provider '${api.provider}')`,
      };
    }
  } else {
    const provider = resolveLlmProvider(step);
    api = resolveApiInstance(config, provider, { includeDisabled: true });
    if (!api) {
      // Built-ins always resolve; this only guards a future regression.
      return { ok: false, error: `built-in api '${provider}' is not available` };
    }
  }
  if (!api.enabled) {
    return { ok: false, error: `api '${api.id}' is disabled — ${CONFIGURE_HINT}` };
  }

  const model = step.model ?? api.defaultModel;
  if (!model) {
    return {
      ok: false,
      error: `llm step has no model: set 'model' on the step or 'defaultModel' on api '${api.id}'`,
    };
  }

  return {
    ok: true,
    api,
    provider: api.provider,
    model,
    apiKeyEnv: step.apiKeyEnv ?? api.apiKeyEnv,
    baseUrl: step.baseUrl ?? api.baseUrl,
    pricing: step.pricing ?? api.pricing,
    keyless: api.keyless,
  };
}

/**
 * Pre-dispatch readiness of a workflow's `llm` steps: every step must resolve
 * to an enabled instance with a model and have its API key present in the
 * environment. Purely local (no network), so it is safe to run on every
 * dispatch — the API-doctor's endpoint probes stay a status-surface concern.
 * Returns one human-readable issue per problem, deduplicated.
 */
export function workflowLlmApiIssues(
  spec: WorkflowSpec,
  config?: SteamtrainConfig,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const issues = new Set<string>();
  for (const step of workflowLlmSteps(spec)) {
    const resolved = resolveLlmStepApi(step, config);
    if (!resolved.ok) {
      issues.add(`step '${step.id}': ${resolved.error}`);
      continue;
    }
    if (!resolved.keyless && !env[resolved.apiKeyEnv]) {
      issues.add(
        `api '${resolved.api.id}' needs an API key in the ${resolved.apiKeyEnv} environment variable (used by step '${step.id}')`,
      );
    }
  }
  return [...issues];
}
