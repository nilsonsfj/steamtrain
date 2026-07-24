import { createHash } from "node:crypto";
import { mkdir, readFile, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isEnoent } from "./fs-util";
import { abortableSleep } from "./timeout";
import { runGitText } from "./worktree";

/**
 * A best-effort, cross-process advisory lock that serializes PR *landing*
 * across the parallel `babysit-pr` children of `babysit-all-prs`.
 *
 * Why this exists: each `babysit-pr` run's `wait-or-merge` step re-invokes
 * steamtrain as its OWN process (`${STEAMTRAIN_CLI} workflow pr
 * merge-when-ready`), in its own isolated worktree. When several run in
 * parallel they all finish waiting for green checks at roughly the same moment
 * and then race to `gh pr merge` into the SAME base branch. GitHub lets exactly
 * one win; the rest come back with `Base branch was modified. Review and try
 * the merge again.` — or, if their files overlapped the PR that just landed,
 * their mergeability flips to CONFLICTING the instant the first merge lands.
 * That is the "wait-or-merge always fails" symptom: not a bug in the waiter,
 * but N uncoordinated processes stampeding the same branch.
 *
 * An in-process queue (`withRepoWorktreeLock`) cannot help here because the
 * contenders are separate OS processes. So the lock lives on the filesystem,
 * keyed by the repository's `remote.origin.url` — the true identity of "the
 * GitHub repo we are landing into", stable across every linked worktree and
 * even across separate clones of the same repo.
 *
 * It is deliberately BEST-EFFORT: if the lock cannot be acquired within the
 * budget (a crashed holder that never cleaned up, a filesystem that rejects the
 * lock dir), the caller proceeds anyway. Serialization only REDUCES churn;
 * correctness is still guaranteed by the caller re-checking mergeability under
 * the lock and retrying transient merge failures. A lock that could itself
 * deadlock the whole babysit run would be worse than the race it prevents.
 */

export interface LandLockOptions {
  /** Give up acquiring after this long and run `fn` anyway. Default 10 min. */
  maxWaitMs?: number;
  /** A held lock older than this (by mtime) is treated as abandoned. Default 15 min. */
  staleMs?: number;
  /** Poll interval while another process holds the lock. Default 750ms. */
  pollMs?: number;
  signal?: AbortSignal;
  /** Injectable clock/sleep/key resolver for tests. */
  nowMs?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  resolveKey?: (cwd: string, signal?: AbortSignal) => Promise<string>;
  /** Directory the lock file lives in. Defaults to an OS-temp `steamtrain-locks` dir. */
  lockDir?: string;
  /** Emitted once when the lock is contended, and again when it is acquired/skipped. */
  onWait?: (message: string) => void;
}

const DEFAULT_MAX_WAIT_MS = 10 * 60_000;
const DEFAULT_STALE_MS = 15 * 60_000;
const DEFAULT_POLL_MS = 750;

/** Whether the acquisition succeeded — informational; `fn` always runs. */
export interface LandLockOutcome<T> {
  value: T;
  /** True when we held the exclusive lock; false when we ran best-effort without it. */
  locked: boolean;
}

interface LockPayload {
  pid: number;
  host: string;
  createdAtMs: number;
}

/** Identity of the repo we are landing into — its origin URL, else its toplevel, else cwd. */
async function defaultResolveKey(cwd: string, signal?: AbortSignal): Promise<string> {
  for (const args of [
    ["config", "--get", "remote.origin.url"],
    ["rev-parse", "--show-toplevel"],
  ]) {
    try {
      const value = (await runGitText(args, cwd, signal)).trim();
      if (value) return normalizeRepoKey(value);
    } catch {
      // fall through to the next selector
    }
  }
  return normalizeRepoKey(cwd);
}

