import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FileLockOptions, type FileLockOutcome, withFileLock } from "./file-lock";
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

/** Whether the acquisition succeeded — informational; `fn` always runs. */
export type LandLockOutcome<T> = FileLockOutcome<T>;

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
  if (opts.signal?.aborted) throw new Error("cancelled");

  let lockPath: string;
  try {
    const resolveKey = opts.resolveKey ?? defaultResolveKey;
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

  const fileOpts: FileLockOptions = {
    maxWaitMs: opts.maxWaitMs,
    staleMs: opts.staleMs,
    pollMs: opts.pollMs,
    signal: opts.signal,
    nowMs: opts.nowMs,
    sleep: opts.sleep ?? abortableSleep,
    onWait: opts.onWait,
    bestEffort: true,
    label: "land lock",
  };

  return withFileLock(lockPath, fn, fileOpts);
}
