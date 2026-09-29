import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { isPidAlive } from "../util/process-group";
import { isEnoent } from "./fs-util";
import { abortableSleep } from "./timeout";

/**
 * Cross-process exclusive file lock shared by the land lock (PR merges) and
 * the project state lock (`.steamtrain/` writers + worktree add).
 *
 * Acquisition is exclusive-create (`wx`) of a JSON payload `{ pid, host,
 * createdAtMs }`. Holders refresh mtime so long critical sections are not
 * mistaken for abandoned locks; dead same-host PIDs and stale mtimes are
 * stealable. Every replacement of the lock file — exclusive create, stale
 * steal, and ownership-checked release — takes a sibling `.steal` coordinator
 * first, so a holder finishing cannot be unlinked out from under a waiter who
 * already wx-created a new lock. Abandoned coordinators are renamed off the
 * path and restored on inode mismatch.
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
/** A steal-coordinator file older than this is assumed abandoned. */
const STEAL_LOCK_STALE_MS = 10_000;

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
      held = true;
      break;
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

async function wxLock(lockPath: string, nowMs: number): Promise<boolean> {
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

async function tryAcquire(lockPath: string, nowMs: number): Promise<boolean> {
  const got = await withStealLock(lockPath, () => wxLock(lockPath, nowMs));
  return got === true;
}

async function stealIfStale(lockPath: string, staleMs: number, nowMs: number): Promise<boolean> {
  if (!(await isLockStealable(lockPath, staleMs, nowMs))) return false;
  const got = await withStealLock(lockPath, async () => {
    if (!(await isLockStealable(lockPath, staleMs, nowMs))) return false;
    await unlink(lockPath).catch(() => {});
    return wxLock(lockPath, nowMs);
  });
  return got === true;
}

async function isLockStealable(lockPath: string, staleMs: number, nowMs: number): Promise<boolean> {
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(lockPath)).mtimeMs;
  } catch (err) {
    return isEnoent(err);
  }
  const holder = await readHolder(lockPath);
  const deadSameHost = Boolean(holder && holder.host === hostname() && !isPidAlive(holder.pid));
  return deadSameHost || nowMs - mtimeMs > staleMs;
}

async function withStealLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T | undefined> {
  const stealPath = `${lockPath}.steal`;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (await tryAcquireStealLock(stealPath)) {
      try {
        return await fn();
      } finally {
        await unlink(stealPath).catch(() => {});
      }
    }
    await abortableSleep(5);
  }
  return undefined;
}

async function tryAcquireStealLock(stealPath: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const payload: LockPayload = {
        pid: process.pid,
        host: hostname(),
        createdAtMs: Date.now(),
      };
      await writeFile(stealPath, JSON.stringify(payload), { flag: "wx" });
      return true;
    } catch (err) {
      if (isEnoent(err)) {
        await mkdir(dirname(stealPath), { recursive: true });
        return false;
      }
      if (!isEexist(err)) throw err;
      if (attempt === 0 && (await reclaimAbandonedStealLock(stealPath))) continue;
      return false;
    }
  }
  return false;
}

async function reclaimAbandonedStealLock(stealPath: string): Promise<boolean> {
  let info: { mtimeMs: number; ino: number };
  try {
    const s = await stat(stealPath);
    info = { mtimeMs: s.mtimeMs, ino: s.ino };
  } catch {
    return false;
  }
  const holder = await readHolder(stealPath);
  const deadSameHost = Boolean(holder && holder.host === hostname() && !isPidAlive(holder.pid));
  if (!deadSameHost && Date.now() - info.mtimeMs <= STEAL_LOCK_STALE_MS) return false;
  const stolen = `${stealPath}.${process.pid}.${randomBytes(6).toString("hex")}`;
  try {
    await rename(stealPath, stolen);
  } catch {
    return false;
  }
  try {
    const moved = await stat(stolen);
    if (moved.ino !== info.ino) {
      await rename(stolen, stealPath).catch(() => {});
      return false;
    }
  } catch {
    await rename(stolen, stealPath).catch(() => {});
    return false;
  }
  await unlink(stolen).catch(() => {});
  return true;
}

async function releaseIfOwned(lockPath: string): Promise<void> {
  await withStealLock(lockPath, async () => {
    const holder = await readHolder(lockPath);
    if (holder && holder.pid === process.pid && holder.host === hostname()) {
      await removeQuietly(lockPath);
    }
  });
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
