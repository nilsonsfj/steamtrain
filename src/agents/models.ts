import type { AgentId } from "../types/events";
import { CLAUDE_MODELS } from "./claude";
import { getOpencodeEfforts, refreshOpencodeVariantCache } from "./opencode-variants";
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

const CLAUDE_OPUS_48_47_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const CLAUDE_OPUS_46_SONNET_46_EFFORTS = ["low", "medium", "high", "max"] as const;

function stripContextSuffix(model: string): string {
  return model.replace(/\[1m\]$/, "");
}

function claudeEfforts(model: string): readonly string[] {
  const m = stripContextSuffix(model);

  if (m === "opus" || m === "best" || m === "opusplan") {
    return CLAUDE_OPUS_48_47_EFFORTS;
  }
  if (m === "sonnet") {
    return CLAUDE_OPUS_46_SONNET_46_EFFORTS;
  }
  if (m === "haiku") {
    return [];
  }

  if (/^claude-opus-4-(?:7|8)(?:$|-)/.test(m)) {
    return CLAUDE_OPUS_48_47_EFFORTS;
  }
  if (m === "claude-opus-4-6" || m.startsWith("claude-opus-4-6")) {
    return CLAUDE_OPUS_46_SONNET_46_EFFORTS;
  }
  if (m === "claude-sonnet-4-6" || m.startsWith("claude-sonnet-4-6")) {
    return CLAUDE_OPUS_46_SONNET_46_EFFORTS;
  }

  return [];
}

/** Known effort / variant levels for a specific model (used by `/effort` and autocomplete). */
export function effortsForModel(agent: AgentId, model: string): readonly string[] {
  switch (agent) {
    case "claude":
      return claudeEfforts(model);
    case "opencode":
      return getOpencodeEfforts(model);
  }
}

/** Whether the model accepts an effort / variant override at all. */
export function supportsEffort(agent: AgentId, model: string): boolean {
  return effortsForModel(agent, model).length > 0;
}

/** Keep effort when switching models only if the new model supports it. */
export function effortForModelChange(
  agent: AgentId,
  nextModel: string,
  currentEffort?: string,
): string | undefined {
  if (!currentEffort) return undefined;
  return effortsForModel(agent, nextModel).includes(currentEffort) ? currentEffort : undefined;
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

export { refreshOpencodeVariantCache };
