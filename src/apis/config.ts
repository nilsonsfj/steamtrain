import type { ApiInstanceConfig, SteamtrainConfig } from "../config/types";
import type { ApiInstanceId, ApiProviderId } from "../types/events";
import type { LlmPricing } from "../workflow/types";

/**
 * Resolution of configured LLM API endpoint instances — the direct-inference
 * analog of `src/agents/config.ts`. The two built-in providers (`anthropic`,
 * `openai`) always exist with zero config; `apis` entries in the global or
 * project config customize a built-in (same id) or define new instances
 * (proxies, Groq, Together, Ollama, vLLM, …). `llm` workflow steps reference
 * an instance via their `api` field, and the doctor/status surfaces report
 * each enabled instance's readiness alongside agent health.
 */

export const API_PROVIDER_IDS: readonly ApiProviderId[] = ["anthropic", "openai"];

/** The built-in zero-config instance ids (one per provider), mirroring `AGENT_IDS`. */
export const API_IDS = API_PROVIDER_IDS;

export function isApiProviderId(value: string): value is ApiProviderId {
  return (API_PROVIDER_IDS as readonly string[]).includes(value);
}

/** Conventional env var each provider's key is read from. */
export const DEFAULT_API_KEY_ENV: Record<ApiProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

export interface ResolvedApiInstance {
  id: ApiInstanceId;
  provider: ApiProviderId;
  label: string;
  enabled: boolean;
  /** Configured endpoint override; unset means the provider env/default resolves at call time. */
  baseUrl?: string;
  /** Env var the API key is read from (config override, else the provider convention). */
  apiKeyEnv: string;
  /** Model used when a step referencing this instance omits `model`. */
  defaultModel?: string;
  /** Default per-MTok rates for steps on this instance without their own `pricing`. */
  pricing?: LlmPricing;
  /** True when an `apis` config entry defines/overrides this instance. */
  configured: boolean;
}

export interface ResolveApiOptions {
  includeDisabled?: boolean;
}

export function defaultApiInstance(provider: ApiProviderId): ResolvedApiInstance {
  return {
    id: provider,
    provider,
    label: provider,
    enabled: true,
    apiKeyEnv: DEFAULT_API_KEY_ENV[provider],
    configured: false,
  };
}

function applyApiConfig(
  base: ResolvedApiInstance,
  override: ApiInstanceConfig,
): ResolvedApiInstance {
  return {
    ...base,
    provider: override.provider,
    label: override.label ?? base.label,
    enabled: override.enabled ?? base.enabled,
    baseUrl: override.baseUrl,
    apiKeyEnv: override.apiKeyEnv ?? DEFAULT_API_KEY_ENV[override.provider],
    defaultModel: override.defaultModel,
    pricing: override.pricing,
    configured: true,
  };
}

/**
 * All API instances visible to pickers, health checks, and `llm` steps:
 * the built-in providers plus/overlaid-with configured `apis` entries, in a
 * stable order (built-ins first, then configured additions in file order).
 */
export function resolveApiInstances(
  config?: SteamtrainConfig,
  options: ResolveApiOptions = {},
): ResolvedApiInstance[] {
  const byId = new Map<ApiInstanceId, ResolvedApiInstance>();
  for (const provider of API_PROVIDER_IDS) byId.set(provider, defaultApiInstance(provider));

  for (const item of config?.apis ?? []) {
    const base = byId.get(item.id) ?? {
      ...defaultApiInstance(item.provider),
      id: item.id,
      label: item.id,
    };
    byId.set(item.id, applyApiConfig(base, item));
  }

  const all = [...byId.values()];
  return options.includeDisabled ? all : all.filter((api) => api.enabled);
}

export function resolveApiInstance(
  config: SteamtrainConfig | undefined,
  id: ApiInstanceId,
  options: ResolveApiOptions = {},
): ResolvedApiInstance | undefined {
  return resolveApiInstances(config, options).find((api) => api.id === id);
}
