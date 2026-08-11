import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, readlink, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { AgentInstanceId } from "../types/events";
import { isOutside, isSteamtrainStatePath } from "./fs-util";
import { type ProjectLockOptions, withProjectStateLock } from "./project-lock";
import type { WorkflowItem } from "./types";

export interface AgentWorkspaceRequest {
  workflowName: string;
  stepId: string;
  agent: AgentInstanceId;
  /** Original workflow cwd. */
  baseCwd: string;
  /** Resolved target cwd for this step in the original checkout. */
  stepCwd: string;
  iteration: number;
  item?: WorkflowItem;
  /**
   * Inherit a prior step's worktree: the new worktree branches from the source
   * worktree's HEAD and copies its full working-tree state (tracked edits and
   * untracked files), instead of snapshotting the original checkout. The
   * source step has already finished, so its worktree is stable. `baseCommit`
   * is the source's own recorded diff base, inherited so a merge-back of the
   * new worktree lands the whole chain's changes.
   */
  inheritFrom?: { stepId: string; root: string; baseCommit?: string };
  /**
   * Attach to a prior step's worktree instead of allocating a new one: no
   * `git worktree add`, no copy — the lease's `cwd` is this request's
   * `stepCwd` re-rooted into `attachTo.root` (same relative-path logic
   * `inheritFrom`/plain allocation uses), and `root`/`branch`/`baseCommit`
   * are carried over verbatim so the caller's `result.worktree` reads exactly
   * like the source's own. Mutually exclusive with `inheritFrom`. Throws when
   * `attachTo.root` no longer exists on disk (pruned/cleaned up) — same
   * failure shape as a missing `inheritFrom` source.
   */
  attachTo?: {
    stepId: string;
    root: string;
    branch: string;
    baseCommit?: string;
    linkedIgnoredPaths?: string[];
  };
  /**
   * The step's `retainWorkspace` (default true). When false the worktree is
   * discarded once the RUN ends — see {@link AgentWorkspaceManager.reclaimDisposable}.
   */
  retainWorkspace?: boolean;
  signal?: AbortSignal;
}

export interface AgentWorkspaceLease {
  /** Cwd to pass to the agent subprocess. */
  cwd: string;
  /** Root of the isolated worktree when one was created. */
  root?: string;
  /** Branch checked out by the isolated worktree when one was created. */
  branch?: string;
  /** Commit the worktree branch started from (the merge-back diff base). */
  baseCommit?: string;
  /** Ignored runtime entries linked from the source checkout into the worktree. */
  linkedIgnoredPaths?: string[];
  dispose: () => Promise<void> | void;
}

export interface AgentWorkspaceManager {
  allocate: (request: AgentWorkspaceRequest) => Promise<AgentWorkspaceLease>;
  /**
   * The id every worktree/branch this manager creates is namespaced under
   * (`steamtrain/<runId>/…`) — the selector post-run GC needs to reclaim
   * exactly this run's worktrees. Absent for managers that don't own one.
   */
  readonly runId?: string;
  /**
   * Discard the worktrees of steps that declared `retainWorkspace: false` —
   * called once the run is over, so `inherit`/`attach`/`merge` could still use
   * them while it was in flight. Best-effort and idempotent.
   */
  reclaimDisposable?: () => Promise<void>;
  /**
   * Reserve a directory + branch name for a KEPT (non-ephemeral) worktree
   * that the CALLER will create itself (via plain `git worktree add`) —
   * used by merge `mode: "worktree"` so its staging worktree lands under the
   * same base directory / run id / naming convention as ordinary step
   * worktrees (not a tmpdir that vanishes), and is found by the existing
   * prune/GC paths. `repoCwd` locates the repo the same way `allocate` does;
   * returns undefined outside a git repository (mirrors `allocate`'s plain-
   * cwd degradation — the caller then falls back to a throwaway location).
   */
  reserveKeptDir?: (
    label: string,
    repoCwd: string,
    signal?: AbortSignal,
  ) => Promise<{ dir: string; branch: string } | undefined>;
}

export interface GitWorktreeManagerOptions {
  baseDir?: string;
  runId?: string;
}

interface GitRepo {
  root: string;
  head: string;
}

const DEFAULT_BASE_DIR = join(tmpdir(), "steamtrain-worktrees");
const repoQueues = new Map<string, Promise<void>>();

