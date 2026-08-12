import type { SteamtrainConfig } from "../config/types";
import type { AgentInstanceId, AgentProviderId } from "../types/events";
import { resolveAgentInstances } from "./config";
import { defaultModelForAgent, effortsForModel, modelsForAgent } from "./models";

export interface AgentModelMeta {
  id: string;
  name: string;
  /** Reasoning effort / variant levels this model accepts (may be empty). */
  efforts: string[];
  /** Optional picker bucket label (e.g. Claude's current/alias/legacy split). */
  group?: string;
}

export interface AgentMeta {
  id: AgentInstanceId;
  provider: AgentProviderId;
  label: string;
  models: AgentModelMeta[];
  defaultModel: string;
  healthy: boolean;
  enabled: boolean;
  binary?: string;
  env?: Record<string, string>;
  extraArgs?: string[];
}

/**
 * Default model for drafting/authoring a workflow. Each agent's adapter
 * declares its own default; this delegates to {@link defaultModelForAgent}.
 * Shared by the TUI's `/create-workflow` and the web create form so both
 * pick the same starting point.
 */
export function defaultDraftModel(agent: AgentInstanceId, config?: SteamtrainConfig): string {
  return defaultModelForAgent(agent, config);
}

/**
 * The agent → models → efforts → default → health view-model that both UIs use
 * to populate agent/model/effort pickers. Full config-only fields are included
 * only when requested by config surfaces.
 */
export function buildAgentMeta(
  config: SteamtrainConfig,
  isHealthy: (agent: AgentInstanceId) => boolean,
  options: { includeDisabled?: boolean; includeConfig?: boolean } = {},
): AgentMeta[] {
  return resolveAgentInstances(config, options).map((agent) => ({
    id: agent.id,
    provider: agent.provider,
    label: agent.label,
    models: modelsForAgent(agent.id, config).map((model) => ({
      id: model.id,
      name: model.name,
      efforts: [...effortsForModel(agent.id, model.id, config)],
      ...(model.group ? { group: model.group } : {}),
    })),
    defaultModel: defaultDraftModel(agent.id, config),
    healthy: isHealthy(agent.id),
    enabled: agent.enabled,
    ...(options.includeConfig
      ? { binary: agent.binary, env: agent.env, extraArgs: agent.extraArgs }
      : {}),
  }));
}
