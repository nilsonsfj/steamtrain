import type { AgentId } from "../types/events";
import { AGENT_IDS, defaultModelForAgent, effortsForModel, modelsForAgent } from "./models";

export interface AgentModelMeta {
  id: string;
  name: string;
  /** Reasoning effort / variant levels this model accepts (may be empty). */
  efforts: string[];
}

export interface AgentMeta {
  id: AgentId;
  models: AgentModelMeta[];
  defaultModel: string;
  healthy: boolean;
}

/**
 * Default model for drafting/authoring a workflow. opencode prefers the free
 * MiMo model (the catalog default is a paid model); other agents use their
 * normal default. Shared by the TUI's `/createworkflow` and the web create form
 * so both pick the same starting point.
 */
export function defaultDraftModel(agent: AgentId): string {
  if (agent === "opencode") {
    const free = "opencode/mimo-v2.5-free";
    if (modelsForAgent(agent).some((m) => m.id === free)) return free;
  }
  return defaultModelForAgent(agent);
}

/**
 * The agent → models → efforts → default → health view-model that both UIs use
 * to populate agent/model/effort pickers. `isHealthy` supplies live doctor
 * health so callers don't reach into the orchestrator themselves. This is the
 * one place the picker shape is defined; `/api/meta` returns it verbatim.
 */
export function buildAgentMeta(isHealthy: (agent: AgentId) => boolean): AgentMeta[] {
  return AGENT_IDS.map((agent) => ({
    id: agent,
    models: modelsForAgent(agent).map((model) => ({
      id: model.id,
      name: model.name,
      efforts: [...effortsForModel(agent, model.id)],
    })),
    defaultModel: defaultDraftModel(agent),
    healthy: isHealthy(agent),
  }));
}