export function createGitWorktreeManager(
  options: GitWorktreeManagerOptions = {},
): AgentWorkspaceManager {
  return new GitWorktreeManager(options);
}

class GitWorktreeManager implements AgentWorkspaceManager {
  private readonly baseDir: string;
  readonly runId: string;
  /** Repo roots already swept by this manager (once per run, see `sweep`). */
  private readonly swept = new Set<string>();
  /** Worktrees of `retainWorkspace: false` steps, discarded when the run ends. */
  private readonly disposable: { repoRoot: string; root: string; branch: string }[] = [];

  constructor(options: GitWorktreeManagerOptions) {
    this.baseDir = options.baseDir ?? DEFAULT_BASE_DIR;
    this.runId = options.runId ?? randomId();
  }

  async allocate(request: AgentWorkspaceRequest): Promise<AgentWorkspaceLease> {
    throwIfAborted(request.signal);
    if (request.attachTo) return this.attachLease(request);

    const repo = await discoverGitRepo(request.stepCwd, request.signal);
    if (!repo) return originalCwdLease(request.stepCwd);

    const stepCwd = await canonicalPath(request.stepCwd);
    const relativeStepCwd = relative(repo.root, stepCwd);
    if (isOutside(relativeStepCwd)) return originalCwdLease(request.stepCwd);

    const repoDir = `${safeRefPart(basename(repo.root))}-${shortHash(repo.root)}`;
    const stepPart = safeRefPart(`${request.stepId}-${request.iteration}`);
    const unique = randomId();
    const worktreeRoot = join(this.baseDir, repoDir, this.runId, `${stepPart}-${unique}`);
    const branch = `steamtrain/${this.runId}/${stepPart}-${unique}`;
    let linkedIgnoredPaths: string[] = [];
    let worktreeHead = repo.head;

    // Inheritance: snapshot the source step's worktree instead of the user's
    // checkout — branch from ITS HEAD (so committed changes carry over) and
    // copy ITS working-tree state (so uncommitted edits and new files do too).
    const inherit = request.inheritFrom;
    if (inherit) {
      const exists = await lstat(inherit.root).then(
        (st) => st.isDirectory(),
        () => false,
      );
      if (!exists) {
        throw new Error(
          `cannot inherit workspace of step '${inherit.stepId}': its worktree no longer exists at ${inherit.root} (pruned or cleaned up?)`,
        );
      }
    }
    const snapshotSource = inherit ? inherit.root : repo.root;

    await mkdir(dirname(worktreeRoot), { recursive: true });
    try {
      await this.inRepoQueue(repo.root, request.signal, async () => {
        throwIfAborted(request.signal);
        await this.sweep(repo.root, request.signal);
        worktreeHead = await currentGitHead(snapshotSource, request.signal);
        await runGit(
          ["worktree", "add", "-b", branch, worktreeRoot, worktreeHead],
          repo.root,
          undefined,
          request.signal,
        );
      });
      linkedIgnoredPaths = await copyWorkingTreeState(
        snapshotSource,
        worktreeRoot,
        worktreeHead,
        request.signal,
      );
    } catch (err) {
      await removeWorktreeBestEffort(repo.root, worktreeRoot, branch);
      throw err;
    }

    if (request.retainWorkspace === false) {
      this.disposable.push({ repoRoot: repo.root, root: worktreeRoot, branch });
    }

    return {
      cwd: relativeStepCwd ? join(worktreeRoot, relativeStepCwd) : worktreeRoot,
      root: worktreeRoot,
      branch,
      // An inherited worktree keeps the CHAIN's diff base: merging it back
      // lands the inherited edits plus this step's own, so the tail of an
      // implement → review chain carries the whole pipeline's work.
      baseCommit: inherit ? (inherit.baseCommit ?? worktreeHead) : worktreeHead,
      linkedIgnoredPaths,
      // Intentionally a no-op: worktrees are retained after the run so users
      // can inspect, commit, or merge agent-created files from the recorded
      // branch. Lifecycle closure is explicit — a merge step's `cleanup`,
      // `history apply/prune`, or `workflow worktrees prune` (see gc.ts).
      dispose: () => {},
    };
  }

