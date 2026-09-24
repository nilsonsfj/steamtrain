import { createHash } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { WorkflowEvent } from "./events";
import { atomicWriteFile, isEnoent } from "./fs-util";
import {
  type LoopProgress,
  cacheLoopProgress,
  parseLoopProgress,
  setCacheLoopProgress,
} from "./loop-progress";
import { type ProjectLockOptions, withStateDirLock } from "./project-lock";
import { migrateStateVersion } from "./state-migrate";
import type { GateStep, StepResult, WorkflowSpec } from "./types";

export const WORKFLOW_CACHE_DIR = ".steamtrain/cache";
export const WORKFLOW_CACHE_VERSION = 2;

/** Injectable lock for tests; defaults to the cross-process project state lock. */
export type CacheLockFn = <T>(
  stateSubdir: string,
  fn: () => Promise<T>,
  opts?: ProjectLockOptions,
) => Promise<T>;

let cacheLock: CacheLockFn = withStateDirLock;

/** Override the cache writer lock (tests). Pass `undefined` to restore default. */
export function setWorkflowCacheLock(lock: CacheLockFn | undefined): void {
  cacheLock = lock ?? withStateDirLock;
}

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
  /** Where the run's loops were when these entries were saved; see `cacheLoopProgress`. */
  loops?: LoopProgress;
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

/**
 * The entries each run's cache map held when it was last saved. Only the
 * engine removes entries from a run's map (an edited step, a loop jump's
 * region), so one that was saved and is gone now was dropped on purpose.
 */
const lastSaved = new WeakMap<Map<string, StepResult>, Set<string>>();

export async function loadWorkflowCache(
  rootDir: string,
  key: WorkflowCacheKey,
): Promise<Map<string, StepResult>> {
  const cache = await loadWorkflowCacheUnlocked(rootDir, key);
  // What is on disk now is this map's baseline: an entry the engine drops
  // before the first save must not come back from disk either.
  lastSaved.set(cache, new Set(cache.keys()));
  return cache;
}

export async function saveWorkflowCache(
  rootDir: string,
  key: WorkflowCacheKey,
  cache: Map<string, StepResult>,
): Promise<void> {
  await cacheLock(rootDir, async () => {
    // Read-merge-write under the project lock so concurrent step completions
    // (same process overlapping awaits, or a second steamtrain instance) keep
    // each other's entries instead of last-writer-wins. What this map dropped
    // since its last save stays dropped: merged back from disk, a loop pass
    // or an edited step would replay its superseded result.
    const dropped = [...(lastSaved.get(cache) ?? [])].filter((stepId) => !cache.has(stepId));
    const onDisk = await loadWorkflowCacheUnlocked(rootDir, key);
    const merged = new Map(onDisk);
    for (const stepId of dropped) merged.delete(stepId);
    for (const [stepId, result] of cache) merged.set(stepId, result);
    for (const [stepId, result] of merged) cache.set(stepId, result);
    // The loop progress this map's run recorded goes with its entries.
    setCacheLoopProgress(cache, cacheLoopProgress(cache) ?? cacheLoopProgress(onDisk));
    await writeWorkflowCacheFile(rootDir, key, merged, cacheLoopProgress(cache));
    lastSaved.set(cache, new Set(merged.keys()));
  });
}

export async function clearWorkflowCache(rootDir: string, key: WorkflowCacheKey): Promise<void> {
  await cacheLock(rootDir, async () => {
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
  });
}

export async function clearAllWorkflowCaches(rootDir: string): Promise<void> {
  await cacheLock(rootDir, async () => {
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
  });
}

async function writeWorkflowCacheFile(
  rootDir: string,
  key: WorkflowCacheKey,
  cache: Map<string, StepResult>,
  loops: LoopProgress | undefined,
): Promise<void> {
  const payload: WorkflowCacheFile = {
    version: WORKFLOW_CACHE_VERSION,
    workflow: key.workflow,
    cwd: key.cwd,
    inputHash: hashWorkflowCacheInput(key.input),
    specHash: key.specHash,
    updatedAt: Date.now(),
    steps: Object.fromEntries(cache),
    loops,
  };
  const target = join(rootDir, workflowCacheFileName(key));
  await atomicWriteFile(target, `${JSON.stringify(payload, null, 2)}\n`);
}

async function loadWorkflowCacheUnlocked(
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

/**
 * Whether the engine changed the shared cache map before this event in a way
 * no finished step saves: it dropped an edited step's entry, or on a loop
 * jump the whole region it re-runs, or it changed the loop progress kept with
 * the map (on a jump, and at the end of a run whose loop ran out of passes;
 * see `cacheLoopProgress`). Drivers save the cache on these too, so the change
 * reaches disk now (see {@link saveWorkflowCache}). Otherwise a run resumed or
 * handed off before the next step finishes replays the superseded results,
 * like a loop pass that never ran again and decided its gate on the previous
 * pass's output, or a retried loop finds its budget still spent.
 */
export function changesCache(event: WorkflowEvent): boolean {
  return (
    event.kind === "step_edited" ||
    event.kind === "loop_iteration" ||
    event.kind === "workflow_done"
  );
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

/**
 * Save what `event` means for the on-disk cache: a finished step (see
 * {@link persistWorkflowStepDone}), or a change the engine already made to the
 * map (see {@link changesCache}). Every driver's event loop calls this, on
 * every path, including a handoff's drain, so none of them can save one kind
 * and forget the other.
 */
export async function persistCacheEvent(
  store: WorkflowCacheStore | undefined,
  key: WorkflowCacheKey | undefined,
  cache: Map<string, StepResult>,
  event: WorkflowEvent,
): Promise<void> {
  if (event.kind === "step_done") {
    await persistWorkflowStepDone(store, key, cache, event.stepId, event.result, event.cached);
  }
  if (store && key && changesCache(event)) await store.save(key, cache);
}

function parseWorkflowCacheFile(file: string, key: WorkflowCacheKey): Map<string, StepResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(file);
  } catch {
    return new Map();
  }
  // No pre-v2 on-disk format ships in the wild; the migrator table is the
  // place to add a v2→v3 transform when WORKFLOW_CACHE_VERSION is bumped.
  const migrated = migrateStateVersion<WorkflowCacheFile>(raw, WORKFLOW_CACHE_VERSION, {
    // 1: (v) => ({ ...v, version: 2, /* reshape */ }),
  });
  if (!migrated.ok) return new Map();
  const parsed = migrated.value;
  if (parsed.workflow !== key.workflow || parsed.cwd !== key.cwd) return new Map();
  if (parsed.inputHash !== hashWorkflowCacheInput(key.input)) return new Map();
  if (parsed.specHash !== key.specHash) return new Map();

  const out = new Map<string, StepResult>();
  for (const [stepId, result] of Object.entries(parsed.steps ?? {})) {
    const valid = validateStepResult(stepId, result);
    if (valid) out.set(stepId, valid);
  }
  setCacheLoopProgress(out, parseLoopProgress(parsed.loops));
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
    tokens:
      r.tokens && typeof r.tokens === "object" ? (r.tokens as StepResult["tokens"]) : undefined,
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
