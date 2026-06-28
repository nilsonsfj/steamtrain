import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readlink, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { AgentId } from "../types/events";
import type { WorkflowItem } from "./types";

export interface AgentWorkspaceRequest {
  workflowName: string;
  stepId: string;
  agent: AgentId;
  /** Original workflow cwd. */
  baseCwd: string;
  /** Resolved target cwd for this step in the original checkout. */
  stepCwd: string;
  iteration: number;
  item?: WorkflowItem;
}

export interface AgentWorkspaceLease {
  /** Cwd to pass to the agent subprocess. */
  cwd: string;
  /** Root of the isolated worktree when one was created. */
  root?: string;
  /** Branch checked out by the isolated worktree when one was created. */
  branch?: string;
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

export function createGitWorktreeManager(
  options: GitWorktreeManagerOptions = {},
): AgentWorkspaceManager {
  return new GitWorktreeManager(options);
}

class GitWorktreeManager implements AgentWorkspaceManager {
  private readonly baseDir: string;
  private readonly runId: string;
  private readonly repoQueues = new Map<string, Promise<void>>();

  constructor(options: GitWorktreeManagerOptions) {
    this.baseDir = options.baseDir ?? DEFAULT_BASE_DIR;
    this.runId = options.runId ?? randomId();
  }

  async allocate(request: AgentWorkspaceRequest): Promise<AgentWorkspaceLease> {
    const repo = await discoverGitRepo(request.stepCwd);
    if (!repo) return originalCwdLease(request.stepCwd);

    const relativeStepCwd = relative(repo.root, request.stepCwd);
    if (isOutside(relativeStepCwd)) return originalCwdLease(request.stepCwd);

    const repoDir = `${safeRefPart(basename(repo.root))}-${shortHash(repo.root)}`;
    const stepPart = safeRefPart(`${request.stepId}-${request.iteration}`);
    const unique = randomId();
    const worktreeRoot = join(this.baseDir, repoDir, this.runId, `${stepPart}-${unique}`);
    const branch = `steamtrain/${this.runId}/${stepPart}-${unique}`;

    await mkdir(dirname(worktreeRoot), { recursive: true });
    try {
      await this.inRepoQueue(repo.root, async () => {
        await runGit(["worktree", "add", "-b", branch, worktreeRoot, repo.head], repo.root);
      });
      await copyWorkingTreeState(repo.root, worktreeRoot);
    } catch (err) {
      await removeWorktreeBestEffort(repo.root, worktreeRoot, branch);
      throw err;
    }

    return {
      cwd: relativeStepCwd ? join(worktreeRoot, relativeStepCwd) : worktreeRoot,
      root: worktreeRoot,
      branch,
      dispose: () => {},
    };
  }

  private async inRepoQueue<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.repoQueues.get(repoRoot) ?? Promise.resolve();
    const run = (async () => {
      await previous.catch(() => {});
      return fn();
    })();
    const current = run.then(
      () => {},
      () => {},
    );
    this.repoQueues.set(repoRoot, current);
    try {
      return await run;
    } finally {
      if (this.repoQueues.get(repoRoot) === current) this.repoQueues.delete(repoRoot);
    }
  }
}

async function discoverGitRepo(cwd: string): Promise<GitRepo | undefined> {
  try {
    const root = (await runGitText(["rev-parse", "--show-toplevel"], cwd)).trim();
    const head = (await runGitText(["rev-parse", "--verify", "HEAD"], root)).trim();
    if (!root || !head) return undefined;
    return { root: resolve(root), head };
  } catch {
    return undefined;
  }
}

async function copyWorkingTreeState(repoRoot: string, worktreeRoot: string): Promise<void> {
  const diff = await runGit(["diff", "--binary", "HEAD", "--"], repoRoot);
  if (diff.length > 0) {
    await runGit(["apply", "--binary", "-"], worktreeRoot, diff);
  }

  const untracked = await runGit(["ls-files", "--others", "--exclude-standard", "-z"], repoRoot);
  for (const rel of splitNul(untracked)) {
    await copyUntrackedPath(join(repoRoot, rel), join(worktreeRoot, rel));
  }
}

async function copyUntrackedPath(source: string, dest: string): Promise<void> {
  const stat = await lstat(source);
  await mkdir(dirname(dest), { recursive: true });
  if (stat.isSymbolicLink()) {
    await symlink(await readlink(source), dest);
  } else if (stat.isFile()) {
    await copyFile(source, dest);
  }
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

function isOutside(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || resolve(rel) === rel;
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

async function runGitText(args: string[], cwd: string): Promise<string> {
  return (await runGit(args, cwd)).toString("utf8");
}

function runGit(args: string[], cwd: string, input?: Buffer): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(Buffer.concat(stdout));
        return;
      }
      const message = Buffer.concat(stderr).toString("utf8").trim();
      reject(new Error(`git ${args.join(" ")} failed${message ? `: ${message}` : ""}`));
    });

    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}
