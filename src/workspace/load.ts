import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE_CONFIG } from "./defaults";
import {
  type WorkspaceConfig,
  type WorkspaceEntry,
  type WorkspaceFile,
  workspaceFileSchema,
} from "./types";

export const WORKSPACE_CONFIG_DIR = ".steamtrain";
export const WORKSPACE_CONFIG_FILENAME = "workspace.json";

export interface LoadedWorkspaceConfig {
  config: WorkspaceConfig;
  /** Absolute path the config came from, or a human note about the fallback. */
  source: string;
  /** Non-fatal problem encountered while loading (kept defaults). */
  warning?: string;
}

/** Default path: `~/.steamtrain/workspace.json`. */
export function workspaceConfigPath(home: string = homedir()): string {
  return join(home, WORKSPACE_CONFIG_DIR, WORKSPACE_CONFIG_FILENAME);
}

/** Load defaults, then merge `~/.steamtrain/workspace.json` when present. */
export function loadWorkspaceConfig(home: string = homedir()): LoadedWorkspaceConfig {
  const path = workspaceConfigPath(home);
  if (!existsSync(path)) {
    return { config: DEFAULT_WORKSPACE_CONFIG, source: "built-in workspace defaults" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return {
      config: DEFAULT_WORKSPACE_CONFIG,
      source: "built-in workspace defaults",
      warning: `could not parse ${WORKSPACE_CONFIG_FILENAME}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const result = workspaceFileSchema.safeParse(parsed);
  if (!result.success) {
    return {
      config: DEFAULT_WORKSPACE_CONFIG,
      source: "built-in workspace defaults",
      warning: `invalid ${WORKSPACE_CONFIG_FILENAME}: ${result.error.issues[0]?.message ?? "schema error"}`,
    };
  }

  const duplicateWarning = duplicateWorkspaceIdWarning(result.data.workspaces);
  const config = mergeWorkspaceConfig(DEFAULT_WORKSPACE_CONFIG, result.data);
  return { config, source: path, warning: duplicateWarning };
}

function duplicateWorkspaceIdWarning(entries: WorkspaceEntry[] | undefined): string | undefined {
  if (!entries || entries.length === 0) return undefined;
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) duplicates.add(entry.id);
    seen.add(entry.id);
  }
  if (duplicates.size === 0) return undefined;
  return `duplicate workspace ids in ${WORKSPACE_CONFIG_FILENAME}: ${[...duplicates].join(", ")} (last wins)`;
}

/** Merge user workspace entries by `id` onto defaults (override in place, append new ids). */
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
