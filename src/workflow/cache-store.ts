import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StepResult } from "./types";

export const WORKFLOW_CACHE_DIR = ".steamtrain/cache";
export const WORKFLOW_CACHE_VERSION = 1;

export interface WorkflowCacheKey {
  workflow: string;
  input: string;
  cwd: string;
}

interface WorkflowCacheFile {
  version: typeof WORKFLOW_CACHE_VERSION;
  workflow: string;
  cwd: string;
  inputHash: string;
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

export function workflowCacheKey(workflow: string, input: string, cwd: string): WorkflowCacheKey {
  return { workflow, input, cwd };
}

export function hashWorkflowCacheInput(input: string): string {
  return createHash("sha256").update(input).digest("hex");
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
    updatedAt: Date.now(),
    steps: Object.fromEntries(cache),
  };
  const target = join(rootDir, workflowCacheFileName(key));
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(temp, target);
}

export async function clearWorkflowCache(rootDir: string, key: WorkflowCacheKey): Promise<void> {
  try {
    await rm(join(rootDir, workflowCacheFileName(key)), { force: true });
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
}

export async function clearAllWorkflowCaches(rootDir: string): Promise<void> {
  try {
    const entries = await readdir(rootDir);
    await Promise.all(
      entries
        .filter((name) => name.endsWith(".json"))
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
  const parsed = JSON.parse(file) as WorkflowCacheFile;
  if (parsed.version !== WORKFLOW_CACHE_VERSION) return new Map();
  if (parsed.workflow !== key.workflow || parsed.cwd !== key.cwd) return new Map();
  if (parsed.inputHash !== hashWorkflowCacheInput(key.input)) return new Map();
  return new Map(Object.entries(parsed.steps ?? {}));
}

function isEnoent(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && err.code === "ENOENT");
}
