import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, isEnoent, sanitizePathComponent } from "./fs-util";
import {
  RUN_RECORD_VERSION,
  type RunRecord,
  type RunRecordSummary,
  type RunnerUsage,
  computeRunTotals,
  runRecordSummary,
  tallyRunnerUsage,
} from "./history";
import { type ProjectLockOptions, withStateDirLock } from "./project-lock";
import { migrateStateVersion } from "./state-migrate";

export const WORKFLOW_HISTORY_DIR = ".steamtrain/history";
/** Keep at most this many records; the oldest are pruned after each save. */
export const DEFAULT_HISTORY_LIMIT = 100;

/** Injectable lock for tests; defaults to the cross-process project state lock. */
export type HistoryLockFn = <T>(
  stateSubdir: string,
  fn: () => Promise<T>,
  opts?: ProjectLockOptions,
) => Promise<T>;

let historyLock: HistoryLockFn = withStateDirLock;

/** Override the history writer lock (tests). Pass `undefined` to restore default. */
export function setWorkflowHistoryLock(lock: HistoryLockFn | undefined): void {
  historyLock = lock ?? withStateDirLock;
}

export interface WorkflowHistoryStore {
  rootDir: string;
  /** Persist a run record, then prune to the retention limit. */
  save(record: RunRecord): Promise<void>;
  /** Newest-first run summaries (cheap list view), optionally limited. */
  list(limit?: number): Promise<RunRecordSummary[]>;
  /** Full record for one run id, or undefined if absent/corrupt. */
  get(id: string): Promise<RunRecord | undefined>;
  /** Delete one record by id. */
  remove(id: string): Promise<void>;
  /** Delete every record. */
  clearAll(): Promise<void>;
  /**
   * How many recorded runs each runner took part in. Optional: a store that
   * cannot answer simply leaves the settings table's Runs column empty rather
   * than making the caller read every record itself.
   */
  runnerUsage?(limit?: number): Promise<RunnerUsage>;
}

export function createWorkflowHistoryStore(
  rootDir: string = WORKFLOW_HISTORY_DIR,
  limit: number = DEFAULT_HISTORY_LIMIT,
): WorkflowHistoryStore {
  return {
    rootDir,
    save: (record) => saveRunRecord(rootDir, record, limit),
    list: (max) => listRunRecords(rootDir, max),
    get: (id) => getRunRecord(rootDir, id),
    remove: (id) => removeRunRecord(rootDir, id),
    clearAll: () => clearAllRunRecords(rootDir),
    runnerUsage: (max) => listRunnerUsage(rootDir, max),
  };
}

function recordFileName(id: string): string {
  return `${sanitizePathComponent(id)}.json`;
}

export async function saveRunRecord(
  rootDir: string,
  record: RunRecord,
  limit: number = DEFAULT_HISTORY_LIMIT,
): Promise<void> {
  await historyLock(rootDir, async () => {
    const target = join(rootDir, recordFileName(record.id));
    await atomicWriteFile(target, `${JSON.stringify(record, null, 2)}\n`);
    await pruneRunRecords(rootDir, limit);
  });
}

export async function listRunRecords(rootDir: string, limit?: number): Promise<RunRecordSummary[]> {
  const records = await readAllRunRecords(rootDir);
  const summaries = records.map(runRecordSummary);
  summaries.sort((a, b) => b.startedAt - a.startedAt);
  return typeof limit === "number" ? summaries.slice(0, limit) : summaries;
}

/**
 * Per-runner run counts, newest runs first when limited. Reads the same files
 * `list` does — the records are parsed whole either way, so this projection
 * costs the caller nothing beyond a listing it was already paying for.
 */
export async function listRunnerUsage(rootDir: string, limit?: number): Promise<RunnerUsage> {
  const records = await readAllRunRecords(rootDir);
  records.sort((a, b) => b.startedAt - a.startedAt);
  return tallyRunnerUsage(typeof limit === "number" ? records.slice(0, limit) : records);
}

/** Every parsed record in the directory, unsorted; corrupt files are skipped. */
async function readAllRunRecords(rootDir: string): Promise<RunRecord[]> {
  let entries: string[];
  try {
    entries = await readdir(rootDir);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  const BATCH_SIZE = 10;
  const records: (RunRecord | undefined)[] = [];
  const filesToRead = entries.filter((name) => name.endsWith(".json"));
  for (let i = 0; i < filesToRead.length; i += BATCH_SIZE) {
    const batch = filesToRead.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map((name) => readRecord(join(rootDir, name))));
    records.push(...batchResults);
  }
  return records.filter((record): record is RunRecord => record !== undefined);
}

