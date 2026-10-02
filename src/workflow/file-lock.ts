import { createHash, randomUUID } from "node:crypto";
import { type FileHandle, link, mkdir, open, unlink, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { isEnoent } from "./fs-util";
import { abortableSleep } from "./timeout";

/**
 * Cross-process exclusive file lock shared by the land lock (PR merges) and
 * the project state lock (`.steamtrain/` writers + worktree add).
 *
 * Payloads are fully written before an exclusive hard-link publishes them.
 * All main-lock mutations take the sibling coordinator. Recovery is allowed
 * only for a provably dead same-host owner, never just an expired heartbeat.
 * Each coordinator incarnation has an immutable chain of recovery claims;
 * a dead claimant can be succeeded without deleting a claim another process
 * may have acquired. Recovery claims are retained to prevent delayed readers
 * from reopening an old generation.
 */

export interface FileLockOptions {
  /** Give up acquiring after this long. Default 10 min. */
  maxWaitMs?: number;
  /** Heartbeat cadence basis. Age alone never permits reclaiming an owner. Default 15 min. */
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
  /**
   * How long releasing may wait for the sibling coordinator before it gives up
   * and throws, leaving the lock in place. Default 5 min. Releasing must not
   * leave the lock behind lightly, so this is far longer than any healthy hold.
   */
  releaseMaxWaitMs?: number;
  /** Warn (through `onWait`) once a release has waited this long. Default 10s. */
  releaseWarnAfterMs?: number;
}

export interface FileLockOutcome<T> {
  value: T;
  locked: boolean;
}

interface LockPayload {
  pid: number;
  host: string;
  createdAtMs: number;
  token?: string;
}

const DEFAULT_MAX_WAIT_MS = 10 * 60_000;
const DEFAULT_STALE_MS = 15 * 60_000;
const DEFAULT_POLL_MS = 750;
const STEAL_LOCK_ACQUIRE_ATTEMPTS = 8;
const DEFAULT_RELEASE_MAX_WAIT_MS = 5 * 60_000;
const DEFAULT_RELEASE_WARN_AFTER_MS = 10_000;

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
  const payload = newPayload(now());

  while (!held) {
    if (opts.signal?.aborted) throw new Error("cancelled");
    const acquired = await tryAcquire(lockPath, payload);
    if (acquired) {
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
    const value = await withCleanup(
      () => fn(true),
      () =>
        releaseIfOwned(lockPath, payload.token!, {
          maxWaitMs: opts.releaseMaxWaitMs ?? DEFAULT_RELEASE_MAX_WAIT_MS,
          warnAfterMs: opts.releaseWarnAfterMs ?? DEFAULT_RELEASE_WARN_AFTER_MS,
          now,
          onSlow: (waitedMs) =>
            opts.onWait?.(
              `still waiting to release the ${label} (its coordinator has been held for ${Math.round(waitedMs / 1000)}s)`,
            ),
        }),
    );
    return { value, locked: true };
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * Run `fn`, then `cleanup`. A cleanup failure is thrown (fail loud) but keeps
 * `fn`'s own error as its `cause` instead of silently replacing it.
 */
async function withCleanup<T>(fn: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  let value: T | undefined;
  let failed = false;
  let error: unknown;
  try {
    value = await fn();
  } catch (err) {
    failed = true;
    error = err;
  }
  try {
    await cleanup();
  } catch (cleanupErr) {
    if (failed && cleanupErr instanceof Error && cleanupErr.cause === undefined) {
      cleanupErr.cause = error;
    }
    throw cleanupErr;
  }
  if (failed) throw error;
  return value as T;
}

interface LockSnapshot {
  holder: LockPayload;
  ino: number;
  dev: number;
  raw: string;
}

function newPayload(nowMs = Date.now()): LockPayload {
  return { pid: process.pid, host: hostname(), createdAtMs: nowMs, token: randomUUID() };
}

function holderIsDead(holder: LockPayload): boolean {
  if (holder.host !== hostname()) return false;
  try {
    process.kill(holder.pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function publishPayload(path: string, payload: LockPayload): Promise<boolean> {
  const temp = `${path}.owner.${randomUUID()}`;
  try {
    await writeFile(temp, JSON.stringify(payload), { flag: "wx", mode: 0o600 });
    await link(temp, path);
    return true;
  } catch (err) {
    if (isEnoent(err)) {
      await mkdir(dirname(path), { recursive: true });
      return false;
    }
    if (isEexist(err)) return false;
    throw err;
  } finally {
    await unlink(temp).catch(() => {});
  }
}

async function tryAcquire(lockPath: string, payload: LockPayload): Promise<boolean> {
  return (
    (await withStealLock(lockPath, async () => {
      if (await publishPayload(lockPath, payload)) return true;
      const existing = await readLock(lockPath);
      if (!existing || !holderIsDead(existing.holder)) return false;
      await unlink(lockPath);
      return publishPayload(lockPath, payload);
    })) === true
  );
}

/** How long {@link withStealLock} keeps trying, and what it says when slow. */
interface StealWait {
  /** Give up after this many attempts. Default {@link STEAL_LOCK_ACQUIRE_ATTEMPTS}. */
  attempts?: number;
  /** Give up after this long, however many attempts that takes. */
  maxWaitMs?: number;
  /** Call `onSlow` once after waiting this long. */
  warnAfterMs?: number;
  onSlow?: (waitedMs: number) => void;
  now?: () => number;
}

async function withStealLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  wait: StealWait = {},
): Promise<T | undefined> {
  const stealPath = `${lockPath}.steal`;
  const { attempts = STEAL_LOCK_ACQUIRE_ATTEMPTS, maxWaitMs, warnAfterMs, onSlow } = wait;
  const now = wait.now ?? Date.now;
  const started = now();
  let warned = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const payload = newPayload();
    if (await tryAcquireStealLock(stealPath, payload)) {
      return withCleanup(fn, () => removeIfOwned(stealPath, payload.token!));
    }
    const waited = now() - started;
    // Warn first, so a stalled iteration that jumps past both still says so.
    if (!warned && warnAfterMs !== undefined && waited >= warnAfterMs) {
      warned = true;
      onSlow?.(waited);
    }
    if (maxWaitMs !== undefined && waited >= maxWaitMs) return undefined;
    await abortableSleep(5);
  }
  return undefined;
}

async function tryAcquireStealLock(stealPath: string, payload: LockPayload): Promise<boolean> {
  if (await publishPayload(stealPath, payload)) return true;
  if (!(await reclaimAbandonedStealLock(stealPath))) return false;
  return publishPayload(stealPath, payload);
}

async function reclaimAbandonedStealLock(stealPath: string): Promise<boolean> {
  const observed = await readLock(stealPath);
  if (!observed || !holderIsDead(observed.holder)) return false;
  const identity = createHash("sha256")
    .update(`${observed.dev}:${observed.ino}:${observed.raw}`)
    .digest("hex");
  for (let generation = 0; ; generation++) {
    const claimPath = `${stealPath}.claim.${identity}.${generation}`;
    if (await publishPayload(claimPath, newPayload())) break;
    const claim = await readLock(claimPath);
    if (!claim || !holderIsDead(claim.holder)) return false;
  }
  const current = await readLock(stealPath);
  if (!current) return false;
  if (
    current.ino !== observed.ino ||
    current.dev !== observed.dev ||
    current.raw !== observed.raw
  ) {
    return false;
  }
  await unlink(stealPath);
  return true;
}

/**
 * Remove our own lock under the coordinator. It waits for the coordinator
 * rather than for a fixed number of tries, because leaving the lock behind
 * blocks every other process, but not forever: a coordinator that is held by a
 * live process that never lets go (or a file nobody can verify) would otherwise
 * hang the run silently at its end.
 */
async function releaseIfOwned(
  lockPath: string,
  token: string,
  wait: Required<Pick<StealWait, "maxWaitMs" | "warnAfterMs" | "now" | "onSlow">>,
): Promise<void> {
  const released = await withStealLock(
    lockPath,
    async () => {
      await removeIfOwned(lockPath, token);
      return true;
    },
    { attempts: Number.POSITIVE_INFINITY, ...wait },
  );
  if (!released) {
    throw new Error(
      `could not release ${lockPath}: its coordinator ${lockPath}.steal was still held after ${Math.round(wait.maxWaitMs / 1000)}s; the lock stays held until this process exits`,
    );
  }
}

async function removeIfOwned(path: string, token: string): Promise<void> {
  const existing = await readLock(path);
  if (!existing || existing.holder.token !== token) {
    throw new Error(`lock ownership lost: ${path}`);
  }
  await unlink(path);
}

async function readLock(path: string): Promise<LockSnapshot | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    const raw = await handle.readFile("utf8");
    const info = await handle.stat();
    let parsed: Partial<LockPayload>;
    try {
      parsed = JSON.parse(raw) as Partial<LockPayload>;
    } catch {
      return undefined;
    }
    if (
      !parsed ||
      !Number.isInteger(parsed.pid) ||
      Number(parsed.pid) <= 0 ||
      typeof parsed.host !== "string"
    ) {
      return undefined;
    }
    return { holder: parsed as LockPayload, ino: info.ino, dev: info.dev, raw };
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw err;
  } finally {
    await handle?.close();
  }
}

function isEexist(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "EEXIST";
}
