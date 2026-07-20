import type { SteamtrainConfig } from "../config/types";
import type { DoctorResult } from "../doctor";
import type { AgentInstanceId, AgentProviderId } from "../types/events";
import type { AgentAdapter } from "./adapter";
import { type AgentModel, formatModelOption } from "./agent-model";
import { AMP_MODELS, AmpAdapter } from "./amp";
import { CLAUDE_MODELS, ClaudeCodeAdapter } from "./claude";
import { CODEX_MODELS, CodexAdapter } from "./codex";
import {
  getCodexEfforts,
  getCodexModelName,
  listCodexCachedAgentModels,
  refreshCodexVariantCache,
} from "./codex-variants";
import { resolveAgentInstance } from "./config";
import { CursorAgentAdapter } from "./cursor";
import { KIRO_MODELS, KiroCliAdapter } from "./kiro";
import { OPENCODE_MODELS, OpenCodeAdapter } from "./opencode";
import {
  getOpencodeEfforts,
  getOpencodeModelName,
  listOpencodeCachedAgentModels,
  refreshOpencodeVariantCache,
} from "./opencode-variants";

/** All built-in agent providers steamtrain can dispatch to. */
export const AGENT_IDS: readonly AgentProviderId[] = [
  "claude",
  "opencode",
  "codex",
  "amp",
  "kiro",
];

export function isAgentProviderId(value: string): value is AgentProviderId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

export const isAgentId = isAgentProviderId;