export async function getRunRecord(rootDir: string, id: string): Promise<RunRecord | undefined> {
  return (await readRecord(join(rootDir, recordFileName(id)))) ?? undefined;
}

export async function removeRunRecord(rootDir: string, id: string): Promise<void> {
  try {
    await rm(join(rootDir, recordFileName(id)), { force: true });
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
}

export async function clearAllRunRecords(rootDir: string): Promise<void> {
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

/**
 * Drop the oldest records past the retention limit. This runs after every save,
 * so it must stay cheap: read only each file's `startedAt` (via the same
 * validator as list/get) rather than relying on filesystem mtime, which can
 * collide or reorder when saves happen in the same millisecond.
 */
async function pruneRunRecords(rootDir: string, limit: number): Promise<void> {
  if (limit <= 0) return;
  let entries: string[];
  try {
    entries = await readdir(rootDir);
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }
  const files = entries.filter((name) => name.endsWith(".json"));
  if (files.length <= limit) return;
  const stamped = await Promise.all(
    files.map(async (name) => {
      const path = join(rootDir, name);
      const record = await readRecord(path);
      if (record) return { name, startedAt: record.startedAt };
      try {
        const info = await stat(path);
        return { name, startedAt: info.mtimeMs };
      } catch (err) {
        if (isEnoent(err)) return undefined;
        throw err;
      }
    }),
  );
  const present = stamped.filter((s): s is { name: string; startedAt: number } => s !== undefined);
  if (present.length <= limit) return;
  present.sort((a, b) => b.startedAt - a.startedAt);
  const stale = present.slice(limit);
  await Promise.all(stale.map((s) => rm(join(rootDir, s.name), { force: true })));
}

async function readRecord(path: string): Promise<RunRecord | undefined> {
  let file: string;
  try {
    file = await readFile(path, "utf8");
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw err;
  }
  return validateRecord(file);
}

/** Parse + shallow-validate a record file; ignore corrupt/unmigratable files. */
function validateRecord(file: string): RunRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(file);
  } catch {
    return undefined;
  }
  // No pre-v1 format exists; the migrator table is ready for the first bump.
  const migrated = migrateStateVersion<{ version: number }>(parsed, RUN_RECORD_VERSION, {
    // 1: (v) => ({ ...v, version: 2 }),
  });
  if (!migrated.ok) return undefined;
  const r = migrated.value as Partial<RunRecord>;
  if (typeof r.id !== "string" || typeof r.workflow !== "string") return undefined;
  if (typeof r.startedAt !== "number") return undefined;
  if (
    r.status !== "done" &&
    r.status !== "error" &&
    r.status !== "canceled" &&
    r.status !== "budget-exceeded"
  ) {
    return undefined;
  }
  if (!Array.isArray(r.phases)) return undefined;
  for (const phase of r.phases as unknown[]) {
    if (!phase || typeof phase !== "object") return undefined;
    const p = phase as Record<string, unknown>;
    if (typeof p.phaseId !== "string" || typeof p.title !== "string") return undefined;
    if (typeof p.index !== "number" || !Array.isArray(p.steps)) return undefined;
  }
  return {
    version: RUN_RECORD_VERSION,
    id: r.id,
    workflow: r.workflow,
    input: typeof r.input === "string" ? r.input : "",
    cwd: typeof r.cwd === "string" ? r.cwd : "",
    specHash: typeof r.specHash === "string" ? r.specHash : undefined,
    params: r.params && typeof r.params === "object" ? r.params : undefined,
    status: r.status,
    ok: Boolean(r.ok),
    startedAt: r.startedAt,
    endedAt: typeof r.endedAt === "number" ? r.endedAt : r.startedAt,
    durationMs: typeof r.durationMs === "number" ? r.durationMs : 0,
    phases: r.phases,
    totals: r.totals ?? computeRunTotals(r.phases),
    error: typeof r.error === "string" ? r.error : undefined,
    budget: r.budget && typeof r.budget === "object" ? r.budget : undefined,
    harvest: r.harvest && typeof r.harvest === "object" ? r.harvest : undefined,
    interventions: Array.isArray(r.interventions) ? r.interventions : undefined,
  };
}
