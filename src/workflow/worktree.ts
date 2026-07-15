import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, readlink, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { AgentInstanceId } from "../types/events";
import { isOutside } from "./fs-util";
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
  private readonly runId: string;

  constructor(options: GitWorktreeManagerOptions) {
    this.baseDir = options.baseDir ?? DEFAULT_BASE_DIR;
    this.runId = options.runId ?? randomId();
  }

  async allocate(request: AgentWorkspaceRequest): Promise<AgentWorkspaceLease> {
    throwIfAborted(request.signal);
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
 * repository — concurrent adds on the same repo race on refs and fail. Shared
 * by the worktree manager and the merge-back harvest pipeline.
 */
export async function withRepoWorktreeLock<T>(
  repoRoot: string,
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = repoQueues.get(repoRoot) ?? Promise.resolve();
  const run = (async () => {
    await previous.catch(() => {});
    throwIfAborted(signal);
    return fn();
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
    const root = await ignoredLinkRoot(rel, worktreeRoot);
    if (root) linkRoots.add(root);
  }

  const linked: string[] = [];
  for (const rel of [...linkRoots].sort()) {
    throwIfAborted(signal);
    try {
      await symlink(join(repoRoot, rel), join(worktreeRoot, rel));
      linked.push(rel);
    } catch {
      // Best effort: the agent can still run if a runtime-only ignored path
      // races with another process or is not representable as a symlink.
    }
  }
  return linked;
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

export async function runGitText(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  return (await runGit(args, cwd, undefined, signal)).toString("utf8");
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

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
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
