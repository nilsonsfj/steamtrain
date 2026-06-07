import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { WORKSPACE_CONFIG_DIR } from "../workspace";
import { BUNDLED_WORKFLOWS } from "./bundled";
import { type WorkflowSpec, validateWorkflow, workflowSpecSchema } from "./types";

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

/** Merge bundled, user, and project workflows (later sources override by name). */
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

  const projectMerged = mergeWorkflowMap(
    workflows,
    sources,
    options.projectWorkflows,
    "project",
  );
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

  return { workflows: result.data.workflows };
}

/** Validate and merge workflow specs, recording the source for each name. */
export function mergeWorkflowMap(
  base: Record<string, WorkflowSpec>,
  baseSources: Record<string, WorkflowSourceKind>,
  override: Record<string, WorkflowSpec> | undefined,
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
