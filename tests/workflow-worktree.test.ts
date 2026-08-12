import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

  it("copies nested .gitignore files instead of symlinking them", async () => {
    const root = await tempDir();
    const repo = join(root, "repo");
    const worktrees = join(root, "worktrees");
    await initRepo(repo);
    await mkdir(join(repo, ".opencode", "skills"), { recursive: true });
    await writeFile(join(repo, ".opencode", "skills", "SKILL.md"), "skill\n");
    // Nested ignore that self-lists `.gitignore` — the camelo failure mode.
    await writeFile(
      join(repo, ".opencode", ".gitignore"),
      "node_modules\npackage.json\n.gitignore\n",
    );
    await writeFile(join(repo, ".gitignore"), "");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "track skills");
    await mkdir(join(repo, ".opencode", "node_modules"), { recursive: true });
    await writeFile(join(repo, ".opencode", "node_modules", "x"), "runtime\n");

    const manager = createGitWorktreeManager({ baseDir: worktrees, runId: "gitignore-copy" });
    const lease = await manager.allocate({
      workflowName: "demo",
      stepId: "rebase",
      agent: "claude",
      baseCwd: repo,
      stepCwd: repo,
      iteration: 1,
    });

    const ignorePath = join(lease.root ?? "", ".opencode", ".gitignore");
    expect((await lstat(ignorePath)).isSymbolicLink()).toBe(false);
    expect(await readFile(ignorePath, "utf8")).toContain("node_modules");
    // Symlinking that file made git report ELOOP and left runtime links as ??
    // dirt; a real copy keeps exclude matching working.
    const status = await git(lease.cwd, "status", "--porcelain");
    expect(status).not.toMatch(/\.opencode\/\.gitignore/);
    expect(lease.linkedIgnoredPaths).toEqual(
      expect.arrayContaining([".opencode/.gitignore", ".opencode/node_modules"]),
    );
  });

  it("prunes registrations whose worktree directory is gone, keeping live ones", async () => {
    const root = await tempDir();
    const repo = join(root, "repo");
    const worktrees = join(root, "worktrees");
    await initRepo(repo);

    // A reaped worktree: registered, then its directory deleted behind git's
    // back — exactly what the OS tmp reaper does to retained step worktrees.
    const reaped = join(root, "reaped");
    await git(repo, "worktree", "add", "-b", "steamtrain/old/step", reaped);
    await rm(reaped, { recursive: true, force: true });
    // A worktree that still exists must survive the sweep.
    const live = join(root, "live");
    await git(repo, "worktree", "add", "-b", "steamtrain/old/live", live);

    const manager = createGitWorktreeManager({ baseDir: worktrees, runId: "sweep" });
    await manager.allocate({
      workflowName: "demo",
      stepId: "a",
      agent: "claude",
      baseCwd: repo,
      stepCwd: repo,
      iteration: 1,
    });

    const listed = await git(repo, "worktree", "list");
    expect(listed).not.toContain(reaped);
    expect(listed).toContain(live);
  });

  it("discards retainWorkspace:false worktrees at reclaim, keeping retained ones", async () => {
    const root = await tempDir();
    const repo = join(root, "repo");
    await initRepo(repo);
    const manager = createGitWorktreeManager({
      baseDir: join(root, "worktrees"),
      runId: "disposable",
    });
    const base = {
      workflowName: "demo",
      agent: "claude" as const,
      baseCwd: repo,
      stepCwd: repo,
      iteration: 1,
    };
    const disposable = await manager.allocate({
      ...base,
      stepId: "rebase",
      retainWorkspace: false,
    });
    const retained = await manager.allocate({ ...base, stepId: "implement" });
    // Even work left behind goes: the step declared it has no local deliverable.
    await writeFile(join(disposable.root as string, "scratch.txt"), "remote-only work\n");

    await manager.reclaimDisposable?.();

    expect(await lstat(disposable.root as string).catch(() => undefined)).toBeUndefined();
    expect((await lstat(retained.root as string)).isDirectory()).toBe(true);
    const branches = await git(repo, "branch", "--list", "steamtrain/*");
    expect(branches).not.toContain(disposable.branch as string);
    expect(branches).toContain(retained.branch as string);
  });

  it("releases a disposable worktree when its own step ends, not at run end", async () => {
    const root = await tempDir();
    const repo = join(root, "repo");
    await initRepo(repo);
    const manager = createGitWorktreeManager({
      baseDir: join(root, "worktrees"),
      runId: "steprelease",
    });
    const base = {
      workflowName: "demo",
      agent: "claude" as const,
      baseCwd: repo,
      stepCwd: repo,
      iteration: 1,
    };
    const disposable = await manager.allocate({
      ...base,
      stepId: "rebase",
      retainWorkspace: false,
    });
    const retained = await manager.allocate({ ...base, stepId: "implement" });

    await disposable.dispose();
    await retained.dispose();

    // Gone the moment its step ended — the run is still in flight.
    expect(await lstat(disposable.root as string).catch(() => undefined)).toBeUndefined();
    expect((await lstat(retained.root as string)).isDirectory()).toBe(true);
    const branches = await git(repo, "branch", "--list", "steamtrain/*");
    expect(branches).not.toContain(disposable.branch as string);

    // The run-end backstop finds nothing left and must not throw.
    await manager.reclaimDisposable?.();
    expect((await lstat(retained.root as string)).isDirectory()).toBe(true);
  });

  it("keeps live worktrees bounded by concurrency, not by steps executed", async () => {
    // The babysit failure mode: ONE run executes hundreds of disposable steps.
    // Agent CLIs derive their command sandbox from the repo's registered
    // worktrees, so a count that grows with total steps executed (rather than
    // with how many run at once) kills every agent command with E2BIG partway
    // through — long before the run-end cleanup that would have saved it.
    const root = await tempDir();
    const repo = join(root, "repo");
    await initRepo(repo);
    const manager = createGitWorktreeManager({
      baseDir: join(root, "worktrees"),
      runId: "fanout",
    });
    let peak = 0;
    for (let step = 0; step < 12; step++) {
      const lease = await manager.allocate({
        workflowName: "demo",
        agent: "claude" as const,
        baseCwd: repo,
        stepCwd: repo,
        iteration: 1,
        stepId: `prepare-${step}`,
        retainWorkspace: false,
      });
      const listed = await git(repo, "worktree", "list");
      peak = Math.max(peak, listed.split("\n").filter((line) => line.includes("fanout")).length);
      await lease.dispose();
    }
    expect(peak).toBe(1);
    const settled = await git(repo, "worktree", "list");
    expect(settled).not.toContain("fanout");
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
