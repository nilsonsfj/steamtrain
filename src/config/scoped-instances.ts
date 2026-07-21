import type { AgentConfigScope, AgentInstanceConfig, ApiInstanceConfig } from "./types";

/** An agent/API config entry tagged with the file scope it should be saved to. */
export type ScopedAgentInstance = AgentInstanceConfig & { scope?: AgentConfigScope };
export type ScopedApiInstance = ApiInstanceConfig & { scope?: AgentConfigScope };

export interface PartitionedAgents {
  user: AgentInstanceConfig[];
  project: AgentInstanceConfig[];
}

export interface PartitionedApis {
  user: ApiInstanceConfig[];
  project: ApiInstanceConfig[];
}

/**
 * Default write scope for new agent/API definitions: global (`user`) when that
 * layer is available, otherwise the single project/custom file.
 */
export function defaultInstanceScope(canGlobal: boolean): AgentConfigScope {
  return canGlobal ? "user" : "project";
}

/**
 * Resolve the write scope for one entry. Explicit `user`/`project` wins;
 * missing/invalid scope falls back to {@link defaultInstanceScope}.
 */
export function resolveInstanceScope(scope: unknown, canGlobal: boolean): AgentConfigScope {
  if (scope === "project") return "project";
  if (scope === "user") {
    // Custom --config loads have no global layer; coerce to the writable file.
    return canGlobal ? "user" : "project";
  }
  return defaultInstanceScope(canGlobal);
}

/** Strip the transport-only `scope` field before persisting. */
function stripScope<T extends { scope?: AgentConfigScope }>(entry: T): Omit<T, "scope"> {
  const { scope: _scope, ...rest } = entry;
  return rest;
}

/**
 * Split a raw JSON array (each item may carry `scope`) into per-file lists,
 * then validate each list with `parse`. Partitioning runs first so the same
 * id can exist in both scopes — parsers enforce uniqueness *within* one file.
 */
export function parseScopedInstancePayload<T>(
  raw: unknown,
  canGlobal: boolean,
  parse: (entries: unknown) => T[],
  kind: "agents" | "apis",
): { user: T[]; project: T[] } {
  if (!Array.isArray(raw)) throw new Error(`${kind} must be an array`);
  const userRaw: unknown[] = [];
  const projectRaw: unknown[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      const scope = defaultInstanceScope(canGlobal);
      (scope === "user" ? userRaw : projectRaw).push(item);
      continue;
    }
    const { scope: rawScope, ...rest } = item as Record<string, unknown>;
    const scope = resolveInstanceScope(rawScope, canGlobal);
    (scope === "user" ? userRaw : projectRaw).push(rest);
  }
  return { user: parse(userRaw), project: parse(projectRaw) };
}

/**
 * Partition scoped agent entries into the arrays that belong in each config
 * file. Last entry wins on duplicate ids within a scope. When `canGlobal` is
 * false, every entry lands in `project` (the only writable file).
 */
export function partitionAgentsByScope(
  entries: readonly ScopedAgentInstance[],
  canGlobal: boolean,
): PartitionedAgents {
  const userById = new Map<string, AgentInstanceConfig>();
  const projectById = new Map<string, AgentInstanceConfig>();
  for (const entry of entries) {
    const scope = resolveInstanceScope(entry.scope, canGlobal);
    const clean = stripScope(entry) as AgentInstanceConfig;
    if (scope === "user") userById.set(clean.id, clean);
    else projectById.set(clean.id, clean);
  }
  return { user: [...userById.values()], project: [...projectById.values()] };
}

/** Same as {@link partitionAgentsByScope} for API instances. */
export function partitionApisByScope(
  entries: readonly ScopedApiInstance[],
  canGlobal: boolean,
): PartitionedApis {
  const userById = new Map<string, ApiInstanceConfig>();
  const projectById = new Map<string, ApiInstanceConfig>();
  for (const entry of entries) {
    const scope = resolveInstanceScope(entry.scope, canGlobal);
    const clean = stripScope(entry) as ApiInstanceConfig;
    if (scope === "user") userById.set(clean.id, clean);
    else projectById.set(clean.id, clean);
  }
  return { user: [...userById.values()], project: [...projectById.values()] };
}

/** Tag raw per-scope lists for the config editor (user entries first). */
export function tagAgentsWithScope(layers: {
  userAgents?: readonly AgentInstanceConfig[];
  projectAgents?: readonly AgentInstanceConfig[];
}): ScopedAgentInstance[] {
  return [
    ...(layers.userAgents ?? []).map((agent) => ({ ...agent, scope: "user" as const })),
    ...(layers.projectAgents ?? []).map((agent) => ({ ...agent, scope: "project" as const })),
  ];
}

/** Tag raw per-scope API lists for the config editor (user entries first). */
export function tagApisWithScope(layers: {
  userApis?: readonly ApiInstanceConfig[];
  projectApis?: readonly ApiInstanceConfig[];
}): ScopedApiInstance[] {
  return [
    ...(layers.userApis ?? []).map((api) => ({ ...api, scope: "user" as const })),
    ...(layers.projectApis ?? []).map((api) => ({ ...api, scope: "project" as const })),
  ];
}