  /**
   * `attach:<stepId>` support: no `git worktree add`, no state copy — just
   * re-root this request's `stepCwd` into the already-existing `attachTo.root`
   * using the SAME relative-path logic the main `allocate` path uses for
   * `inherit`, and carry the source's root/branch/baseCommit over verbatim.
   */
  private async attachLease(request: AgentWorkspaceRequest): Promise<AgentWorkspaceLease> {
    const attach = request.attachTo as NonNullable<AgentWorkspaceRequest["attachTo"]>;
    const exists = await lstat(attach.root).then(
      (st) => st.isDirectory(),
      () => false,
    );
    if (!exists) {
      throw new Error(
        `cannot attach to workspace of step '${attach.stepId}': its worktree no longer exists at ${attach.root} (pruned or cleaned up?)`,
      );
    }
    let cwd = attach.root;
    const repo = await discoverGitRepo(request.stepCwd, request.signal);
    if (repo) {
      const stepCwd = await canonicalPath(request.stepCwd);
      const relativeStepCwd = relative(repo.root, stepCwd);
      if (relativeStepCwd && !isOutside(relativeStepCwd)) {
        cwd = join(attach.root, relativeStepCwd);
      }
    }
    return {
      cwd,
      root: attach.root,
      branch: attach.branch,
      baseCommit: attach.baseCommit,
      linkedIgnoredPaths: attach.linkedIgnoredPaths,
      dispose: () => {},
    };
  }

  async reserveKeptDir(
    label: string,
    repoCwd: string,
    signal?: AbortSignal,
  ): Promise<{ dir: string; branch: string } | undefined> {
    const repo = await discoverGitRepo(repoCwd, signal);
    if (!repo) return undefined;
    const repoDir = `${safeRefPart(basename(repo.root))}-${shortHash(repo.root)}`;
    const stepPart = safeRefPart(label);
    const unique = randomId();
    const dir = join(this.baseDir, repoDir, this.runId, `${stepPart}-${unique}`);
    const branch = `steamtrain/${this.runId}/${stepPart}-${unique}`;
    return { dir, branch };
  }

  /**
   * Discard every `retainWorkspace: false` worktree this run created. Runs
   * under the repo lock (a `worktree remove` racing a sibling run's
   * `worktree add` corrupts the registry) and forgets each entry as it goes,
   * so a second call after a partial failure is a no-op for what already went.
   */
  async reclaimDisposable(): Promise<void> {
    const pending = this.disposable.splice(0);
    if (pending.length === 0) return;
    const byRepo = new Map<string, typeof pending>();
    for (const entry of pending) {
      const list = byRepo.get(entry.repoRoot) ?? [];
      list.push(entry);
      byRepo.set(entry.repoRoot, list);
    }
    for (const [repoRoot, entries] of byRepo) {
      await withRepoWorktreeLock(repoRoot, undefined, async () => {
        for (const entry of entries) {
          await removeWorktreeBestEffort(repoRoot, entry.root, entry.branch);
        }
        await runGit(["worktree", "prune"], repoRoot).catch(() => {});
      }).catch(() => {});
    }
  }

  /**
   * Drop registrations whose worktree directory is gone, once per repo per run.
   *
   * Step worktrees are deliberately retained after a run (see `dispose`), but
   * they live under the OS temp dir — the tmp reaper deletes the directories
   * while `.git/worktrees/<name>` registrations survive, so a repo steamtrain
   * runs against accumulates hundreds of dead entries. That is not merely
   * untidy: agent CLIs derive their command sandbox from the registered
   * worktree paths, and past a few hundred entries every shell command the
   * agent runs dies with E2BIG, so agent steps silently do nothing while the
   * workflow loops and never lands. `git worktree prune` removes ONLY entries
   * whose directory no longer exists, so it can never discard live work.
   */
  private async sweep(repoRoot: string, signal?: AbortSignal): Promise<void> {
    if (this.swept.has(repoRoot)) return;
    this.swept.add(repoRoot);
    // Best-effort: a failed prune must never block the run that needed a
    // worktree — the pre-existing entries are exactly as bad as before.
    await runGit(["worktree", "prune"], repoRoot, undefined, signal).catch(() => {});
  }

  private inRepoQueue<T>(
    repoRoot: string,
    signal: AbortSignal | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    return withRepoWorktreeLock(repoRoot, signal, fn);
  }
}

