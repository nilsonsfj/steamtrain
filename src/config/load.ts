import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { homeRelativePath } from "../paths";
import { mergeWorkflowMap } from "../workflow/catalog";
import { WORKSPACE_CONFIG_FILENAME } from "../workspace";
import { DEFAULT_CONFIG } from "./defaults";
import {
  type AgentInstanceConfig,
  type ConfigFile,
  type SteamtrainConfig,
  type UserConfigFile,
  configFileSchema,
  userConfigFileSchema,
} from "./types";
import { userConfigPath } from "./user-config";

export const CONFIG_FILENAME = "steamtrain.json";

export type ConfigScopeKind = "custom" | "project";

export interface ConfigScope {
  kind: ConfigScopeKind;
  /** Absolute path used for load. */
  path: string;
  /** Whether the file existed at load time (custom always true). */
  exists: boolean;
}

export interface ConfigLoadOptions {
  cwd?: string;
  home?: string;
  /** When set, load/save only this file. */
  customPath?: string;
}

export interface LoadedConfig {
  config: SteamtrainConfig;
  scope: ConfigScope;
  /** Global `~/.steamtrain/config.json` layer (absent for custom-path loads). */
  user?: { path: string; exists: boolean };
  /** Raw agent entries from the global config file (for scoped saves). */
  userAgents?: AgentInstanceConfig[];
  /** Raw agent entries from the project (or custom) config file (for scoped saves). */
  projectAgents?: AgentInstanceConfig[];
  /** Non-fatal problem encountered while loading (kept defaults). */
  warning?: string;
}

/** Status-bar label for cfg: `defaults`, `user`, `project`, `user+project`, or a custom path. */
export function configDisplayLabel(
  scope: ConfigScope,
  options: { hasUserSettings?: boolean; hasUserConfig?: boolean; home?: string } = {},
): string {
  const home = options.home;
  if (scope.kind === "custom") {
    return homeRelativePath(scope.path, home);
  }

  const parts: string[] = [];
  if (options.hasUserSettings || options.hasUserConfig) parts.push("user");
  if (scope.exists) parts.push("project");
  return parts.length > 0 ? parts.join("+") : "defaults";
}

export function projectConfigPath(cwd: string = process.cwd()): string {
  return join(cwd, CONFIG_FILENAME);
}

/**
 * Load defaults, then deep-merge the global `~/.steamtrain/config.json` (if
 * present), then `steamtrain.json` from `cwd`. A custom file loads alone (no
 * user layer), preserving `--config`'s "load/save only this file" contract.
 */
export function loadConfig(options: ConfigLoadOptions | string = {}): LoadedConfig {
  const opts: ConfigLoadOptions = typeof options === "string" ? { cwd: options } : options;
  const cwd = opts.cwd ?? process.cwd();

  if (opts.customPath) {
    const path = resolve(opts.customPath);
    return loadConfigFile(path, { kind: "custom", path, exists: true }, DEFAULT_CONFIG);
  }

  const home = opts.home ?? homedir();
  const userPath = userConfigPath(home);
  const userLayer = loadUserConfigFile(userPath);
  const user = { path: userPath, exists: userLayer.exists };

  const path = projectConfigPath(cwd);
  if (!existsSync(path)) {
    return {
      config: userLayer.config,
      scope: { kind: "project", path, exists: false },
      user,
      userAgents: userLayer.agents,
      warning: userLayer.warning,
    };
  }

  const loaded = loadConfigFile(path, { kind: "project", path, exists: true }, userLayer.config);
  return {
    ...loaded,
    user,
    userAgents: userLayer.agents,
    warning: joinWarnings(userLayer.warning, loaded.warning),
  };
}

