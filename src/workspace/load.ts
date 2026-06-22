import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { homeRelativePath } from "../paths";
import { DEFAULT_WORKSPACE_CONFIG } from "./defaults";
import {
  type WorkspaceConfig,
  type WorkspaceEntry,
  type WorkspaceFile,
  isReservedWorkspaceId,
  workspaceFileSchema,
} from "./types";

export const WORKSPACE_CONFIG_DIR = ".steamtrain";
export const WORKSPACE_CONFIG_FILENAME = "workspace.json";
/** Project-level workspace presets: `./workspace.json` in the working directory. */
export const PROJECT_WORKSPACE_FILENAME = "workspace.json";

export type WorkspaceScopeKind = "user" | "project" | "custom";

export interface WorkspaceScope {
  kind: WorkspaceScopeKind;
  /** Absolute path used for load/save. */
  path: string;
}

export interface WorkspaceLoadOptions {
  home?: string;
  cwd?: string;
  /** When set, load/save only this file. */
  customPath?: string;
}

export interface LoadedWorkspaceConfig {
  config: WorkspaceConfig;
  scope: WorkspaceScope;
  /** Non-fatal problem encountered while loading. */
  warning?: string;
}

/** Status-bar label: `user`, `project`, or a custom file path (home-relative when under `~`). */
export function workspaceScopeLabel(scope: WorkspaceScope, home: string = homedir()): string {
  return scope.kind === "custom" ? homeRelativePath(scope.path, home) : scope.kind;
}

/** Default path: `~/.steamtrain/workspace.json`. */
export function workspaceConfigPath(home: string = homedir()): string {
  return join(home, WORKSPACE_CONFIG_DIR, WORKSPACE_CONFIG_FILENAME);
}

export function projectWorkspaceConfigPath(cwd: string = process.cwd()): string {
  return join(cwd, PROJECT_WORKSPACE_FILENAME);
}

/** Resolve which workspace file is in scope for load/save. */
export function resolveWorkspaceScope(options: WorkspaceLoadOptions = {}): WorkspaceScope {
  const home = options.home ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  if (options.customPath) {
    return { kind: "custom", path: resolve(options.customPath) };
  }
  const projectPath = projectWorkspaceConfigPath(cwd);
  if (existsSync(projectPath)) {
    return { kind: "project", path: projectPath };
  }
  return { kind: "user", path: workspaceConfigPath(home) };
}

/** Load workspace presets from user/project/custom files (materializing the user file on first run). */
export function loadWorkspaceConfig(
  options: WorkspaceLoadOptions | string = {},
): LoadedWorkspaceConfig {
  const opts: WorkspaceLoadOptions = typeof options === "string" ? { home: options } : options;
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();

  if (opts.customPath) {
    const path = resolve(opts.customPath);
    const scope: WorkspaceScope = { kind: "custom", path };
    materializeWorkspaceFile(path);
    return loadWorkspaceFile(path, scope);
  }

  const userPath = workspaceConfigPath(home);
  materializeWorkspaceFile(userPath);

  let config: WorkspaceConfig;
  let warning: string | undefined;
  const userLoaded = loadWorkspaceFile(userPath, { kind: "user", path: userPath });
  config = userLoaded.config;
  warning = userLoaded.warning;
  let scope = userLoaded.scope;

  const projectPath = projectWorkspaceConfigPath(cwd);
  if (existsSync(projectPath)) {
    const projectLoaded = loadWorkspaceFile(
      projectPath,
      { kind: "project", path: projectPath },
      config,
    );
    config = projectLoaded.config;
    warning = joinWarnings(warning, projectLoaded.warning);
    scope = projectLoaded.scope;
  }

  return { config, scope, warning };
}

/** Write the seed workspace list when no file exists yet. */
function materializeWorkspaceFile(path: string): void {
  if (existsSync(path)) return;
  writeWorkspaceFile(path, DEFAULT_WORKSPACE_CONFIG.workspaces);
}

function writeWorkspaceFile(path: string, workspaces: WorkspaceEntry[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const payload: WorkspaceFile = { workspaces };
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

function loadWorkspaceFile(
  path: string,
  scope: WorkspaceScope,
  base: WorkspaceConfig = DEFAULT_WORKSPACE_CONFIG,
): LoadedWorkspaceConfig {
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

  const result = workspaceFileSchema.safeParse(parsed);
  if (!result.success) {
    return {
      config: base,
      scope,
      warning: `invalid ${path}: ${result.error.issues[0]?.message ?? "schema error"}`,
    };
  }

  const { workspaces, warning: reservedWarning } = dropReservedWorkspaceIds(result.data.workspaces);
  const duplicateWarning = duplicateWorkspaceIdWarning(workspaces, path);
  const config = workspaces?.length
    ? { workspaces: mergeWorkspaceEntries(base.workspaces, workspaces) }
    : base;
  return {
    config,
    scope,
    warning: joinWarnings(reservedWarning, duplicateWarning),
  };
}

function dropReservedWorkspaceIds(entries: WorkspaceEntry[] | undefined): {
  workspaces?: WorkspaceEntry[];
  warning?: string;
} {
  if (!entries || entries.length === 0) return {};
  const reserved = entries.filter((entry) => isReservedWorkspaceId(entry.id));
  if (reserved.length === 0) return { workspaces: entries };
  return {
    workspaces: entries.filter((entry) => !isReservedWorkspaceId(entry.id)),
    warning: `reserved workspace id(s) ignored: ${reserved.map((entry) => entry.id).join(", ")}`,
  };
}

function joinWarnings(...parts: Array<string | undefined>): string | undefined {
  const text = parts.filter(Boolean).join("; ");
  return text || undefined;
}

function duplicateWorkspaceIdWarning(
  entries: WorkspaceEntry[] | undefined,
  filePath: string,
): string | undefined {
  if (!entries || entries.length === 0) return undefined;
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) duplicates.add(entry.id);
    seen.add(entry.id);
  }
  if (duplicates.size === 0) return undefined;
  return `duplicate workspace ids in ${filePath}: ${[...duplicates].join(", ")} (last wins)`;
}

/** Merge workspace entries by `id` (override in place, append new ids). */
export function mergeWorkspaceConfig(
  base: WorkspaceConfig,
  override: WorkspaceFile,
): WorkspaceConfig {
  if (!override.workspaces || override.workspaces.length === 0) {
    return base;
  }
  return { workspaces: mergeWorkspaceEntries(base.workspaces, override.workspaces) };
}

export function mergeWorkspaceEntries(
  base: WorkspaceEntry[],
  overrides: WorkspaceEntry[],
): WorkspaceEntry[] {
  const byId = new Map(base.map((w) => [w.id, w]));
  const order = base.map((w) => w.id);

  for (const override of overrides) {
    if (!byId.has(override.id)) order.push(override.id);
    byId.set(override.id, { ...byId.get(override.id), ...override });
  }

  return order.map((id) => byId.get(id)!);
}

/**
 * Persist the full workspace list to the file for the active scope.
 * Returns the status-bar label (`user`, `project`, or custom path).
 */
export function saveWorkspaceConfig(config: WorkspaceConfig, scope: WorkspaceScope): string {
  writeWorkspaceFile(scope.path, config.workspaces);
  return workspaceScopeLabel(scope);
}
