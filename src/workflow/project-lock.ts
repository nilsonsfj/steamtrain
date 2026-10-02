import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { type FileLockOptions, withFileLock } from "./file-lock";
import { STEAMTRAIN_STATE_DIR } from "./fs-util";

/**
 * Cross-process exclusive lock that serializes writers of a project's
 * `.steamtrain/` state (cache, history, live-run meta) and `git worktree add`
 * for that project/repo.
 *
 * Unlike the land lock (which is best-effort and keyed by remote origin), this
 * lock is *required* by default: a timeout throws instead of letting two
 * writers proceed unlocked. Lost updates on the step cache and TOCTOU on the
 * run queue are integrity bugs; serialization is the fix, not a nicety.
 *
 * Default lock path: `<project>/.steamtrain/locks/state.lock`.
 */

/**
 * Where lock waits go when a caller passes no `onWait`. The cache, history,
 * live-run and worktree writers never do, so without a sink a stuck lock looks
 * like a hang. The CLI and web entry points set it to stderr; the TUI leaves it
 * unset, since a write there would corrupt the screen. A slow release is
 * reported at once; a wait to acquire only once it has lasted
 * {@link DEFAULT_NOTICE_DELAY_MS}, because parallel steps in one process brush
 * against each other for a few milliseconds all the time.
 */
let lockNoticeSink: ((message: string) => void) | undefined;

export function setProjectLockNoticeSink(sink: ((message: string) => void) | undefined): void {
  lockNoticeSink = sink;
}

const DEFAULT_NOTICE_DELAY_MS = 3000;

export interface ProjectLockOptions extends Omit<FileLockOptions, "bestEffort" | "label"> {
  /**
   * Directory that holds the lock file. When set (tests), the lock is
   * `state-<hash>.lock` inside it. When omitted, see module docs.
   */
  lockDir?: string;
  /**
   * When true, degrade to unlocked execution after `maxWaitMs` (land-lock
   * style). Default false — state writers must not proceed unlocked.
   */
  bestEffort?: boolean;
  /** How long a wait to acquire lasts before the notice sink hears of it. Default 3s. */
  noticeDelayMs?: number;
}

/**
 * The `.steamtrain` directory that owns a store root, or the store root itself
 * when it is not nested under `.steamtrain/` (unit-test temp dirs).
 */
export function steamtrainDirFromStatePath(stateSubdir: string): string {
  const resolved = resolve(stateSubdir);
  if (basename(dirname(resolved)) === STEAMTRAIN_STATE_DIR) {
    return dirname(resolved);
  }
  return resolved;
}

/** Resolve the project root that owns a `.steamtrain/<subdir>` path. */
export function projectRootFromStatePath(stateSubdir: string): string {
  const steamtrainDir = steamtrainDirFromStatePath(stateSubdir);
  if (basename(steamtrainDir) === STEAMTRAIN_STATE_DIR) {
    return dirname(steamtrainDir);
  }
  return steamtrainDir;
}

function hashedLockPath(lockDir: string, key: string): string {
  return join(lockDir, `state-${createHash("sha256").update(key).digest("hex").slice(0, 16)}.lock`);
}

/**
 * Run `fn` while holding the project's state lock. `projectRoot` is the
 * workflow/repo cwd. Throws on timeout unless `bestEffort` is set.
 */
export async function withProjectStateLock<T>(
  projectRoot: string,
  fn: () => Promise<T>,
  opts: ProjectLockOptions = {},
): Promise<T> {
  const root = resolve(projectRoot);
  const lockPath = opts.lockDir
    ? hashedLockPath(opts.lockDir, root)
    : join(root, STEAMTRAIN_STATE_DIR, "locks", "state.lock");
  return runLocked(lockPath, fn, opts);
}

/**
 * Lock using a store's rootDir (`.steamtrain/cache`, `.steamtrain/runs`, or a
 * bare test temp directory). Production stores under `.steamtrain/<subdir>`
 * share the same lock file as {@link withProjectStateLock} for that project.
 */
export async function withStateDirLock<T>(
  stateSubdir: string,
  fn: () => Promise<T>,
  opts: ProjectLockOptions = {},
): Promise<T> {
  const resolved = resolve(stateSubdir);
  const steamtrainDir = steamtrainDirFromStatePath(resolved);
  const lockPath = opts.lockDir
    ? hashedLockPath(opts.lockDir, resolved)
    : basename(steamtrainDir) === STEAMTRAIN_STATE_DIR
      ? join(steamtrainDir, "locks", "state.lock")
      : join(steamtrainDir, "locks", "state.lock");
  return runLocked(lockPath, fn, opts);
}

async function runLocked<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: ProjectLockOptions,
): Promise<T> {
  const sink = lockNoticeSink;
  const delayMs = opts.noticeDelayMs ?? DEFAULT_NOTICE_DELAY_MS;
  let waitNotice: NodeJS.Timeout | undefined;
  const heldBySink = !opts.onWait && sink !== undefined;
  const onWait =
    opts.onWait ??
    (sink
      ? (message: string): void => {
          waitNotice ??= setTimeout(
            () => sink(`${message} (still not acquired after ${delayMs / 1000}s)`),
            delayMs,
          );
        }
      : undefined);
  try {
    const outcome = await withFileLock(
      lockPath,
      async () => {
        clearTimeout(waitNotice);
        return fn();
      },
      {
        maxWaitMs: opts.maxWaitMs,
        staleMs: opts.staleMs,
        pollMs: opts.pollMs,
        signal: opts.signal,
        nowMs: opts.nowMs,
        sleep: opts.sleep,
        onWait,
        onReleaseWarn: opts.onReleaseWarn ?? (heldBySink ? sink : undefined),
        releaseMaxWaitMs: opts.releaseMaxWaitMs,
        releaseWarnAfterMs: opts.releaseWarnAfterMs,
        bestEffort: opts.bestEffort ?? false,
        label: "project state lock",
      },
    );
    return outcome.value;
  } finally {
    clearTimeout(waitNotice);
  }
}
