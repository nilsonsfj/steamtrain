import { mkdir, readFile, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { isEnoent } from "./fs-util";
import { abortableSleep } from "./timeout";

/**
 * Cross-process exclusive file lock shared by the land lock (PR merges) and
 * the project state lock (`.steamtrain/` writers + worktree add).
 *
 * Acquisition is exclusive-create (`wx`) of a JSON payload `{ pid, host,
 * createdAtMs }`. Holders refresh mtime so long critical sections are not
 * mistaken for abandoned locks; dead same-host PIDs and stale mtimes are
 * stealable. Release is ownership-checked so a contender that stole never
 * deletes a newer holder's file.
 */

export interface FileLockOptions {
  /** Give up acquiring after this long. Default 10 min. */
  maxWaitMs?: number;
  /** A held lock older than this (by mtime) is treated as abandoned. Default 15 min. */
  staleMs?: number;
  /** Poll interval while another process holds the lock. Default 750ms. */
  pollMs?: number;
  signal?: AbortSignal;
  nowMs?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onWait?: (message: string) => void;
  /**
   * When true (land lock), run `fn(false)` after the wait budget instead of
   * throwing. When false (state lock), throw so writers never proceed unlocked.
   */
  bestEffort?: boolean;
  /** Message prefix used in onWait / timeout errors. */
  label?: string;
}

export interface FileLockOutcome<T> {
  value: T;
  locked: boolean;
}

interface LockPayload {
  pid: number;
  host: string;
  createdAtMs: number;
}

const DEFAULT_MAX_WAIT_MS = 10 * 60_000;
const DEFAULT_STALE_MS = 15 * 60_000;
const DEFAULT_POLL_MS = 750;

/**
 * Run `fn` while holding an exclusive lock at `lockPath`. See
 * {@link FileLockOptions.bestEffort} for timeout behaviour.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: (locked: boolean) => Promise<T>,
  opts: FileLockOptions = {},
): Promise<FileLockOutcome<T>> {
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const now = opts.nowMs ?? Date.now;
  const sleep = opts.sleep ?? abortableSleep;
  const label = opts.label ?? "lock";
  const bestEffort = opts.bestEffort ?? false;

  if (opts.signal?.aborted) throw new Error("cancelled");

  const deadline = now() + maxWaitMs;
  let contendedNotice = false;
  let held = false;

  while (!held) {
    if (opts.signal?.aborted) throw new Error("cancelled");
    const acquired = await tryAcquire(lockPath, now());
    if (acquired) {
      held = true;
      break;
    }
    if (await stealIfStale(lockPath, staleMs, now())) {
      continue;
    }
    if (now() >= deadline) {
      const waited = Math.round(maxWaitMs / 1000);
      if (bestEffort) {
        opts.onWait?.(`${label} still held after ${waited}s — continuing without it`);
        return { value: await fn(false), locked: false };
      }
      throw new Error(`${label} still held after ${waited}s`);
    }
    if (!contendedNotice) {
      contendedNotice = true;
      opts.onWait?.(`waiting for the ${label}`);
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())), opts.signal);
  }

  const heartbeat = setInterval(
    () => {
      const t = new Date(now());
      void utimes(lockPath, t, t).catch(() => {});
    },
    Math.max(1_000, Math.floor(staleMs / 3)),
  );
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  try {
    return { value: await fn(true), locked: true };
  } finally {
    clearInterval(heartbeat);
    await releaseIfOwned(lockPath);
  }
}

async function tryAcquire(lockPath: string, nowMs: number): Promise<boolean> {
  try {
    const payload: LockPayload = { pid: process.pid, host: hostname(), createdAtMs: nowMs };
    await writeFile(lockPath, JSON.stringify(payload), { flag: "wx" });
    return true;
  } catch (err) {
    if (isEnoent(err)) {
      await mkdir(dirname(lockPath), { recursive: true });
      return false;
    }
    if (isEexist(err)) return false;
    throw err;
  }
}

async function stealIfStale(lockPath: string, staleMs: number, nowMs: number): Promise<boolean> {
  let info: { mtimeMs: number } | undefined;
  try {
    const s = await stat(lockPath);
    info = { mtimeMs: s.mtimeMs };
  } catch (err) {
    return isEnoent(err);
  }

  const holder = await readHolder(lockPath);
  if (holder && holder.host === hostname() && !isProcessAlive(holder.pid)) {
    return removeQuietly(lockPath);
  }
  if (nowMs - info.mtimeMs > staleMs) {
    return removeQuietly(lockPath);
  }
  return false;
}

async function releaseIfOwned(lockPath: string): Promise<void> {
  const holder = await readHolder(lockPath);
  if (holder && holder.pid === process.pid && holder.host === hostname()) {
    await removeQuietly(lockPath);
  }
}

async function readHolder(lockPath: string): Promise<LockPayload | undefined> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (typeof parsed.pid === "number" && typeof parsed.host === "string") {
      return { pid: parsed.pid, host: parsed.host, createdAtMs: Number(parsed.createdAtMs) || 0 };
    }
  } catch {
    // Corrupt/empty/partial lock file — let staleness reclaim it.
  }
  return undefined;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function removeQuietly(lockPath: string): Promise<boolean> {
  try {
    await unlink(lockPath);
  } catch {
    // Someone else removed/replaced it — fine.
  }
  return true;
}

function isEexist(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "EEXIST";
}
