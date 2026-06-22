import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  RUN_RECORD_VERSION,
  type RunRecord,
  type RunRecordSummary,
  computeRunTotals,
  runRecordSummary,
} from "./history";

export const WORKFLOW_HISTORY_DIR = ".steamtrain/history";
/** Keep at most this many records; the oldest are pruned after each save. */
export const DEFAULT_HISTORY_LIMIT = 100;

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
  };
}

function recordFileName(id: string): string {
  return `${sanitizeId(id)}.json`;
}

/** Run ids are UUIDs/timestamps, but be defensive against path traversal. */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function saveRunRecord(
  rootDir: string,
  record: RunRecord,
  limit: number = DEFAULT_HISTORY_LIMIT,
): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  const target = join(rootDir, recordFileName(record.id));
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(temp, target);
  await pruneRunRecords(rootDir, limit);
}

export async function listRunRecords(rootDir: string, limit?: number): Promise<RunRecordSummary[]> {
  let entries: string[];
  try {
    entries = await readdir(rootDir);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  const summaries: RunRecordSummary[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const record = await readRecord(join(rootDir, name));
    if (record) summaries.push(runRecordSummary(record));
  }
  summaries.sort((a, b) => b.startedAt - a.startedAt);
  return typeof limit === "number" ? summaries.slice(0, limit) : summaries;
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

async function pruneRunRecords(rootDir: string, limit: number): Promise<void> {
  if (limit <= 0) return;
  const summaries = await listRunRecords(rootDir);
  if (summaries.length <= limit) return;
  const stale = summaries.slice(limit);
  await Promise.all(stale.map((s) => removeRunRecord(rootDir, s.id)));
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

/** Parse + shallow-validate a record file; ignore corrupt/old-version files. */
function validateRecord(file: string): RunRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(file);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const r = parsed as Partial<RunRecord>;
  if (r.version !== RUN_RECORD_VERSION) return undefined;
  if (typeof r.id !== "string" || typeof r.workflow !== "string") return undefined;
  if (typeof r.startedAt !== "number") return undefined;
  if (r.status !== "done" && r.status !== "error" && r.status !== "canceled") return undefined;
  if (!Array.isArray(r.phases)) return undefined;
  return {
    version: r.version,
    id: r.id,
    workflow: r.workflow,
    input: typeof r.input === "string" ? r.input : "",
    cwd: typeof r.cwd === "string" ? r.cwd : "",
    status: r.status,
    ok: Boolean(r.ok),
    startedAt: r.startedAt,
    endedAt: typeof r.endedAt === "number" ? r.endedAt : r.startedAt,
    durationMs: typeof r.durationMs === "number" ? r.durationMs : 0,
    phases: r.phases,
    totals: r.totals ?? computeRunTotals(r.phases),
    error: typeof r.error === "string" ? r.error : undefined,
  };
}

function isEnoent(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && err.code === "ENOENT");
}
