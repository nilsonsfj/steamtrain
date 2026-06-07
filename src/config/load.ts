import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homeRelativePath } from "../paths";
import { type WorkflowSpec, validateWorkflow } from "../workflow/types";
import { WORKSPACE_CONFIG_FILENAME } from "../workspace";
import { DEFAULT_CONFIG } from "./defaults";
import { type ConfigFile, type SteamtrainConfig, configFileSchema } from "./types";

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
  /** Non-fatal problem encountered while loading (kept defaults). */
  warning?: string;
}

/** Status-bar label for cfg: `defaults`, `user`, `project`, `user+project`, or a custom path. */
export function configDisplayLabel(
  scope: ConfigScope,
  options: { hasUserSettings?: boolean; home?: string } = {},
): string {
  const home = options.home;
  if (scope.kind === "custom") {
    return homeRelativePath(scope.path, home);
  }

  const parts: string[] = [];
  if (options.hasUserSettings) parts.push("user");
  if (scope.exists) parts.push("project");
  return parts.length > 0 ? parts.join("+") : "defaults";
}

export function projectConfigPath(cwd: string = process.cwd()): string {
  return join(cwd, CONFIG_FILENAME);
}

/** Load defaults, then deep-merge `steamtrain.json` from `cwd` or a custom file. */
export function loadConfig(options: ConfigLoadOptions | string = {}): LoadedConfig {
  const opts: ConfigLoadOptions = typeof options === "string" ? { cwd: options } : options;
  const cwd = opts.cwd ?? process.cwd();

  if (opts.customPath) {
    const path = resolve(opts.customPath);
    return loadConfigFile(path, { kind: "custom", path, exists: true });
  }

  const path = projectConfigPath(cwd);
  if (!existsSync(path)) {
    return { config: DEFAULT_CONFIG, scope: { kind: "project", path, exists: false } };
  }

  return loadConfigFile(path, { kind: "project", path, exists: true });
}

function loadConfigFile(path: string, scope: ConfigScope): LoadedConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return {
      config: DEFAULT_CONFIG,
      scope,
      warning: `could not parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const legacyTasks = legacyTasksWarning(parsed);
  const result = configFileSchema.safeParse(parsed);
  if (!result.success) {
    return {
      config: DEFAULT_CONFIG,
      scope,
      warning: joinWarnings(
        legacyTasks,
        `invalid ${path}: ${result.error.issues[0]?.message ?? "schema error"}`,
      ),
    };
  }

  const { config, warnings } = mergeConfig(DEFAULT_CONFIG, result.data);
  return {
    config,
    scope,
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

export function mergeConfig(
  base: SteamtrainConfig,
  override: ConfigFile,
): { config: SteamtrainConfig; warnings: string[] } {
  const merged: SteamtrainConfig = {
    binaries: { ...base.binaries, ...override.binaries },
    timeoutMs: override.timeoutMs ?? base.timeoutMs,
    maxConcurrency: override.maxConcurrency ?? base.maxConcurrency,
  };

  const { workflows, warnings } = mergeWorkflows(base.workflows, override.workflows);
  if (workflows) merged.workflows = workflows;
  return { config: merged, warnings };
}

/** Merge user workflows over base, injecting each map key as the spec `name`. */
function mergeWorkflows(
  base: Record<string, WorkflowSpec> | undefined,
  override: ConfigFile["workflows"],
): { workflows?: Record<string, WorkflowSpec>; warnings: string[] } {
  if (!override) return { workflows: base, warnings: [] };
  const out: Record<string, WorkflowSpec> = { ...base };
  const warnings: string[] = [];
  for (const [name, spec] of Object.entries(override)) {
    const full = { ...spec, name };
    const valid = validateWorkflow(full);
    if (!valid.ok) {
      warnings.push(`workflow '${name}' ignored: ${valid.error}`);
      continue;
    }
    out[name] = full;
  }
  return { workflows: out, warnings };
}
