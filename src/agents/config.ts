import type { AgentInstanceConfig, SteamtrainConfig } from "../config/types";
import type { AgentId, AgentInstanceId, AgentProviderId } from "../types/events";

const AGENT_PROVIDER_IDS: readonly AgentProviderId[] = [
  "claude",
  "opencode",
  "codex",
  "amp",
  "kiro",
  "mimo",
  "kimi",
  "cursor",
  "antigravity",
  "grok",
];

export const DEFAULT_AGENT_BINARY: Record<AgentProviderId, string> = {
  claude: "claude",
  opencode: "opencode",
  codex: "codex",
  amp: "amp",
  kiro: "kiro-cli",
  mimo: "mimo",
  kimi: "kimi",
  cursor: "agent",
  antigravity: "agy",
  grok: "grok",
};

/**
 * Compact UI label for each built-in provider. Differs from the provider id
 * only when the id is too long for dense surfaces (status chips, step rows,
 * settings rows). The raw provider id (never a marketing name like
 * "Antigravity") can still show up as disambiguating detail on roomy
 * admin screens (e.g. the TUI agent manager's `provider=` suffix).
 */
export const DEFAULT_AGENT_LABEL: Record<AgentProviderId, string> = {
  claude: "claude",
  opencode: "opencode",
  codex: "codex",
  amp: "amp",
  kiro: "kiro",
  mimo: "mimo",
  kimi: "kimi",
  cursor: "cursor",
  antigravity: "agy",
  grok: "grok",
};

/**
 * Short name for UI when we only have an instance/provider id (no config).
 * Custom instance ids pass through; built-in `antigravity` becomes `agy`.
 */
export function agentUiLabel(id: string | undefined | null): string {
  if (!id) return "";
  if ((AGENT_PROVIDER_IDS as readonly string[]).includes(id)) {
    return DEFAULT_AGENT_LABEL[id as AgentProviderId];
  }
  return id;
}

export interface ResolvedAgentInstance {
  id: AgentInstanceId;
  provider: AgentProviderId;
  label: string;
  enabled: boolean;
  binary: string;
  env?: Record<string, string>;
  extraArgs?: string[];
  defaultModel?: string;
  configured: boolean;
}

export interface ResolveAgentOptions {
  includeDisabled?: boolean;
}

export function defaultAgentInstance(
  provider: AgentProviderId,
  config?: SteamtrainConfig,
): ResolvedAgentInstance {
  return {
    id: provider,
    provider,
    label: DEFAULT_AGENT_LABEL[provider],
    enabled: true,
    binary: config?.binaries?.[provider] ?? DEFAULT_AGENT_BINARY[provider],
    configured: false,
  };
}

function applyAgentConfig(
  base: ResolvedAgentInstance,
  override: AgentInstanceConfig,
): ResolvedAgentInstance {
  return {
    ...base,
    provider: override.provider,
    label: override.label ?? base.label,
    enabled: override.enabled ?? base.enabled,
    binary: override.binary ?? base.binary,
    env: override.env,
    extraArgs: override.extraArgs,
    defaultModel: override.defaultModel,
    configured: true,
  };
}

export function resolveAgentInstances(
  config?: SteamtrainConfig,
  options: ResolveAgentOptions = {},
): ResolvedAgentInstance[] {
  const byId = new Map<AgentInstanceId, ResolvedAgentInstance>();
  for (const provider of AGENT_PROVIDER_IDS)
    byId.set(provider, defaultAgentInstance(provider, config));

  for (const item of config?.agents ?? []) {
    const base =
      byId.get(item.id) ??
      ({
        id: item.id,
        provider: item.provider,
        label: item.id,
        enabled: true,
        binary: config?.binaries?.[item.provider] ?? DEFAULT_AGENT_BINARY[item.provider],
        configured: false,
      } satisfies ResolvedAgentInstance);
    byId.set(item.id, applyAgentConfig(base, item));
  }

  const all = [...byId.values()];
  return options.includeDisabled ? all : all.filter((agent) => agent.enabled);
}

export function resolveAgentInstance(
  config: SteamtrainConfig | undefined,
  id: AgentInstanceId,
  options: ResolveAgentOptions = {},
): ResolvedAgentInstance | undefined {
  return resolveAgentInstances(config, options).find((agent) => agent.id === id);
}
