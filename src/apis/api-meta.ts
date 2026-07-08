import type { SteamtrainConfig } from "../config/types";
import type { ApiInstanceId, ApiProviderId } from "../types/events";
import type { LlmPricing } from "../workflow/types";
import { resolveApiInstances } from "./config";

/**
 * The API-instance view-model both UIs use for pickers, health chips, and the
 * config surfaces — the direct-inference analog of `AgentMeta`. Full
 * config-only fields are included only when requested by config surfaces.
 */
export interface ApiMeta {
  id: ApiInstanceId;
  provider: ApiProviderId;
  label: string;
  enabled: boolean;
  healthy: boolean;
  /** Env var the key is read from. */
  apiKeyEnv: string;
  /** Whether that env var is set in the server/TUI process (never the key itself). */
  keyPresent: boolean;
  baseUrl?: string;
  defaultModel?: string;
  pricing?: LlmPricing;
}

export function buildApiMeta(
  config: SteamtrainConfig | undefined,
  isHealthy: (api: ApiInstanceId) => boolean,
  options: { includeDisabled?: boolean; includeConfig?: boolean } = {},
  env: Record<string, string | undefined> = process.env,
): ApiMeta[] {
  return resolveApiInstances(config, options).map((api) => ({
    id: api.id,
    provider: api.provider,
    label: api.label,
    enabled: api.enabled,
    healthy: isHealthy(api.id),
    apiKeyEnv: api.apiKeyEnv,
    keyPresent: Boolean(env[api.apiKeyEnv]),
    ...(options.includeConfig
      ? { baseUrl: api.baseUrl, defaultModel: api.defaultModel, pricing: api.pricing }
      : {}),
  }));
}
