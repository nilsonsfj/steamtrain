import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createGitWorktreeManager } from "../src/workflow";

const execFileAsync = promisify(execFile);

const tempRoots: string[] = [];

describe("git worktree agent workspace manager", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("allocates unique worktrees and maps step cwd into each worktree", async () => {
    const root = await tempDir();
    const repo = join(root, "repo");
    const worktrees = join(root, "worktrees");
    await initRepo(repo);
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, ".gitignore"), ".env\nnode_modules/\n");
    await writeFile(join(repo, "src", "tracked.txt"), "committed\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "add src");

    await writeFile(join(repo, "src", "tracked.txt"), "dirty\n");
    await writeFile(join(repo, "src", "untracked.txt"), "new\n");
    await writeFile(join(repo, ".env"), "TOKEN=secret\n");
    await mkdir(join(repo, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(repo, "node_modules", ".bin", "tool"), "runtime\n");

    const manager = createGitWorktreeManager({ baseDir: worktrees, runId: "run-test" });
    const first = await manager.allocate({
      workflowName: "demo",
      stepId: "review[0]",
      agent: "claude",
      baseCwd: repo,
      stepCwd: join(repo, "src"),
      iteration: 1,
    });
    const second = await manager.allocate({
      workflowName: "demo",
      stepId: "review[1]",
      agent: "claude",
      baseCwd: repo,
      stepCwd: join(repo, "src"),
      iteration: 1,
    });

    expect(first.cwd).not.toBe(join(repo, "src"));
    expect(second.cwd).not.toBe(first.cwd);
    expect(await readFile(join(first.cwd, "tracked.txt"), "utf8")).toBe("dirty\n");
    expect(await readFile(join(first.cwd, "untracked.txt"), "utf8")).toBe("new\n");
    expect(await readFile(join(first.root ?? "", ".env"), "utf8")).toBe("TOKEN=secret\n");
    expect(await readFile(join(first.root ?? "", "node_modules", ".bin", "tool"), "utf8")).toBe(
      "runtime\n",
    );
    expect(first.linkedIgnoredPaths).toEqual([".env", "node_modules"]);
    expect(await git(first.cwd, "branch", "--show-current")).toMatch(
      /^steamtrain\/run-test\/review-0-1-/,
    );
    expect(await git(second.cwd, "branch", "--show-current")).toMatch(
      /^steamtrain\/run-test\/review-1-1-/,
    );
  });

  it("falls back to the original cwd outside a git repository", async () => {
    const root = await tempDir();
    const manager = createGitWorktreeManager({
      baseDir: join(root, "worktrees"),
      runId: "run-test",
    });
    const lease = await manager.allocate({
      workflowName: "demo",
      stepId: "a",
      agent: "claude",
      baseCwd: root,
      stepCwd: root,
      iteration: 1,
    });

    expect(lease.cwd).toBe(root);
    expect(lease.root).toBeUndefined();
    expect(lease.branch).toBeUndefined();
  });

  it("normalizes symlinked repo paths before mapping step cwd", async () => {
    const root = await tempDir();
    const repo = join(root, "repo");
    const repoLink = join(root, "repo-link");
    await initRepo(repo);
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "src", "tracked.txt"), "committed\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "add src");
    await symlink(repo, repoLink);

    const manager = createGitWorktreeManager({
      baseDir: join(root, "worktrees"),
      runId: "run-test",
    });
    const lease = await manager.allocate({
      workflowName: "demo",
      stepId: "a",
      agent: "claude",
      baseCwd: repoLink,
      stepCwd: join(repoLink, "src"),
      iteration: 1,
    });

    expect(lease.cwd).not.toBe(join(repoLink, "src"));
    expect(lease.root).toBeDefined();
    expect(await readFile(join(lease.cwd, "tracked.txt"), "utf8")).toBe("committed\n");
  });

  it("honors cancellation before creating a worktree", async () => {
    const root = await tempDir();
    const repo = join(root, "repo");
    await initRepo(repo);
    const controller = new AbortController();
    controller.abort();
    const manager = createGitWorktreeManager({
      baseDir: join(root, "worktrees"),
      runId: "run-test",
    });

    await expect(
      manager.allocate({
        workflowName: "demo",
        stepId: "a",
        agent: "claude",
        baseCwd: repo,
        stepCwd: repo,
        iteration: 1,
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "steamtrain-worktree-test-"));
  tempRoots.push(dir);
  return dir;
}

async function initRepo(repo: string): Promise<void> {
  await mkdir(repo, { recursive: true });
  await git(repo, "init");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "Test User");
  await writeFile(join(repo, "README.md"), "hello\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial");
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  await mkdir(dirname(cwd), { recursive: true });
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}
