import type { SteamtrainConfig } from "../config/types";
import type { DoctorResult } from "../doctor";
import type { AgentInstanceId, AgentProviderId } from "../types/events";
import type { AgentAdapter } from "./adapter";
import { type AgentModel, formatModelOption } from "./agent-model";
import { AMP_MODELS, AmpAdapter } from "./amp";
import { ANTIGRAVITY_MODELS, AntigravityAdapter } from "./antigravity";
import {
  getAntigravityModelName,
  listAntigravityCachedAgentModels,
  refreshAntigravityVariantCache,
} from "./antigravity-variants";
import { CLAUDE_MODELS, ClaudeCodeAdapter } from "./claude";
import { CODEX_MODELS, CodexAdapter } from "./codex";
import {
  getCodexEfforts,
  getCodexModelName,
  listCodexCachedAgentModels,
  refreshCodexVariantCache,
} from "./codex-variants";
import { agentUiLabel, resolveAgentInstance } from "./config";
import { CURSOR_MODELS, CursorAgentAdapter } from "./cursor";
import {
  getCursorModelName,
  listCursorCachedAgentModels,
  refreshCursorVariantCache,
} from "./cursor-variants";
import { KIMI_MODELS, KimiAdapter } from "./kimi";
import {
  getKimiEfforts,
  getKimiModelName,
  listKimiCachedAgentModels,
  refreshKimiVariantCache,
} from "./kimi-variants";
import { KIRO_MODELS, KiroCliAdapter } from "./kiro";
import { MIMO_MODELS, MimoAdapter } from "./mimo";
import {
  getMimoEfforts,
  getMimoModelName,
  listMimoCachedAgentModels,
  refreshMimoVariantCache,
} from "./mimo-variants";
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
  "mimo",
  "kimi",
  "cursor",
  "antigravity",
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

function cursorModelsWithLiveNames(): readonly AgentModel[] {
  const cached = listCursorCachedAgentModels();
  if (cached.length > 0) return cached;

  return CURSOR_MODELS.map((model) => ({
    id: model.id,
    name: getCursorModelName(model.id) ?? model.name,
  }));
}

function antigravityModelsWithLiveNames(): readonly AgentModel[] {
  const cached = listAntigravityCachedAgentModels();
  if (cached.length > 0) return cached;

  return ANTIGRAVITY_MODELS.map((model) => ({
    id: model.id,
    name: getAntigravityModelName(model.id) ?? model.name,
  }));
}

function mimoModelsWithLiveNames(): readonly AgentModel[] {
  const cached = listMimoCachedAgentModels();
  if (cached.length > 0) return cached;

  return MIMO_MODELS.map((model) => ({
    id: model.id,
    name: getMimoModelName(model.id) ?? model.name,
  }));
}

