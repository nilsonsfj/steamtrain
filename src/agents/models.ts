import type { SteamtrainConfig } from "../config/types";
import type { DoctorResult } from "../doctor";
import type { AgentId } from "../types/events";
import { type AgentModel, formatModelOption } from "./agent-model";
import { CLAUDE_MODELS } from "./claude";
import { CODEX_MODELS } from "./codex";
import {
  getCodexEfforts,
  getCodexModelName,
  listCodexCachedAgentModels,
  refreshCodexVariantCache,
} from "./codex-variants";
import { OPENCODE_MODELS } from "./opencode";
import {
  getOpencodeEfforts,
  getOpencodeModelName,
  listOpencodeCachedAgentModels,
  refreshOpencodeVariantCache,
} from "./opencode-variants";

/** All agent ids steamtrain can dispatch to. */
export const AGENT_IDS: readonly AgentId[] = ["claude", "opencode", "codex"];

export function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

function opencodeModelsWithLiveNames(): readonly AgentModel[] {
  const cached = listOpencodeCachedAgentModels();
  if (cached.length > 0) return cached;

  return OPENCODE_MODELS.map((model) => ({
    id: model.id,
    name: getOpencodeModelName(model.id) ?? model.name,
  }));
}

function codexModelsWithLiveNames(): readonly AgentModel[] {
  const cached = listCodexCachedAgentModels();
  if (cached.length > 0) return cached;

  return CODEX_MODELS.map((model) => ({
    id: model.id,
    name: getCodexModelName(model.id) ?? model.name,
  }));
}

/** Model catalog for an agent provider (id + human-readable name). */
export function modelsForAgent(agent: AgentId): readonly AgentModel[] {
  switch (agent) {
    case "claude":
      return CLAUDE_MODELS;
    case "opencode":
      return opencodeModelsWithLiveNames();
    case "codex":
      return codexModelsWithLiveNames();
  }
}

/** Model ids for an agent (used by autocomplete and validation). */
export function modelIdsForAgent(agent: AgentId): readonly string[] {
  return modelsForAgent(agent).map((model) => model.id);
}

/** Human-readable name for a model id, falling back to the id itself. */
export function modelNameForAgent(agent: AgentId, modelId: string): string {
  const fromCatalog = modelsForAgent(agent).find((model) => model.id === modelId);
  if (fromCatalog) return fromCatalog.name;
  if (agent === "opencode") return getOpencodeModelName(modelId) ?? modelId;
  if (agent === "codex") return getCodexModelName(modelId) ?? modelId;
  return modelId;
}

/** Default model when switching to an agent without an explicit model. */
export function defaultModelForAgent(agent: AgentId): string {
  const preferred =
    agent === "opencode"
      ? OPENCODE_MODELS[0]?.id
      : agent === "codex"
        ? CODEX_MODELS[0]?.id
        : undefined;
  const available = modelIdsForAgent(agent);
  if (preferred && available.includes(preferred)) return preferred;
  return available[0] ?? preferred ?? agent;
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
    case "codex":
      return getCodexEfforts(model);
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

/** Human-readable model label, optionally with effort (no agent prefix). */
export function formatModelDisplay(target: {
  agent: AgentId;
  model: string;
  effort?: string;
}): string {
  const modelLabel = modelNameForAgent(target.agent, target.model);
  const base = modelLabel === target.model ? target.model : `${modelLabel} (${target.model})`;
  return target.effort ? `${base} · ${target.effort}` : base;
}

/** Compact label for agent + model (+ optional effort). */
export function formatAgentTarget(target: {
  agent: AgentId;
  model: string;
  effort?: string;
}): string {
  return `${target.agent}/${formatModelDisplay(target)}`;
}

/** Refresh live model catalogs for agents that passed doctor preflight. */
export async function refreshAgentCatalogCaches(
  config: SteamtrainConfig,
  doctor: DoctorResult[],
): Promise<boolean> {
  let refreshed = false;

  const opencode = doctor.find((d) => d.agent === "opencode");
  if (opencode?.status === "ok") {
    const binary = config.binaries?.opencode ?? opencode.binaryPath ?? "opencode";
    if (await refreshOpencodeVariantCache(binary)) refreshed = true;
  }

  const codex = doctor.find((d) => d.agent === "codex");
  if (codex?.status === "ok") {
    const binary = config.binaries?.codex ?? codex.binaryPath ?? "codex";
    if (await refreshCodexVariantCache(binary)) refreshed = true;
  }

  return refreshed;
}

export { formatModelOption, refreshCodexVariantCache, refreshOpencodeVariantCache };
export type { AgentModel };