/**
 * Serialize `git worktree add` (and similar ref/index-mutating setup) per
 * repository — concurrent adds on the same repo race on refs and fail. Combines
 * an in-process promise queue with the cross-process project state lock so a
 * second steamtrain instance cannot race the first. Shared by the worktree
 * manager and the merge-back harvest pipeline.
 */
export async function withRepoWorktreeLock<T>(
  repoRoot: string,
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
  lockOptions?: ProjectLockOptions,
): Promise<T> {
  const previous = repoQueues.get(repoRoot) ?? Promise.resolve();
  const run = (async () => {
    await previous.catch(() => {});
    throwIfAborted(signal);
    return withProjectStateLock(repoRoot, fn, { ...lockOptions, signal });
  })();
  const current = run.then(
    () => {},
    () => {},
  );
  current.then(() => {
    if (repoQueues.get(repoRoot) === current) repoQueues.delete(repoRoot);
  });
  repoQueues.set(repoRoot, current);
  return signal ? await raceWithAbort(run, signal) : await run;
}

async function discoverGitRepo(cwd: string, signal?: AbortSignal): Promise<GitRepo | undefined> {
  try {
    const root = (await runGitText(["rev-parse", "--show-toplevel"], cwd, signal)).trim();
    const head = await currentGitHead(root, signal);
    if (!root || !head) return undefined;
    return { root: await canonicalPath(root), head };
  } catch {
    throwIfAborted(signal);
    return undefined;
  }
}

async function currentGitHead(repoRoot: string, signal?: AbortSignal): Promise<string> {
  return (await runGitText(["rev-parse", "--verify", "HEAD"], repoRoot, signal)).trim();
}

async function copyWorkingTreeState(
  repoRoot: string,
  worktreeRoot: string,
  head: string,
  signal?: AbortSignal,
): Promise<string[]> {
  throwIfAborted(signal);
  const diff = await runGit(["diff", "--binary", head, "--"], repoRoot, undefined, signal);
  if (diff.length > 0) {
    await runGit(["apply", "--binary", "-"], worktreeRoot, diff, signal);
  }

  const untracked = await runGit(
    ["ls-files", "--others", "--exclude-standard", "-z"],
    repoRoot,
    undefined,
    signal,
  );
  for (const rel of splitNul(untracked)) {
    throwIfAborted(signal);
    // Engine-owned run state (history/cache) never rides along into a fresh
    // worktree: in a repo that doesn't gitignore `.steamtrain`, copying it
    // gives every parallel worktree a different snapshot of the cache, which
    // a merge-back would then try to reconcile as if it were the agent's work.
    if (isSteamtrainStatePath(rel)) continue;
    await copyUntrackedPath(join(repoRoot, rel), join(worktreeRoot, rel));
  }

  return linkIgnoredRuntimeEntries(repoRoot, worktreeRoot, signal);
}

async function linkIgnoredRuntimeEntries(
  repoRoot: string,
  worktreeRoot: string,
  signal?: AbortSignal,
): Promise<string[]> {
  throwIfAborted(signal);
  const ignored = await runGit(
    ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
    repoRoot,
    undefined,
    signal,
  );
  const linkRoots = new Set<string>();
  for (const rel of splitNul(ignored)) {
    throwIfAborted(signal);
    // Never symlink the engine's own run state into a worktree: an agent
    // step could then edit the real run's history/cache through the link.
    if (isSteamtrainStatePath(rel)) continue;
    const root = await ignoredLinkRoot(rel, worktreeRoot);
    if (root) linkRoots.add(root);
  }

  const linked: string[] = [];
  for (const rel of [...linkRoots].sort()) {
    throwIfAborted(signal);
    try {
      const source = join(repoRoot, rel);
      const dest = join(worktreeRoot, rel);
      await mkdir(dirname(dest), { recursive: true });
      // Copy ignore-rule files instead of symlinking them. A nested
      // `.gitignore` that lists `.gitignore` (self-ignore) becomes an ELOOP
      // when git reads it through a symlink, which then breaks *all* exclude
      // matching in the worktree and leaves every linked runtime path as
      // untracked dirt — enough to make `pr rebase` refuse the checkout.
      if (isIgnoreRuleFile(rel)) {
        await copyUntrackedPath(source, dest);
      } else {
        await symlink(source, dest);
      }
      linked.push(rel);
    } catch {
      // Best effort: the agent can still run if a runtime-only ignored path
      // races with another process or is not representable as a symlink.
    }
  }
  return linked;
}

