import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "./fs-util";
import { z } from "zod";
import { WORKSPACE_CONFIG_DIR } from "../workspace";
import { BUNDLED_WORKFLOWS } from "./bundled";
import { type WorkflowStepOverrides, applyWorkflowStepOverrides } from "./overrides";
import {
  type WorkflowSpec,
  type WorkflowSpecInput,
  validateWorkflow,
  workflowSpecSchema,
} from "./types";

export const WORKFLOWS_FILENAME = "workflows.json";

export type WorkflowSourceKind = "bundled" | "user" | "project";

export interface WorkflowCatalogEntry {
  name: string;
  spec: WorkflowSpec;
  source: WorkflowSourceKind;
}

export interface LoadedWorkflowCatalog {
  workflows: Record<string, WorkflowSpec>;
  sources: Record<string, WorkflowSourceKind>;
  /** Non-fatal problems encountered while loading. */
  warning?: string;
}

export interface LoadWorkflowCatalogOptions {
  home?: string;
  /** Workflows from project `steamtrain.json`. */
  projectWorkflows?: Record<string, WorkflowSpec>;
}

const workflowsFileSchema = z
  .object({
    workflows: z.record(workflowSpecSchema),
  })
  .strict();

/** Default path: `~/.steamtrain/workflows.json`. */
export function userWorkflowsPath(home: string = homedir()): string {
  return join(home, WORKSPACE_CONFIG_DIR, WORKFLOWS_FILENAME);
}

/** Merge bundled, user, and project workflows. Each name appears once; project wins over user over bundled. */
export function loadWorkflowCatalog(
  options: LoadWorkflowCatalogOptions = {},
): LoadedWorkflowCatalog {
  const home = options.home ?? homedir();
  let workflows: Record<string, WorkflowSpec> = { ...BUNDLED_WORKFLOWS };
  const sources: Record<string, WorkflowSourceKind> = {};
  for (const name of Object.keys(BUNDLED_WORKFLOWS)) {
    sources[name] = "bundled";
  }

  let warning: string | undefined;
  const userLoaded = loadUserWorkflowsFile(home);
  warning = joinWarnings(warning, userLoaded.warning);
  const userMerged = mergeWorkflowMap(workflows, sources, userLoaded.workflows, "user");
  workflows = userMerged.workflows;
  Object.assign(sources, userMerged.sources);
  warning = joinWarnings(warning, userMerged.warning);

  const projectMerged = mergeWorkflowMap(workflows, sources, options.projectWorkflows, "project");
  workflows = projectMerged.workflows;
  Object.assign(sources, projectMerged.sources);
  warning = joinWarnings(warning, projectMerged.warning);

  return { workflows, sources, warning };
}