/** Normalize origin URLs so `git@github:o/r.git` and `https://…/o/r` map together. */
export function normalizeRepoKey(raw: string): string {
  let value = raw.trim().toLowerCase().replace(/\/+$/, "");
  value = value.replace(/\.git$/, "");
  const scp = value.match(/^[^@]+@([^:]+):(.+)$/);
  if (scp) value = `${scp[1]}/${scp[2]}`;
  value = value.replace(/^[a-z]+:\/\//, "").replace(/^[^@]+@/, "");
  return value.replace(/\/+$/, "");
}

/**
 * Run `fn` while holding the land lock for `cwd`'s repository, serializing
 * against other steamtrain processes landing into the same repo. Never throws
 * on lock-acquisition failure — only `signal` abort (before `fn` runs) or `fn`
 * itself can throw. The lock is always released when `fn` settles.
 */
export async function withLandLock<T>(
  cwd: string,
  fn: (locked: boolean) => Promise<T>,
  opts: LandLockOptions = {},
): Promise<LandLockOutcome<T>> {
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const now = opts.nowMs ?? Date.now;
  const sleep = opts.sleep ?? abortableSleep;
  const resolveKey = opts.resolveKey ?? defaultResolveKey;

  if (opts.signal?.aborted) throw new Error("cancelled");

  let lockPath: string;
  try {
    const key = await resolveKey(cwd, opts.signal);
    const dir = opts.lockDir ?? join(tmpdir(), "steamtrain-locks");
    lockPath = join(
      dir,
      `land-${createHash("sha256").update(key).digest("hex").slice(0, 16)}.lock`,
    );
  } catch {
    // Can't even resolve where the lock would live — degrade to no lock.
    return { value: await fn(false), locked: false };
  }

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
      continue; // stole an abandoned lock's slot — retry the create immediately
    }
    if (now() >= deadline) {
      opts.onWait?.(`land lock still held after ${Math.round(maxWaitMs / 1000)}s — landing anyway`);
      return { value: await fn(false), locked: false };
    }
    if (!contendedNotice) {
      contendedNotice = true;
      opts.onWait?.("another PR is landing into this repo — waiting for the land lock");
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())), opts.signal);
  }

  // Keep the lock's mtime fresh so a long land (update-branch + a second CI
  // wait) is never mistaken for an abandoned holder by another contender.
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
    // Exclusive create AND content in one call: an `open(…, "wx")` followed by a
    // separate write leaves a brief window where the lock exists but is empty,
    // during which a contender's `readHolder` sees no owner.
    await writeFile(lockPath, JSON.stringify(payload), { flag: "wx" });
    return true;
  } catch (err) {
    if (isEnoent(err)) {
      // Lock dir doesn't exist yet — create it and let the caller retry.
      await mkdir(dirname(lockPath), { recursive: true });
      return false;
    }
    if (isEexist(err)) return false;
    // Any other error (permissions, read-only fs): treat as un-lockable.
    throw err;
  }
}

async function stealIfStale(lockPath: string, staleMs: number, nowMs: number): Promise<boolean> {
  let info: { mtimeMs: number } | undefined;
  try {
    const s = await stat(lockPath);
    info = { mtimeMs: s.mtimeMs };
  } catch (err) {
    // Vanished between our create attempt and now — caller should retry.
    return isEnoent(err);
  }

  // A dead holder on THIS host is unambiguously abandoned regardless of age.
  const holder = await readHolder(lockPath);
  if (holder && holder.host === hostname() && !isProcessAlive(holder.pid)) {
    return removeQuietly(lockPath);
  }
  // Cross-host (or an unreadable holder record): PID liveness is unknowable
  // from here, so age is the only signal — a lock whose heartbeat stopped
  // refreshing it for a whole stale window is treated as abandoned.
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
    // ESRCH = no such process; EPERM = alive but not ours (still alive).
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function removeQuietly(lockPath: string): Promise<boolean> {
  try {
    await unlink(lockPath);
  } catch {
    // Someone else removed/replaced it — fine, the slot is free either way.
  }
  return true;
}

function isEexist(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "EEXIST";
}
