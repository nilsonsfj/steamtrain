import type { AgentConfigScope, AgentInstanceConfig } from "../config/types";
import type { AgentInstanceId } from "../types/events";

/** Raw agent entries per config file, for scope-aware saves. */
export interface AgentLayers {
  userAgents?: readonly AgentInstanceConfig[];
  projectAgents?: readonly AgentInstanceConfig[];
}

/**
 * Scope whose file configures `id`. Project shadows user (matching merge
 * order); `undefined` means the id is an unconfigured built-in provider.
 */
export function agentConfigScope(
  id: AgentInstanceId,
  layers: AgentLayers,
): AgentConfigScope | undefined {
  if (layers.projectAgents?.some((agent) => agent.id === id)) return "project";
  if (layers.userAgents?.some((agent) => agent.id === id)) return "user";
  return undefined;
}

/** Display label for an agent's config scope. */
export function agentScopeLabel(scope: AgentConfigScope | undefined): string {
  if (scope === "user") return "global";
  if (scope === "project") return "project";
  return "builtin";
}

export function upsertAgent(
  agents: readonly AgentInstanceConfig[] | undefined,
  next: AgentInstanceConfig,
): AgentInstanceConfig[] {
  const out = (agents ?? []).filter((agent) => agent.id !== next.id);
  out.push(next);
  return out;
}

export function removeAgent(
  agents: readonly AgentInstanceConfig[] | undefined,
  id: AgentInstanceId,
): AgentInstanceConfig[] {
  return (agents ?? []).filter((agent) => agent.id !== id);
}
