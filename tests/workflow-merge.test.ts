import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createGitWorktreeManager } from "../src/workflow";
import {
  MergeConflictError,
  type WorktreeSource,
  harvestWorktrees,
  pruneWorktree,
  snapshotWorktreeState,
  worktreeDiff,
} from "../src/workflow/merge";

const execFileAsync = promisify(execFile);

const tempRoots: string[] = [];
let leaseCounter = 0;

describe("worktree merge-back core", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("diffs a worktree's tracked, untracked, and deleted changes without mutating it", async () => {
    const { repo, allocate } = await repoWithManager();
    const source = await allocate("edit");
    await writeFile(join(source.root, "src", "a.txt"), "changed\n");
    await writeFile(join(source.root, "src", "new.txt"), "brand new\n");
    await rm(join(source.root, "src", "b.txt"));

    const before = await git(source.root, "status", "--porcelain");
    const diff = await worktreeDiff(source, { patch: true });
    const after = await git(source.root, "status", "--porcelain");

    expect(after).toBe(before);
    const byPath = new Map(diff.files.map((f) => [f.path, f]));
    expect(byPath.get("src/a.txt")?.status).toBe("M");
    expect(byPath.get("src/new.txt")?.status).toBe("A");
    expect(byPath.get("src/b.txt")?.status).toBe("D");
    expect(diff.additions).toBeGreaterThan(0);
    expect(diff.deletions).toBeGreaterThan(0);
    expect(diff.patch).toContain("brand new");
    expect(diff.patch).toContain("changed");
    void repo;
  });

  it("snapshots worktree state into a commit on the steamtrain branch", async () => {
    const { allocate } = await repoWithManager();
    const source = await allocate("snap");
    const untouched = await snapshotWorktreeState(source);
    expect(untouched.changed).toBe(false);

    await writeFile(join(source.root, "src", "a.txt"), "snapshot me\n");
    const snap = await snapshotWorktreeState(source);
    expect(snap.changed).toBe(true);
    expect(await git(source.root, "status", "--porcelain")).toBe("");
    const subject = await git(source.root, "log", "-1", "--format=%s");
    expect(subject).toContain("steamtrain: snapshot");
  });

  it("applies two non-conflicting worktrees to the workspace as uncommitted changes", async () => {
    const { repo, allocate } = await repoWithManager();
    const first = await allocate("impl-a");
    const second = await allocate("impl-b");
    await writeFile(join(first.root, "src", "a.txt"), "from first\n");
    await writeFile(join(second.root, "src", "b.txt"), "from second\n");

    const result = await harvestWorktrees({
      repoRoot: repo,
      sources: [first, second],
      mode: "apply",
    });

    expect(result.noChanges).toBe(false);
    expect(result.mergedSources).toEqual(["impl-a", "impl-b"]);
    expect(result.conflicts).toEqual([]);
    expect(result.files.map((f) => f.path).sort()).toEqual(["src/a.txt", "src/b.txt"]);
    expect(await readFile(join(repo, "src", "a.txt"), "utf8")).toBe("from first\n");
    expect(await readFile(join(repo, "src", "b.txt"), "utf8")).toBe("from second\n");
    // Applied, not committed: the workspace should show dirty files and no new commits.
    expect(await git(repo, "status", "--porcelain")).not.toBe("");
    expect(await git(repo, "log", "--oneline")).not.toContain("steamtrain");
    // The throwaway staging branch is deleted in apply mode.
    const branches = await git(repo, "branch", "--list", "steamtrain/merged/*");
    expect(branches).toBe("");
  });

  it("applies changes outside a subdirectory repoRoot (resolves the repo top level)", async () => {
    const { repo, allocate } = await repoWithManager();
    const source = await allocate("subdir");
    // A change at the repo root, applied with repoRoot pointing at src/ —
    // `git apply` run from a subdirectory silently skips out-of-tree paths.
    await writeFile(join(source.root, "top.txt"), "top-level file\n");

    const result = await harvestWorktrees({
      repoRoot: join(repo, "src"),
      sources: [source],
      mode: "apply",
    });

    expect(result.noChanges).toBe(false);
    expect(result.files.map((f) => f.path)).toEqual(["top.txt"]);
    expect(await readFile(join(repo, "top.txt"), "utf8")).toBe("top-level file\n");
  });

  it("reports a rename as a single entry keyed by the new path", async () => {
    const { allocate } = await repoWithManager();
    const source = await allocate("rename");
    await git(source.root, "mv", "src/a.txt", "src/renamed.txt");

    const diff = await worktreeDiff(source);

    const paths = diff.files.map((f) => f.path).sort();
    expect(paths).toEqual(["src/renamed.txt"]);
    expect(diff.files[0]?.status).toBe("R");
  });

  it("harvests sources without a recorded baseCommit (legacy records)", async () => {
    const { repo, allocate } = await repoWithManager();
    const source = await allocate("legacy");
    await writeFile(join(source.root, "src", "a.txt"), "legacy change\n");
    // Older run records predate baseCommit; the merge-base fallback must
    // resolve against the pre-snapshot HEAD or every source looks unchanged.
    const legacy: WorktreeSource = { ...source, baseCommit: undefined };

    const result = await harvestWorktrees({ repoRoot: repo, sources: [legacy], mode: "apply" });

    expect(result.noChanges).toBe(false);
    expect(result.mergedSources).toEqual(["legacy"]);
    expect(await readFile(join(repo, "src", "a.txt"), "utf8")).toBe("legacy change\n");
  });

  it("reports no changes when every source worktree is untouched", async () => {
    const { repo, allocate } = await repoWithManager();
    const source = await allocate("idle");
    const result = await harvestWorktrees({ repoRoot: repo, sources: [source], mode: "apply" });
    expect(result.noChanges).toBe(true);
    expect(result.unchangedSources).toEqual(["idle"]);
    expect(await git(repo, "status", "--porcelain")).toBe("");
  });

  it("fails with MergeConflictError when sources conflict and no resolver is given", async () => {
    const { repo, allocate } = await repoWithManager();
    const first = await allocate("left");
    const second = await allocate("right");
    await writeFile(join(first.root, "src", "a.txt"), "left version\n");
    await writeFile(join(second.root, "src", "a.txt"), "right version\n");

    await expect(
      harvestWorktrees({ repoRoot: repo, sources: [first, second], mode: "apply" }),
    ).rejects.toThrow(MergeConflictError);
    expect(await git(repo, "status", "--porcelain")).toBe("");
  });

  it("resolves conflicts through the resolver callback and records them", async () => {
    const { repo, allocate } = await repoWithManager();
    const first = await allocate("left");
    const second = await allocate("right");
    await writeFile(join(first.root, "src", "a.txt"), "left version\n");
    await writeFile(join(second.root, "src", "a.txt"), "right version\n");

    const seen: string[][] = [];
    const result = await harvestWorktrees({
      repoRoot: repo,
      sources: [first, second],
      mode: "apply",
      resolveConflicts: async ({ stagingRoot, files }) => {
        seen.push(files);
        await writeFile(join(stagingRoot, "src", "a.txt"), "resolved version\n");
      },
    });

    expect(seen).toEqual([["src/a.txt"]]);
    expect(result.conflicts).toEqual([
      { stepId: "right", files: ["src/a.txt"], resolvedBy: "agent" },
    ]);
    expect(await readFile(join(repo, "src", "a.txt"), "utf8")).toBe("resolved version\n");
  });

  it("resolves conflicts deterministically with -X theirs", async () => {
    const { repo, allocate } = await repoWithManager();
    const first = await allocate("left");
    const second = await allocate("right");
    await writeFile(join(first.root, "src", "a.txt"), "hello left\n");
    await writeFile(join(second.root, "src", "a.txt"), "hello right\n");

    const result = await harvestWorktrees({
      repoRoot: repo,
      sources: [first, second],
      mode: "apply",
      strategyOption: "theirs",
    });
    expect(result.noChanges).toBe(false);
    expect(await readFile(join(repo, "src", "a.txt"), "utf8")).toBe("hello right\n");
  });

  it("leaves the merged state on a named branch in branch mode", async () => {
    const { repo, allocate } = await repoWithManager();
    const source = await allocate("feature");
    await writeFile(join(source.root, "src", "a.txt"), "on a branch\n");

    const result = await harvestWorktrees({
      repoRoot: repo,
      sources: [source],
      mode: "branch",
      branchName: "steamtrain/merged/demo",
    });

    expect(result.branch).toBe("steamtrain/merged/demo");
    // Workspace untouched; the branch carries the merged state.
    expect(await git(repo, "status", "--porcelain")).toBe("");
    const show = await git(repo, "show", "steamtrain/merged/demo:src/a.txt");
    expect(show).toBe("on a branch");
  });

  it("refuses to apply over conflicting local edits, leaving the workspace intact", async () => {
    const { repo, allocate } = await repoWithManager();
    const source = await allocate("impl");
    await writeFile(join(source.root, "src", "a.txt"), "agent version\n");
    // Conflicting local edit in the user's checkout, made after the worktree
    // was taken.
    await writeFile(join(repo, "src", "a.txt"), "local competing edit\n");

    await expect(
      harvestWorktrees({ repoRoot: repo, sources: [source], mode: "apply" }),
    ).rejects.toThrow(/do not apply cleanly/);
    expect(await readFile(join(repo, "src", "a.txt"), "utf8")).toBe("local competing edit\n");
  });

  it("prunes a worktree and its branch", async () => {
    const { repo, allocate } = await repoWithManager();
    const source = await allocate("gone");
    expect(await pruneWorktree(source, repo)).toBe(true);
    await expect(readFile(join(source.root, "src", "a.txt"))).rejects.toThrow();
    const branches = await git(repo, "branch", "--list", source.branch);
    expect(branches).toBe("");
    await expect(worktreeDiff(source)).rejects.toThrow(/no longer exists/);
  });
});

interface RepoHarness {
  repo: string;
  allocate: (stepId: string) => Promise<WorktreeSource>;
}

async function repoWithManager(): Promise<RepoHarness> {
  const root = await mkdtemp(join(tmpdir(), "steamtrain-merge-test-"));
  tempRoots.push(root);
  const repo = join(root, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "Test User");
  await writeFile(join(repo, "src", "a.txt"), "hello\n");
  await writeFile(join(repo, "src", "b.txt"), "there\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial");

  const manager = createGitWorktreeManager({
    baseDir: join(root, "worktrees"),
    runId: `run-${leaseCounter++}`,
  });
  return {
    repo,
    allocate: async (stepId: string): Promise<WorktreeSource> => {
      const lease = await manager.allocate({
        workflowName: "demo",
        stepId,
        agent: "claude",
        baseCwd: repo,
        stepCwd: repo,
        iteration: 1,
      });
      if (!lease.root || !lease.branch) throw new Error("expected a git worktree lease");
      return {
        stepId,
        root: lease.root,
        branch: lease.branch,
        baseCommit: lease.baseCommit,
      };
    },
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}