function kimiModelsWithLiveNames(): readonly AgentModel[] {
  const cached = listKimiCachedAgentModels();
  if (cached.length > 0) return cached;

  return KIMI_MODELS.map((model) => ({
    id: model.id,
    name: getKimiModelName(model.id) ?? model.name,
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
    case "mimo":
      return mimoModelsWithLiveNames();
    case "kimi":
      return kimiModelsWithLiveNames();
    case "cursor":
      return cursorModelsWithLiveNames();
    case "antigravity":
      return antigravityModelsWithLiveNames();
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
  if (provider === "mimo") return getMimoModelName(modelId) ?? modelId;
  if (provider === "kimi") return getKimiModelName(modelId) ?? modelId;
  if (provider === "cursor") return getCursorModelName(modelId) ?? modelId;
  if (provider === "antigravity") return getAntigravityModelName(modelId) ?? modelId;
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
  mimo: () => new MimoAdapter(),
  kimi: () => new KimiAdapter(),
  cursor: () => new CursorAgentAdapter(),
  antigravity: () => new AntigravityAdapter(),
};

/**
 * Free OpenCode Zen models preferred when the live catalog does not include
 * the adapter's declared default. DeepSeek free is intentionally omitted
 * (hangs on multi-turn tool loops).
 */
const OPENCODE_FREE_DEFAULT_PREFERENCE = [
  "opencode/mimo-v2.5-free",
  "opencode/north-mini-code-free",
  "opencode/nemotron-3-ultra-free",
  "opencode/laguna-s-2.1-free",
] as const;

/** Default model when switching to an agent without an explicit model. */
export function defaultModelForAgent(agent: AgentInstanceId, config?: SteamtrainConfig): string {
  const instance = resolveAgentInstance(config, agent, { includeDisabled: true });
  const provider = instance?.provider;
  const available = modelIdsForAgent(agent, config);
  const configured = instance?.defaultModel;
  // Configured override wins only when it is still in the agent's catalog
  // (live catalogs drop removed/unauthenticated models).
  if (configured && (available.length === 0 || available.includes(configured))) {
    return configured;
  }
  const preferred = provider ? PROVIDER_ADAPTERS[provider]?.().defaultModel : undefined;
  if (preferred && (available.length === 0 || available.includes(preferred))) return preferred;
  if (provider === "opencode") {
    for (const id of OPENCODE_FREE_DEFAULT_PREFERENCE) {
      if (available.includes(id)) return id;
    }
  }
  return available[0] ?? preferred ?? configured ?? agent;
}

const CLAUDE_OPUS_48_47_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const CLAUDE_OPUS_46_SONNET_46_EFFORTS = ["low", "medium", "high", "max"] as const;

function stripContextSuffix(model: string): string {
  return model.replace(/\[1m\]$/, "");
}

/**
 * Claude-specific: map Kiro dotted version ids (`claude-opus-4.8`) onto the
 * dash form used by Claude effort tables (`claude-opus-4-8`). Non-Claude ids
 * (e.g. `gpt-5.6-sol`) are left unchanged. Current catalogs use single-digit
 * version components (`4.8`, `4.5`); multi-digit minors still normalize
 * correctly via successive digit matches (`4.10` → `4-10`).
 */
function normalizeClaudeVersionId(model: string): string {
  const stripped = stripContextSuffix(model);
  if (!stripped.startsWith("claude-")) return stripped;
  return stripped.replace(/(\d)\.(\d)/g, "$1-$2");
}

function claudeEfforts(model: string): readonly string[] {
  const m = normalizeClaudeVersionId(model);

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
    case "mimo":
      return getMimoEfforts(model);
    case "kimi":
      return getKimiEfforts(model);
    case "cursor":
      return /\[[^\]]*effort=/.test(model) ? [] : ["low", "medium", "high", "xhigh"];
    case "antigravity":
      // Effort is baked into slug suffixes (`-high`) or legacy `(High)` labels.
      return /-(low|medium|high|thinking|minimal)$/i.test(model) ||
        /\((Low|Medium|High|Thinking|Minimal)\)\s*$/i.test(model)
        ? []
        : ["low", "medium", "high", "thinking"];
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
  return `${agentUiLabel(target.agent)}/${formatModelDisplay(target)}`;
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

  const cursor = doctor.find((d) => d.provider === "cursor" && d.status === "ok");
  if (cursor?.status === "ok") {
    const binary =
      resolveAgentInstance(config, cursor.agent)?.binary ?? cursor.binaryPath ?? "agent";
    if (await refreshCursorVariantCache(binary)) refreshed = true;
  }

  const antigravity = doctor.find((d) => d.provider === "antigravity" && d.status === "ok");
  if (antigravity?.status === "ok") {
    const binary =
      resolveAgentInstance(config, antigravity.agent)?.binary ?? antigravity.binaryPath ?? "agy";
    if (await refreshAntigravityVariantCache(binary)) refreshed = true;
  }

  const mimo = doctor.find((d) => d.provider === "mimo" && d.status === "ok");
  if (mimo?.status === "ok") {
    const binary = resolveAgentInstance(config, mimo.agent)?.binary ?? mimo.binaryPath ?? "mimo";
    if (await refreshMimoVariantCache(binary)) refreshed = true;
  }

  const kimi = doctor.find((d) => d.provider === "kimi" && d.status === "ok");
  if (kimi?.status === "ok") {
    const binary = resolveAgentInstance(config, kimi.agent)?.binary ?? kimi.binaryPath ?? "kimi";
    if (await refreshKimiVariantCache(binary)) refreshed = true;
  }

  return refreshed;
}

export {
  formatModelOption,
  refreshAntigravityVariantCache,
  refreshCodexVariantCache,
  refreshCursorVariantCache,
  refreshKimiVariantCache,
  refreshMimoVariantCache,
  refreshOpencodeVariantCache,
};
export type { AgentModel };
