import type { AgentId } from "../types/events";
import { CLAUDE_MODELS } from "./claude";
import { OPENCODE_MODELS } from "./opencode";

/** All agent ids steamtrain can dispatch to. */
export const AGENT_IDS: readonly AgentId[] = ["claude", "opencode"];

/** Hardcoded model list for an agent provider. */
export function modelsForAgent(agent: AgentId): readonly string[] {
  switch (agent) {
    case "claude":
      return CLAUDE_MODELS;
    case "opencode":
      return OPENCODE_MODELS;
  }
}

/** Default model when switching to an agent without an explicit model. */
export function defaultModelForAgent(agent: AgentId): string {
  return modelsForAgent(agent)[0] ?? agent;
}