function loadUserConfigFile(path: string): {
  config: SteamtrainConfig;
  agents?: AgentInstanceConfig[];
  exists: boolean;
  warning?: string;
} {
  if (!existsSync(path)) return { config: DEFAULT_CONFIG, exists: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return {
      config: DEFAULT_CONFIG,
      exists: true,
      warning: `could not parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const result = userConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      config: DEFAULT_CONFIG,
      exists: true,
      warning: `invalid ${path}: ${issue ? `${issue.path.join(".") || "config"}: ${issue.message}` : "schema error"}`,
    };
  }

  const data: UserConfigFile = result.data;
  const { config } = mergeConfig(DEFAULT_CONFIG, data);
  return { config, agents: data.agents, exists: true };
}

function loadConfigFile(path: string, scope: ConfigScope, base: SteamtrainConfig): LoadedConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return {
      config: base,
      scope,
      warning: `could not parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const legacyTasks = legacyTasksWarning(parsed);
  const result = configFileSchema.safeParse(parsed);
  if (!result.success) {
    return {
      config: base,
      scope,
      warning: joinWarnings(
        legacyTasks,
        `invalid ${path}: ${result.error.issues[0]?.message ?? "schema error"}`,
      ),
    };
  }

  const { config, warnings } = mergeConfig(base, result.data);
  return {
    config,
    scope,
    projectAgents: result.data.agents,
    warning: joinWarnings(legacyTasks, warnings.length > 0 ? warnings.join("; ") : undefined),
  };
}

function legacyTasksWarning(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  if (!("tasks" in parsed)) return undefined;
  return `'tasks' in ${CONFIG_FILENAME} is no longer supported; move workspace presets to ~/.steamtrain/${WORKSPACE_CONFIG_FILENAME}`;
}

function joinWarnings(...parts: Array<string | undefined>): string | undefined {
  const text = parts.filter(Boolean).join("; ");
  return text || undefined;
}

function mergeTimeoutFields(
  base: SteamtrainConfig,
  override: ConfigFile,
): Pick<SteamtrainConfig, "stepTimeoutSec" | "workflowTimeoutSec"> {
  const msToSec = (ms: number): number => ms / 1000;

  const stepTimeoutSec =
    override.stepTimeoutSec ??
    (override.stepTimeoutMs !== undefined ? msToSec(override.stepTimeoutMs) : undefined) ??
    (override.timeoutMs !== undefined ? msToSec(override.timeoutMs) : undefined) ??
    base.stepTimeoutSec;

  const workflowTimeoutSec =
    override.workflowTimeoutSec ??
    (override.workflowTimeoutMs !== undefined ? msToSec(override.workflowTimeoutMs) : undefined) ??
    base.workflowTimeoutSec;

  const out: Pick<SteamtrainConfig, "stepTimeoutSec" | "workflowTimeoutSec"> = {};
  if (stepTimeoutSec !== undefined) out.stepTimeoutSec = stepTimeoutSec;
  if (workflowTimeoutSec !== undefined) out.workflowTimeoutSec = workflowTimeoutSec;
  return out;
}

export function mergeConfig(
  base: SteamtrainConfig,
  override: ConfigFile,
): { config: SteamtrainConfig; warnings: string[] } {
  const merged: SteamtrainConfig = {
    binaries: { ...base.binaries, ...override.binaries },
    agents: mergeAgentLists(base.agents, override.agents),
    ...mergeTimeoutFields(base, override),
    maxConcurrency: override.maxConcurrency ?? base.maxConcurrency,
    loopMaxIterations: override.loopMaxIterations ?? base.loopMaxIterations,
  };

  const { workflows, warning } = mergeWorkflowMap({}, {}, override.workflows, "project");
  if (Object.keys(workflows).length > 0) merged.workflows = workflows;
  const warnings = warning ? [warning] : [];
  return { config: merged, warnings };
}

/**
 * Merge agent instance lists by id: override entries replace same-id base
 * entries wholesale (no field-level merge); new override ids are appended.
 */
export function mergeAgentLists(
  base: AgentInstanceConfig[] | undefined,
  override: AgentInstanceConfig[] | undefined,
): AgentInstanceConfig[] | undefined {
  if (!base || base.length === 0) return override ?? base;
  if (!override || override.length === 0) return base;
  const overrideIds = new Set(override.map((agent) => agent.id));
  return [...base.filter((agent) => !overrideIds.has(agent.id)), ...override];
}
