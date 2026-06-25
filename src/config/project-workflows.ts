import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type WorkflowSpec, validateWorkflow, workflowSpecSchema } from "../workflow/types";
import { projectConfigPath } from "./load";

/**
 * Read/write the **project** workflow layer — the `workflows` section of a
 * project's `steamtrain.json`. Unlike the user file (`~/.steamtrain/workflows.json`,
 * handled in `workflow/catalog.ts`), `steamtrain.json` also carries binaries,
 * timeouts, and concurrency, so every write here is a read-modify-write that
 * preserves all other top-level keys and only touches `workflows`. The spec is
 * validated with the same rules the engine enforces, and the write is atomic
 * (temp file + rename) so a crash never leaves a half-written config.
 */

export interface SaveProjectWorkflowResult {
  ok: boolean;
  path?: string;
  /** True when an existing project workflow of the same name was replaced. */
  replaced?: boolean;
  error?: string;
}

export interface DeleteProjectWorkflowResult {
  ok: boolean;
  path?: string;
  /** True when the workflow existed in the project file and was removed. */
  removed?: boolean;
  error?: string;
}

/** Read the `workflows` map out of a project `steamtrain.json`, keyed by name. */
export function loadProjectWorkflows(cwd: string = process.cwd()): Record<string, WorkflowSpec> {
  const path = projectConfigPath(cwd);
  const raw = readRawConfig(path);
  if (!raw) return {};

  const workflowsValue = (raw as { workflows?: unknown }).workflows;
  if (!workflowsValue || typeof workflowsValue !== "object") return {};

  const out: Record<string, WorkflowSpec> = {};
  for (const [name, value] of Object.entries(workflowsValue as Record<string, unknown>)) {
    const parsed = workflowSpecSchema.safeParse(value);
    if (!parsed.success) continue;
    out[name] = { ...parsed.data, name };
  }
  return out;
}

/**
 * Persist a single workflow into the project `steamtrain.json`, merging it next
 * to any existing project workflows and preserving every other config key. The
 * stored `name` is taken from `name`, not the spec body, so the catalog key
 * stays canonical.
 */
export function saveProjectWorkflow(
  name: string,
  spec: WorkflowSpec,
  cwd: string = process.cwd(),
): SaveProjectWorkflowResult {
  const full: WorkflowSpec = { ...spec, name };
  const valid = validateWorkflow(full);
  if (!valid.ok) return { ok: false, error: valid.error };

  const path = projectConfigPath(cwd);
  const raw = readRawConfig(path);
  if (raw === undefined) {
    return { ok: false, error: `could not parse ${path}` };
  }

  const base = raw ?? {};
  const existing = isObject(base.workflows) ? (base.workflows as Record<string, unknown>) : {};
  const replaced = Boolean(existing[name]);
  const next = { ...base, workflows: { ...existing, [name]: full } };
  writeRawConfig(path, next);
  return { ok: true, path, replaced };
}

/**
 * Remove a single workflow from the project `steamtrain.json`, preserving every
 * other config key. Returns `removed: false` (still ok) when no such project
 * workflow exists.
 */
export function deleteProjectWorkflow(
  name: string,
  cwd: string = process.cwd(),
): DeleteProjectWorkflowResult {
  const path = projectConfigPath(cwd);
  const raw = readRawConfig(path);
  if (raw === undefined) return { ok: false, error: `could not parse ${path}` };
  if (!raw) return { ok: true, removed: false };

  const existing = isObject(raw.workflows) ? (raw.workflows as Record<string, unknown>) : {};
  if (!existing[name]) return { ok: true, removed: false };

  const { [name]: _removed, ...rest } = existing;
  const next = { ...raw, workflows: rest };
  writeRawConfig(path, next);
  return { ok: true, path, removed: true };
}

/**
 * Read and JSON-parse a config file as a plain object. Returns `null` when the
 * file does not exist, `undefined` when it exists but cannot be parsed *or*
 * holds a non-object top-level value (e.g. an array) — so callers refuse to
 * clobber a broken config rather than silently discarding its contents — and
 * the object otherwise.
 */
function readRawConfig(path: string): Record<string, unknown> | null | undefined {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeRawConfig(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