/** Basename matches git's exclude-file conventions (`.gitignore`, `.ignore`, …). */
function isIgnoreRuleFile(rel: string): boolean {
  const base = rel.split(/[\\/]+/).pop() ?? rel;
  return base === ".gitignore" || base === ".ignore" || base === "exclude";
}

async function ignoredLinkRoot(rel: string, worktreeRoot: string): Promise<string | undefined> {
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  for (let i = 1; i <= parts.length; i++) {
    const candidate = parts.slice(0, i).join(sep);
    try {
      await lstat(join(worktreeRoot, candidate));
    } catch {
      return candidate;
    }
  }
  return undefined;
}

async function copyUntrackedPath(source: string, dest: string): Promise<void> {
  const stat = await lstat(source);
  await mkdir(dirname(dest), { recursive: true });
  if (stat.isSymbolicLink()) {
    await symlink(await readlink(source), dest);
  } else if (stat.isFile()) {
    await copyFile(source, dest);
  }
  // Git reports untracked files, not empty directories. Non-empty directories
  // are copied file-by-file as their contents appear in `ls-files --others`.
}

async function removeWorktreeBestEffort(
  repoRoot: string,
  worktreeRoot: string,
  branch: string,
): Promise<void> {
  await runGit(["worktree", "remove", "--force", worktreeRoot], repoRoot).catch(() => {});
  await runGit(["branch", "-D", branch], repoRoot).catch(() => {});
}

function originalCwdLease(cwd: string): AgentWorkspaceLease {
  return { cwd, dispose: () => {} };
}

async function canonicalPath(path: string): Promise<string> {
  return resolve(await realpath(path));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("cancelled");
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    if (signal.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error("cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function splitNul(buf: Buffer): string[] {
  return buf
    .toString("utf8")
    .split("\0")
    .filter((part) => part.length > 0);
}

function safeRefPart(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return sanitized.length > 0 ? sanitized : "step";
}

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function randomId(): string {
  return randomBytes(5).toString("hex");
}

/**
 * Cap on buffered stdout/stderr from a single `git` child. Worktree snapshot
 * copies (`git diff --binary`) of a dirty tree can otherwise grow without
 * bound inside the orchestrator.
 */
export const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;

export async function runGitText(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  env?: Record<string, string>,
): Promise<string> {
  return (await runGit(args, cwd, undefined, signal, env)).toString("utf8");
}

export function runGit(
  args: string[],
  cwd: string,
  input?: Buffer,
  signal?: AbortSignal,
  env?: Record<string, string>,
): Promise<Buffer> {
  throwIfAborted(signal);
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const child = spawn("git", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : undefined,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let oversized = false;
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      cleanup();
      reject(new Error("cancelled"));
    };

    const capture =
      (side: "stdout" | "stderr") =>
      (chunk: Buffer): void => {
        if (settled || oversized) return;
        if (side === "stdout") {
          stdout.push(chunk);
          stdoutBytes += chunk.length;
          if (stdoutBytes > MAX_GIT_OUTPUT_BYTES) {
            oversized = true;
            try {
              child.kill("SIGTERM");
            } catch {
              // already gone
            }
            settled = true;
            cleanup();
            reject(
              new Error(
                `git ${args.join(" ")} exceeded ${Math.round(MAX_GIT_OUTPUT_BYTES / (1024 * 1024))} MiB output cap`,
              ),
            );
          }
          return;
        }
        stderr.push(chunk);
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_GIT_OUTPUT_BYTES) {
          // Keep collecting a bounded stderr for the error message; drop older.
          while (stderrBytes > MAX_GIT_OUTPUT_BYTES && stderr.length > 1) {
            const dropped = stderr.shift() as Buffer;
            stderrBytes -= dropped.length;
          }
        }
      };

    child.stdout.on("data", capture("stdout"));
    child.stderr.on("data", capture("stderr"));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code === 0) {
        resolvePromise(Buffer.concat(stdout));
        return;
      }
      const message = Buffer.concat(stderr).toString("utf8").trim();
      reject(new Error(`git ${args.join(" ")} failed${message ? `: ${message}` : ""}`));
    });
    signal?.addEventListener("abort", onAbort, { once: true });

    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}