export function agentProviderFor(
  config: SteamtrainConfig | undefined,
  agent: AgentInstanceId,
): AgentProviderId | undefined {
  return resolveAgentInstance(config, agent, { includeDisabled: true })?.provider;
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
export function modelsForProvider(provider: AgentProviderId): readonly AgentModel[] {
  switch (provider) {
    case "claude":
      return CLAUDE_MODELS;
    case "opencode":
      return opencodeModelsWithLiveNames();
    case "codex":
      return codexModelsWithLiveNames();
    case "amp":
      return AMP_MODELS;
    case "kiro":
      return KIRO_MODELS;
    case "cursor":
      return [];
  }
}

/** Model catalog for a configured agent instance (id + human-readable name). */
export function modelsForAgent(
  agent: AgentInstanceId,
  config?: SteamtrainConfig,
): readonly AgentModel[] {
  const provider = agentProviderFor(config, agent);
  return provider ? modelsForProvider(provider) : [];
}

/** Model ids for an agent (used by autocomplete and validation). */
export function modelIdsForAgent(
  agent: AgentInstanceId,
  config?: SteamtrainConfig,
): readonly string[] {
  return modelsForAgent(agent, config).map((model) => model.id);
}

/** Human-readable name for a model id, falling back to the id itself. */
export function modelNameForAgent(
  agent: AgentInstanceId,
  modelId: string,
  config?: SteamtrainConfig,
): string {
  const provider = agentProviderFor(config, agent);
  const fromCatalog = modelsForAgent(agent, config).find((model) => model.id === modelId);
  if (fromCatalog) return fromCatalog.name;
  if (provider === "opencode") return getOpencodeModelName(modelId) ?? modelId;
  if (provider === "codex") return getCodexModelName(modelId) ?? modelId;
  return modelId;
}

/**
 * Factory map from provider ID to adapter constructor. `defaultModelForAgent`
 * instantiates the adapter here to read its `defaultModel` — the adapter
 * class is the single source of truth for each provider's default.
 */
const PROVIDER_ADAPTERS: Record<AgentProviderId, () => AgentAdapter> = {
  claude: () => new ClaudeCodeAdapter(),
  codex: () => new CodexAdapter(),
  opencode: () => new OpenCodeAdapter(),
  amp: () => new AmpAdapter(),
  kiro: () => new KiroCliAdapter(),
  cursor: () => new CursorAgentAdapter(),
};

/** Default model when switching to an agent without an explicit model. */
export function defaultModelForAgent(agent: AgentInstanceId, config?: SteamtrainConfig): string {
  const instance = resolveAgentInstance(config, agent, { includeDisabled: true });
  if (instance?.defaultModel) return instance.defaultModel;
  const provider = instance?.provider;
  const preferred = provider ? PROVIDER_ADAPTERS[provider]?.().defaultModel : undefined;
  const available = modelIdsForAgent(agent, config);
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
  if (m === "fable") {
    return CLAUDE_OPUS_48_47_EFFORTS;
  }
  if (m === "sonnet") {
    return CLAUDE_OPUS_46_SONNET_46_EFFORTS;
  }
  if (m === "haiku") {
    return [];
  }

  if (/^claude-fable-5(?:$|-)/.test(m)) {
    return CLAUDE_OPUS_48_47_EFFORTS;
  }
  if (/^claude-mythos-5(?:$|-)/.test(m)) {
    return CLAUDE_OPUS_48_47_EFFORTS;
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
  if (/^claude-sonnet-5(?:$|-)/.test(m)) {
    return CLAUDE_OPUS_46_SONNET_46_EFFORTS;
  }

  return [];
}

// amp toggles reasoning effort per mode: deep cycles low/medium/xhigh, smart
// cycles high/xhigh/max, rush has no reasoning. See https://ampcode.com/manual.
const AMP_DEEP_EFFORTS = ["low", "medium", "xhigh"] as const;
const AMP_SMART_EFFORTS = ["high", "xhigh", "max"] as const;

function ampEfforts(model: string): readonly string[] {
  if (model === "deep") return AMP_DEEP_EFFORTS;
  if (model === "smart") return AMP_SMART_EFFORTS;
  return [];
}

/** Known effort / variant levels for a specific model (used by `/effort` and autocomplete). */
export function effortsForModel(
  agent: AgentInstanceId,
  model: string,
  config?: SteamtrainConfig,
): readonly string[] {
  const provider = agentProviderFor(config, agent);
  switch (provider) {
    case "claude":
      return claudeEfforts(model);
    case "opencode":
      return getOpencodeEfforts(model);
    case "codex":
      return getCodexEfforts(model);
    case "amp":
      return ampEfforts(model);
    case "kiro":
      return claudeEfforts(model);
    default:
      return [];
  }
}

/** Whether the model accepts an effort / variant override at all. */
export function supportsEffort(
  agent: AgentInstanceId,
  model: string,
  config?: SteamtrainConfig,
): boolean {
  return effortsForModel(agent, model, config).length > 0;
}

/** Keep effort when switching models only if the new model supports it. */
export function effortForModelChange(
  agent: AgentInstanceId,
  nextModel: string,
  currentEffort?: string,
  config?: SteamtrainConfig,
): string | undefined {
  if (!currentEffort) return undefined;
  return effortsForModel(agent, nextModel, config).includes(currentEffort)
    ? currentEffort
    : undefined;
}

/** Human-readable model label, optionally with effort (no agent prefix). */
export function formatModelDisplay(target: {
  agent: AgentInstanceId;
  model: string;
  effort?: string;
  config?: SteamtrainConfig;
}): string {
  const modelLabel = modelNameForAgent(target.agent, target.model, target.config);
  const base = modelLabel === target.model ? target.model : `${modelLabel} (${target.model})`;
  return target.effort ? `${base} · ${target.effort}` : base;
}

/** Compact label for agent + model (+ optional effort). */
export function formatAgentTarget(target: {
  agent: AgentInstanceId;
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

  const opencode = doctor.find((d) => d.provider === "opencode" && d.status === "ok");
  if (opencode?.status === "ok") {
    const binary =
      resolveAgentInstance(config, opencode.agent)?.binary ?? opencode.binaryPath ?? "opencode";
    if (await refreshOpencodeVariantCache(binary)) refreshed = true;
  }

  const codex = doctor.find((d) => d.provider === "codex" && d.status === "ok");
  if (codex?.status === "ok") {
    const binary = resolveAgentInstance(config, codex.agent)?.binary ?? codex.binaryPath ?? "codex";
    if (await refreshCodexVariantCache(binary)) refreshed = true;
  }

  return refreshed;
}

export { formatModelOption, refreshCodexVariantCache, refreshOpencodeVariantCache };
export type { AgentModel };
