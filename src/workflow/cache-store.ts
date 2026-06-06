import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StepResult, WorkflowSpec } from "./types";

export const WORKFLOW_CACHE_DIR = ".steamtrain/cache";
export const WORKFLOW_CACHE_VERSION = 2;

export interface WorkflowCacheKey {
  workflow: string;
  input: string;
  cwd: string;
  specHash: string;
}

interface WorkflowCacheFile {
  version: typeof WORKFLOW_CACHE_VERSION;
  workflow: string;
  cwd: string;
  inputHash: string;
  specHash: string;
  updatedAt: number;
  steps: Record<string, StepResult>;
}

export interface WorkflowCacheStore {
  rootDir: string;
  load(key: WorkflowCacheKey): Promise<Map<string, StepResult>>;
  save(key: WorkflowCacheKey, cache: Map<string, StepResult>): Promise<void>;
  clear(key: WorkflowCacheKey): Promise<void>;
  clearAll(): Promise<void>;
}

export function workflowCacheKey(
  workflow: string,
  input: string,
  cwd: string,
  spec: WorkflowSpec,
): WorkflowCacheKey {
  return { workflow, input, cwd, specHash: hashWorkflowSpec(spec) };
}

export function hashWorkflowCacheInput(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Stable hash of the workflow definition so cache is invalidated when the spec changes. */
export function hashWorkflowSpec(spec: WorkflowSpec): string {
  return createHash("sha256").update(stableStringify(spec)).digest("hex");
}

export function workflowCacheFileName(key: WorkflowCacheKey): string {
  const digest = createHash("sha256")
    .update(`${key.workflow}\0${key.cwd}\0${key.input}`)
    .digest("hex");
  return `${digest}.json`;
}

export function createWorkflowCacheStore(rootDir: string = WORKFLOW_CACHE_DIR): WorkflowCacheStore {
  return {
    rootDir,
    load(key) {
      return loadWorkflowCache(rootDir, key);
    },
    save(key, cache) {
      return saveWorkflowCache(rootDir, key, cache);
    },
    clear(key) {
      return clearWorkflowCache(rootDir, key);
    },
    clearAll() {
      return clearAllWorkflowCaches(rootDir);
    },
  };
}

export async function loadWorkflowCache(
  rootDir: string,
  key: WorkflowCacheKey,
): Promise<Map<string, StepResult>> {
  try {
    const file = await readFile(join(rootDir, workflowCacheFileName(key)), "utf8");
    return parseWorkflowCacheFile(file, key);
  } catch (err) {
    if (isEnoent(err)) return new Map();
    throw err;
  }
}

export async function saveWorkflowCache(
  rootDir: string,
  key: WorkflowCacheKey,
  cache: Map<string, StepResult>,
): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  const payload: WorkflowCacheFile = {
    version: WORKFLOW_CACHE_VERSION,
    workflow: key.workflow,
    cwd: key.cwd,
    inputHash: hashWorkflowCacheInput(key.input),
    specHash: key.specHash,
    updatedAt: Date.now(),
    steps: Object.fromEntries(cache),
  };
  const target = join(rootDir, workflowCacheFileName(key));
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(temp, target);
}

export async function clearWorkflowCache(rootDir: string, key: WorkflowCacheKey): Promise<void> {
  const base = join(rootDir, workflowCacheFileName(key));
  try {
    await rm(base, { force: true });
    await rm(`${base}.${process.pid}.tmp`, { force: true });
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
}

export async function clearAllWorkflowCaches(rootDir: string): Promise<void> {
  try {
    const entries = await readdir(rootDir);
    await Promise.all(
      entries
        .filter((name) => name.endsWith(".json") || name.endsWith(".tmp"))
        .map((name) => rm(join(rootDir, name), { force: true })),
    );
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
}

/** Persist successful, non-replayed step completions to disk. */
export async function persistWorkflowStepDone(
  store: WorkflowCacheStore | undefined,
  key: WorkflowCacheKey | undefined,
  cache: Map<string, StepResult>,
  stepId: string,
  result: StepResult,
  cached: boolean,
): Promise<void> {
  if (!store || !key || cached || !result.ok) return;
  cache.set(stepId, result);
  await store.save(key, cache);
}

function parseWorkflowCacheFile(file: string, key: WorkflowCacheKey): Map<string, StepResult> {
  let parsed: WorkflowCacheFile;
  try {
    parsed = JSON.parse(file) as WorkflowCacheFile;
  } catch {
    return new Map();
  }
  if (parsed.version !== WORKFLOW_CACHE_VERSION) return new Map();
  if (parsed.workflow !== key.workflow || parsed.cwd !== key.cwd) return new Map();
  if (parsed.inputHash !== hashWorkflowCacheInput(key.input)) return new Map();
  if (parsed.specHash !== key.specHash) return new Map();

  const out = new Map<string, StepResult>();
  for (const [stepId, result] of Object.entries(parsed.steps ?? {})) {
    const valid = validateStepResult(stepId, result);
    if (valid) out.set(stepId, valid);
  }
  return out;
}

function validateStepResult(stepId: string, value: unknown): StepResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Partial<StepResult>;
  if (typeof r.ok !== "boolean" || typeof r.output !== "string") return undefined;
  if (typeof r.durationMs !== "number") return undefined;
  return { ...r, stepId: r.stepId ?? stepId, ok: r.ok, output: r.output, durationMs: r.durationMs };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function isEnoent(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && err.code === "ENOENT");
}
