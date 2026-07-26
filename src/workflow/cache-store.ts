import { createHash } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, isEnoent } from "./fs-util";
import type { GateStep, StepResult, WorkflowSpec } from "./types";

export const WORKFLOW_CACHE_DIR = ".steamtrain/cache";
export const WORKFLOW_CACHE_VERSION = 2;

export interface WorkflowCacheKey {
  workflow: string;
  input: string;
  cwd: string;
  specHash: string;
  /** Serialized input params; included in the cache hash so different values produce different caches. */
  params?: string;
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
  params?: Record<string, string | number | boolean>,
): WorkflowCacheKey {
  const paramsStr =
    params && Object.keys(params).length > 0
      ? JSON.stringify(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)))
      : undefined;
  return { workflow, input, cwd, specHash: hashWorkflowSpec(spec), params: paramsStr };
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
    .update(`${key.workflow}\0${key.cwd}\0${key.input}\0${key.specHash}\0${key.params ?? ""}`)
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
  await atomicWriteFile(target, `${JSON.stringify(payload, null, 2)}\n`);
}

export async function clearWorkflowCache(rootDir: string, key: WorkflowCacheKey): Promise<void> {
  const fileName = workflowCacheFileName(key);
  const filePath = join(rootDir, fileName);
  try {
    await rm(filePath, { force: true });
    const entries = await readdir(rootDir);
    await Promise.all(
      entries
        .filter((name) => name.startsWith(fileName) && name.endsWith(".tmp"))
        .map((name) => rm(join(rootDir, name), { force: true })),
    );
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
  // `noCache` results (human-approval checkpoints) are never persisted, so a
  // resumed run always re-asks the decision instead of replaying it from disk.
  if (!store || !key || cached || !result.ok || result.noCache) return;
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

  let gate: StepResult["gate"];
  if (r.gate !== undefined) {
    if (!r.gate || typeof r.gate !== "object") return undefined;
    if (typeof r.gate.passed !== "boolean") return undefined;
    if (
      r.gate.onFalse !== undefined &&
      r.gate.onFalse !== "continue" &&
      r.gate.onFalse !== "fail" &&
      r.gate.onFalse !== "stop"
    ) {
      return undefined;
    }
    gate = { passed: r.gate.passed, onFalse: r.gate.onFalse as GateStep["onFalse"] };
  }

  let childResults: StepResult[] | undefined;
  if (r.childResults !== undefined) {
    if (!Array.isArray(r.childResults)) return undefined;
    childResults = [];
    for (let i = 0; i < r.childResults.length; i++) {
      const child = r.childResults[i];
      const childId =
        child && typeof child === "object" && "stepId" in child && typeof child.stepId === "string"
          ? child.stepId
          : `${stepId}[${i}]`;
      const valid = validateStepResult(childId, child);
      if (!valid) return undefined;
      childResults.push(valid);
    }
  }

  return {
    stepId: typeof r.stepId === "string" ? r.stepId : stepId,
    ok: r.ok,
    output: r.output,
    durationMs: r.durationMs,
    target: typeof r.target === "string" ? r.target : undefined,
    error: typeof r.error === "string" ? r.error : undefined,
    costUsd: typeof r.costUsd === "number" ? r.costUsd : undefined,
    attempts: typeof r.attempts === "number" ? r.attempts : undefined,
    // Session continuity: a replayed source must still expose its recorded
    // session for `continue:` steps, and a replayed continuer must expose its
    // lineage for the staleness check.
    sessionId: typeof r.sessionId === "string" ? r.sessionId : undefined,
    resumedSessionId: typeof r.resumedSessionId === "string" ? r.resumedSessionId : undefined,
    iteration: typeof r.iteration === "number" ? r.iteration : undefined,
    items: Array.isArray(r.items)
      ? r.items.filter((i): i is string => typeof i === "string")
      : undefined,
    // Any JSON value is a valid parsed structured output; absent stays absent.
    json: r.json,
    skipped: typeof r.skipped === "boolean" ? r.skipped : undefined,
    dependencyFailed: typeof r.dependencyFailed === "string" ? r.dependencyFailed : undefined,
    edited: typeof r.edited === "boolean" ? r.edited : undefined,
    item: r.item && typeof r.item === "object" ? (r.item as StepResult["item"]) : undefined,
    parentStepId: typeof r.parentStepId === "string" ? r.parentStepId : undefined,
    // Workspace attach/merge and cost attribution need these on cache reload.
    tokens: r.tokens && typeof r.tokens === "object" ? (r.tokens as StepResult["tokens"]) : undefined,
    worktree:
      r.worktree && typeof r.worktree === "object"
        ? (r.worktree as StepResult["worktree"])
        : undefined,
    artifacts: Array.isArray(r.artifacts) ? r.artifacts : undefined,
    api: typeof r.api === "string" ? r.api : undefined,
    model: typeof r.model === "string" ? r.model : undefined,
    gate,
    childResults,
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
