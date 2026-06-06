import type { AgentId } from "../types/events";
import { CLAUDE_MODELS } from "./claude";
import { OPENCODE_MODELS } from "./opencode";

/** All agent ids steamtrain can dispatch to. */
export const AGENT_IDS: readonly AgentId[] = ["claude", "opencode"];

export function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

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

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const OPENCODE_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** Known effort / variant levels for an agent (used by `/effort` and autocomplete). */
export function effortsForAgent(agent: AgentId): readonly string[] {
  switch (agent) {
    case "claude":
      return CLAUDE_EFFORTS;
    case "opencode":
      return OPENCODE_EFFORTS;
  }
}

/** Compact label for agent + model (+ optional effort). */
export function formatAgentTarget(target: {
  agent: AgentId;
  model: string;
  effort?: string;
}): string {
  const base = `${target.agent}/${target.model}`;
  return target.effort ? `${base} · ${target.effort}` : base;
}