export function workflowCatalogEntries(catalog: LoadedWorkflowCatalog): WorkflowCatalogEntry[] {
  return Object.entries(catalog.workflows)
    .map(([name, spec]) => ({
      name,
      spec,
      source: catalog.sources[name] ?? "bundled",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface SaveSessionWorkflowsResult {
  /** Path written when at least one workflow was saved. */
  path?: string;
  saved: string[];
  skipped: Array<{ name: string; reason: string }>;
  unchanged: string[];
}

export interface SaveSessionWorkflowsOptions {
  catalog: LoadedWorkflowCatalog;
  sessionOverrides: Record<string, WorkflowStepOverrides>;
  home?: string;
}

/** Collect session step overrides that should be written to the user workflows file. */
export function collectSessionWorkflowSaves(
  options: SaveSessionWorkflowsOptions,
): Omit<SaveSessionWorkflowsResult, "path"> & { toSave: Record<string, WorkflowSpec> } {
  const home = options.home ?? homedir();
  const userOnDisk = readUserWorkflowsFile(home).workflows ?? {};
  const toSave: Record<string, WorkflowSpec> = {};
  const saved: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const unchanged: string[] = [];

  for (const [name, overrides] of Object.entries(options.sessionOverrides)) {
    if (!overrides || Object.keys(overrides).length === 0) continue;

    const source = options.catalog.sources[name];
    const catalogSpec = options.catalog.workflows[name];
    if (!source || !catalogSpec) {
      skipped.push({ name, reason: "unknown workflow" });
      continue;
    }

    if (source === "project") {
      skipped.push({ name, reason: "project workflows are edited in steamtrain.json" });
      continue;
    }

    const effective = applyWorkflowStepOverrides(catalogSpec, overrides);
    const baseline =
      source === "bundled" ? BUNDLED_WORKFLOWS[name] : (userOnDisk[name] ?? catalogSpec);

    if (!baseline) {
      skipped.push({ name, reason: "missing baseline workflow" });
      continue;
    }

    if (workflowSpecsEqual(effective, baseline)) {
      unchanged.push(name);
      continue;
    }

    toSave[name] = effective;
    saved.push(name);
  }

  return { toSave, saved, skipped, unchanged };
}

/** Persist session workflow changes to `~/.steamtrain/workflows.json`. */
export async function saveSessionWorkflowsToUser(
  options: SaveSessionWorkflowsOptions,
): Promise<SaveSessionWorkflowsResult> {
  const home = options.home ?? homedir();
  const collected = collectSessionWorkflowSaves(options);
  if (collected.saved.length === 0) {
    return {
      saved: collected.saved,
      skipped: collected.skipped,
      unchanged: collected.unchanged,
    };
  }

  const userOnDisk = readUserWorkflowsFile(home).workflows ?? {};
  const path = await writeUserWorkflowsFile(home, { ...userOnDisk, ...collected.toSave });
  return {
    path,
    saved: collected.saved,
    skipped: collected.skipped,
    unchanged: collected.unchanged,
  };
}

export function workflowSpecsEqual(a: WorkflowSpec, b: WorkflowSpec): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface SaveUserWorkflowResult {
  ok: boolean;
  path?: string;
  /** True when an existing workflow of the same name was replaced. */
  replaced?: boolean;
  error?: string;
}

/**
 * Persist a single workflow to `~/.steamtrain/workflows.json`, merging it next
 * to any existing user workflows. The spec is validated first (same rules as the
 * engine) so we never write a workflow that can't run. The stored `name` is
 * taken from `name`, not from the spec body, so the catalog key stays canonical.
 */
export async function saveUserWorkflow(
  name: string,
  spec: WorkflowSpec,
  home: string = homedir(),
): Promise<SaveUserWorkflowResult> {
  const full: WorkflowSpec = { ...spec, name };
  const valid = validateWorkflow(full);
  if (!valid.ok) return { ok: false, error: valid.error };

  const userOnDisk = readUserWorkflowsFile(home).workflows ?? {};
  const replaced = Boolean(userOnDisk[name]);
  const path = await writeUserWorkflowsFile(home, { ...userOnDisk, [name]: full });
  return { ok: true, path, replaced };
}

export interface DeleteUserWorkflowResult {
  ok: boolean;
  path?: string;
  /** True when the workflow existed and was removed. */
  removed?: boolean;
  error?: string;
}

/**
 * Remove a single workflow from `~/.steamtrain/workflows.json`. Only user-file
 * workflows can be deleted here; bundled and project workflows live elsewhere.
 * Returns `removed: false` (still ok) when no such user workflow exists.
 */
export async function deleteUserWorkflow(
  name: string,
  home: string = homedir(),
): Promise<DeleteUserWorkflowResult> {
  const userOnDisk = readUserWorkflowsFile(home).workflows ?? {};
  if (!userOnDisk[name]) return { ok: true, removed: false };

  const { [name]: _removed, ...rest } = userOnDisk;
  const path = await writeUserWorkflowsFile(home, rest);
  return { ok: true, path, removed: true };
}

export function readUserWorkflowsFile(home: string = homedir()): {
  workflows?: Record<string, WorkflowSpec>;
  warning?: string;
} {
  return loadUserWorkflowsFile(home);
}

function loadUserWorkflowsFile(home: string): {
  workflows?: Record<string, WorkflowSpec>;
  warning?: string;
} {
  const path = userWorkflowsPath(home);
  if (!existsSync(path)) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return {
      warning: `could not parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const result = workflowsFileSchema.safeParse(parsed);
  if (!result.success) {
    return {
      warning: `invalid ${path}: ${result.error.issues[0]?.message ?? "schema error"}`,
    };
  }

  // Inject the map key as `name` so every loaded spec is a complete WorkflowSpec.
  const workflows: Record<string, WorkflowSpec> = {};
  for (const [name, spec] of Object.entries(result.data.workflows)) {
    workflows[name] = { ...spec, name };
  }
  return { workflows };
}

/** Validate and merge workflow specs, recording the source for each name. */
export function mergeWorkflowMap(
  base: Record<string, WorkflowSpec>,
  baseSources: Record<string, WorkflowSourceKind>,
  override: Record<string, WorkflowSpecInput> | undefined,
  overrideSource: WorkflowSourceKind,
): {
  workflows: Record<string, WorkflowSpec>;
  sources: Record<string, WorkflowSourceKind>;
  warning?: string;
} {
  if (!override || Object.keys(override).length === 0) {
    return { workflows: base, sources: { ...baseSources } };
  }

  const workflows = { ...base };
  const sources = { ...baseSources };
  const warnings: string[] = [];

  for (const [name, spec] of Object.entries(override)) {
    const full = { ...spec, name };
    const valid = validateWorkflow(full);
    if (!valid.ok) {
      warnings.push(`workflow '${name}' ignored: ${valid.error}`);
      continue;
    }
    workflows[name] = full;
    sources[name] = overrideSource;
  }

  return {
    workflows,
    sources,
    warning: warnings.length > 0 ? warnings.join("; ") : undefined,
  };
}

function joinWarnings(...parts: Array<string | undefined>): string | undefined {
  const text = parts.filter(Boolean).join("; ");
  return text || undefined;
}

async function writeUserWorkflowsFile(home: string, workflows: Record<string, WorkflowSpec>): Promise<string> {
  const path = userWorkflowsPath(home);
  await atomicWriteFile(path, `${JSON.stringify({ workflows }, null, 2)}\n`);
  return path;
}
