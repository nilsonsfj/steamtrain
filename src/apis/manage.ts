import type { ApiConfigScope, ApiInstanceConfig } from "../config/types";
import type { ApiInstanceId } from "../types/events";

/** Raw API entries per config file, for scope-aware saves (mirrors `AgentLayers`). */
export interface ApiLayers {
  userApis?: readonly ApiInstanceConfig[];
  projectApis?: readonly ApiInstanceConfig[];
}

/**
 * Scope whose file configures `id`. Project shadows user (matching merge
 * order); `undefined` means the id is an unconfigured built-in provider.
 */
export function apiConfigScope(id: ApiInstanceId, layers: ApiLayers): ApiConfigScope | undefined {
  if (layers.projectApis?.some((api) => api.id === id)) return "project";
  if (layers.userApis?.some((api) => api.id === id)) return "user";
  return undefined;
}

/** Display label for an API instance's config scope. */
export function apiScopeLabel(scope: ApiConfigScope | undefined): string {
  if (scope === "user") return "global";
  if (scope === "project") return "project";
  return "builtin";
}

export function upsertApi(
  apis: readonly ApiInstanceConfig[] | undefined,
  next: ApiInstanceConfig,
): ApiInstanceConfig[] {
  const out = (apis ?? []).filter((api) => api.id !== next.id);
  out.push(next);
  return out;
}

export function removeApi(
  apis: readonly ApiInstanceConfig[] | undefined,
  id: ApiInstanceId,
): ApiInstanceConfig[] {
  return (apis ?? []).filter((api) => api.id !== id);
}
