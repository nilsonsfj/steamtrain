import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { WorkflowSpec } from "../workflow/types";
import { validateWorkflow } from "../workflow/types";
import { loadConfig, projectConfigPath } from "./load";

/**
 * Read/write the **project** workflow layer — the `workflows` section of a
 * project's `steamtrain.json`. Unlike the user file (`~/.steamtrain/workflows.json`,
 * handled in `workflow/catalog.ts`), `steamtrain.json` also carries binaries,
 * timeouts, and concurrency, so every write here is a read-modify-write that
 * preserves all other top-level keys and only touches `workflows`. The spec is
 * validated with the same rules the engine enforces, and the write is atomic
 * (temp file + rename) so a crash never leaves a half-written config.
 *
 * Every function takes the **config file path** (not a directory), so authoring
 * targets the exact `steamtrain.json` the rest of the process loaded —
 * including a `--config-file` path outside the working directory.
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

/**
 * Read the project workflows from a `steamtrain.json`, keyed by name. Goes
 * through the engine's own {@link loadConfig}, so the result is byte-for-byte
 * what the engine sees at startup: a file the strict schema rejects (e.g. an
 * unknown top-level key) yields no project workflows here too, and a
 * semantically invalid entry is dropped while the valid ones survive — no
 * divergence between the live catalog and a fresh run.
 */
export function loadProjectWorkflows(
  configPath: string = projectConfigPath(),
): Record<string, WorkflowSpec> {
  if (!existsSync(configPath)) return {};
  return loadConfig({ customPath: configPath }).config.workflows ?? {};
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
  configPath: string = projectConfigPath(),
): SaveProjectWorkflowResult {
  const full: WorkflowSpec = { ...spec, name };
  const valid = validateWorkflow(full);
  if (!valid.ok) return { ok: false, error: valid.error };

  const raw = readRawConfig(configPath);
  if (raw === undefined) {
    return { ok: false, error: `could not parse ${configPath}` };
  }

  // `raw` is null when the file does not exist yet — start from an empty config.
  const base = raw ?? {};
  const existing = isObject(base.workflows) ? (base.workflows as Record<string, unknown>) : {};
  const replaced = Boolean(existing[name]);
  const next = { ...base, workflows: { ...existing, [name]: full } };
  writeRawConfig(configPath, next);
  return { ok: true, path: configPath, replaced };
}

/**
 * Remove a single workflow from the project `steamtrain.json`, preserving every
 * other config key. Returns `removed: false` (still ok) when no such project
 * workflow exists.
 */
export function deleteProjectWorkflow(
  name: string,
  configPath: string = projectConfigPath(),
): DeleteProjectWorkflowResult {
  const raw = readRawConfig(configPath);
  if (raw === undefined) return { ok: false, error: `could not parse ${configPath}` };
  if (!raw) return { ok: true, removed: false };

  const existing = isObject(raw.workflows) ? (raw.workflows as Record<string, unknown>) : {};
  if (!existing[name]) return { ok: true, removed: false };

  const { [name]: _removed, ...rest } = existing;
  const next = { ...raw, workflows: rest };
  writeRawConfig(configPath, next);
  return { ok: true, path: configPath, removed: true };
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
