import type { ApiInstanceConfig, SteamtrainConfig } from "../config/types";
import type { ApiInstanceId, ApiProviderId } from "../types/events";
import type { LlmPricing } from "../workflow/types";

/**
 * Resolution of configured LLM API endpoint instances — the direct-inference
 * analog of `src/agents/config.ts`. A handful of built-in instances always
 * exist with zero config: the raw `anthropic`/`openai` providers plus popular
 * OpenAI-compatible gateways (`openrouter`, `opencode-zen`). `apis` entries in
 * the global or project config customize a built-in (same id) or define new
 * instances (proxies, Groq, Together, Ollama, vLLM, …). `llm` workflow steps
 * reference an instance via their `api` field, and the doctor/status surfaces
 * report each enabled instance's readiness alongside agent health.
 */

/** The two wire dialects an instance can speak (Anthropic Messages / OpenAI chat). */
export const API_PROVIDER_IDS: readonly ApiProviderId[] = ["anthropic", "openai"];

export function isApiProviderId(value: string): value is ApiProviderId {
  return (API_PROVIDER_IDS as readonly string[]).includes(value);
}

/** Conventional env var each provider's key is read from. */
export const DEFAULT_API_KEY_ENV: Record<ApiProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

/**
 * A zero-config API instance: the raw providers, plus OpenAI-compatible
 * gateways that only differ by endpoint / key env. Decoupled from
 * {@link ApiProviderId} (the wire dialect) so several instances can share the
 * `openai` dialect while pointing at different hosts.
 */
interface BuiltinApiInstance {
  id: ApiInstanceId;
  /** Wire dialect the endpoint speaks. */
  provider: ApiProviderId;
  label: string;
  /** Env var the key is read from. */
  apiKeyEnv: string;
  /** Default endpoint (gateways only; raw providers resolve theirs at call time). */
  baseUrl?: string;
  /** Endpoint serves free models without a key; a key is used if present. */
  keyless?: boolean;
}

const BUILTIN_API_INSTANCES: readonly BuiltinApiInstance[] = [
  { id: "anthropic", provider: "anthropic", label: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" },
  { id: "openai", provider: "openai", label: "openai", apiKeyEnv: "OPENAI_API_KEY" },
  {
    id: "openrouter",
    provider: "openai",
    label: "OpenRouter",
    apiKeyEnv: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  {
    id: "opencode-zen",
    provider: "openai",
    label: "OpenCode Zen",
    apiKeyEnv: "OPENCODE_API_KEY",
    baseUrl: "https://opencode.ai/zen/v1",
    keyless: true,
  },
];

/** The built-in zero-config instance ids, in display order. */
export const API_IDS: readonly ApiInstanceId[] = BUILTIN_API_INSTANCES.map((b) => b.id);

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
  /** Endpoint serves free models without a key; a key is used if present. */
  keyless?: boolean;
  /** True when an `apis` config entry defines/overrides this instance. */
  configured: boolean;
}

export interface ResolveApiOptions {
  includeDisabled?: boolean;
}

/** Base instance for a config entry whose id is not a known built-in. */
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

function resolvedFromBuiltin(builtin: BuiltinApiInstance): ResolvedApiInstance {
  return {
    id: builtin.id,
    provider: builtin.provider,
    label: builtin.label,
    enabled: true,
    baseUrl: builtin.baseUrl,
    apiKeyEnv: builtin.apiKeyEnv,
    keyless: builtin.keyless,
    configured: false,
  };
}

/**
 * Overlay one `apis` config entry onto its base instance (a built-in, or a
 * fresh instance for a novel id). Fields the entry omits fall back to the base
 * rather than resetting to raw provider defaults — so a minimal entry like
 * `{ id: "openrouter", provider: "openai", enabled: true }` (what `/api enable`
 * writes) keeps the built-in's endpoint, key env, and keyless flag.
 */
function applyApiConfig(
  base: ResolvedApiInstance,
  override: ApiInstanceConfig,
): ResolvedApiInstance {
  return {
    ...base,
    provider: override.provider,
    label: override.label ?? base.label,
    enabled: override.enabled ?? base.enabled,
    baseUrl: override.baseUrl ?? base.baseUrl,
    apiKeyEnv: override.apiKeyEnv ?? base.apiKeyEnv,
    defaultModel: override.defaultModel ?? base.defaultModel,
    pricing: override.pricing ?? base.pricing,
    keyless: override.keyless ?? base.keyless,
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
  for (const builtin of BUILTIN_API_INSTANCES) byId.set(builtin.id, resolvedFromBuiltin(builtin));

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
