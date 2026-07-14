import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli";
import {
  type AgentWorkspaceLease,
  type HistoryPhase,
  type RunRecord,
  WORKFLOW_HISTORY_DIR,
  computeRunTotals,
  createGitWorktreeManager,
  createWorkflowHistoryStore,
  gcRepoWorktrees,
  listRepoWorktrees,
} from "../src/workflow";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

describe("repo-wide worktree GC", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("lists worktrees with change detection and prunes only stale entries by default", async () => {
    const { repo, allocate } = await makeRepo();
    const changed = await allocate("edited", async (root) => {
      await writeFile(join(root, "new.txt"), "agent work\n");
    });
    const clean = await allocate("untouched", async () => {});

    let entries = await listRepoWorktrees(repo, []);
    expect(entries).toHaveLength(2);
    const changedEntry = entries.find((e) => e.branch === changed.branch);
    const cleanEntry = entries.find((e) => e.branch === clean.branch);
    expect(changedEntry?.exists).toBe(true);
    expect(changedEntry?.changed).toBe(true);
    expect(cleanEntry?.changed).toBe(false);
    expect(changedEntry?.record).toBeUndefined();

    // No selector: nothing is stale yet, so nothing is pruned.
    let result = await gcRepoWorktrees({ repoRoot: repo, records: [] });
    expect(result.removed).toHaveLength(0);
    expect(result.kept).toHaveLength(2);

    // Simulate the OS tmp reaper eating the clean worktree's directory.
    await rm(clean.root!, { recursive: true, force: true });
    entries = await listRepoWorktrees(repo, []);
    expect(entries.find((e) => e.branch === clean.branch)?.exists).toBe(false);

    result = await gcRepoWorktrees({ repoRoot: repo, records: [] });
    expect(result.removed.map((e) => e.branch)).toEqual([clean.branch]);
    // The stale branch and registration are gone; the live one remains.
    const branches = await git(repo, "branch", "--list", "steamtrain/*");
    expect(branches).not.toContain(clean.branch);
    expect(branches).toContain(changed.branch);
  });

  it("protects unharvested work from --all unless --force, and honors dry-run", async () => {
    const { repo, allocate } = await makeRepo();
    const worked = await allocate("worked", async (root) => {
      await writeFile(join(root, "new.txt"), "unlanded work\n");
    });
    const idle = await allocate("idle", async () => {});

    const dry = await gcRepoWorktrees({ repoRoot: repo, records: [], all: true, dryRun: true });
    expect(dry.removed.map((e) => e.branch)).toEqual([idle.branch]);
    expect(dry.skipped[0]?.entry.branch).toBe(worked.branch);
    expect(dry.skipped[0]?.reason).toContain("unharvested");
    // Dry run touched nothing.
    expect(await git(repo, "branch", "--list", "steamtrain/*")).toContain(idle.branch);

    const real = await gcRepoWorktrees({ repoRoot: repo, records: [], all: true });
    expect(real.removed.map((e) => e.branch)).toEqual([idle.branch]);
    expect(real.skipped).toHaveLength(1);

    const forced = await gcRepoWorktrees({ repoRoot: repo, records: [], all: true, force: true });
    expect(forced.removed.map((e) => e.branch)).toEqual([worked.branch]);
    expect(await git(repo, "branch", "--list", "steamtrain/*")).toBe("");
  });

  it("prunes only entries older than the --older-than threshold", async () => {
    const { repo, allocate } = await makeRepo();
    const old = await allocate("old", async () => {});
    const fresh = await allocate("fresh", async () => {});
    // Without a run record the age heuristic falls back to the worktree
    // directory's mtime — backdate the old one past the threshold.
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await utimes(old.root as string, tenDaysAgo, tenDaysAgo);

    const result = await gcRepoWorktrees({
      repoRoot: repo,
      records: [],
      olderThanMs: 7 * 24 * 60 * 60 * 1000,
    });
    expect(result.removed.map((e) => e.branch)).toEqual([old.branch]);
    expect(result.kept.map((e) => e.branch)).toEqual([fresh.branch]);
    expect(result.skipped).toHaveLength(0);
    const branches = await git(repo, "branch", "--list", "steamtrain/*");
    expect(branches).not.toContain(old.branch);
    expect(branches).toContain(fresh.branch);
  });

  it("treats recorded harvested runs as safe to prune and never touches merged branches", async () => {
    const { repo, allocate } = await makeRepo();
    const lease = await allocate("landed", async (root) => {
      await writeFile(join(root, "new.txt"), "landed work\n");
    });
    // A deliverable branch from a previous merge step must never be GC'd.
    await git(repo, "branch", "steamtrain/merged/some-deliverable");

    const record = recordWith(repo, lease, { appliedSteps: ["landed"], appliedAt: Date.now() });
    const entries = await listRepoWorktrees(repo, [record]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.record?.applied).toBe(true);

    const result = await gcRepoWorktrees({ repoRoot: repo, records: [record], all: true });
    expect(result.removed).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
    const branches = await git(repo, "branch", "--list", "steamtrain/*");
    expect(branches).toContain("steamtrain/merged/some-deliverable");
    expect(branches).not.toContain(lease.branch as string);
  });

  it("is exposed as 'workflow worktrees list|prune' in the CLI", async () => {
    const { repo, allocate } = await makeRepo();
    const lease = await allocate("cli-step", async (root) => {
      await writeFile(join(root, "new.txt"), "work\n");
    });
    const store = createWorkflowHistoryStore(join(repo, WORKFLOW_HISTORY_DIR));
    const record = recordWith(repo, lease, undefined);
    await store.save(record);

    const list = await cli(repo, ["workflow", "worktrees"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(lease.branch as string);
    expect(list.stdout).toContain("has changes");
    expect(list.stdout).toContain(`run ${record.id}`);

    // Unharvested work is protected...
    const guarded = await cli(repo, ["workflow", "worktrees", "prune", "--all"]);
    expect(guarded.code).toBe(0);
    expect(guarded.stdout).toContain("skipped");

    // ...and --force removes it, marking the run pruned in history.
    const forced = await cli(repo, ["workflow", "worktrees", "prune", "--all", "--force"]);
    expect(forced.code).toBe(0);
    expect(forced.stdout).toContain("pruned 1 worktree(s)");
    expect(await git(repo, "branch", "--list", "steamtrain/*")).toBe("");
    const updated = await store.get(record.id);
    expect(updated?.harvest?.prunedAt).toBeTypeOf("number");
  });
});

interface Harness {
  repo: string;
  allocate: (stepId: string, edit: (root: string) => Promise<void>) => Promise<AgentWorkspaceLease>;
}

async function makeRepo(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "steamtrain-gc-test-"));
  tempRoots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "Test User");
  await writeFile(join(repo, "README.md"), "hello\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial");

  const manager = createGitWorktreeManager({
    baseDir: join(root, "worktrees"),
    runId: "gc-run",
  });
  return {
    repo,
    allocate: async (stepId, edit) => {
      const lease = await manager.allocate({
        workflowName: "demo",
        stepId,
        agent: "claude",
        baseCwd: repo,
        stepCwd: repo,
        iteration: 1,
      });
      if (!lease.root || !lease.branch) throw new Error("expected worktree lease");
      await edit(lease.root);
      return lease;
    },
  };
}

function recordWith(
  repo: string,
  lease: AgentWorkspaceLease,
  harvest: RunRecord["harvest"],
): RunRecord {
  const phases: HistoryPhase[] = [
    {
      phaseId: "impl",
      title: "Implement",
      index: 0,
      stepCount: 1,
      done: true,
      ok: true,
      steps: [
        {
          stepId: "landed",
          blockKind: "worker",
          agent: "claude",
          model: "m",
          status: "done",
          text: "done",
          cached: false,
          worktree: {
            originalCwd: repo,
            cwd: lease.cwd,
            root: lease.root as string,
            branch: lease.branch as string,
            baseCommit: lease.baseCommit,
          },
        },
      ],
    },
  ];
  return {
    version: 1,
    id: "gc-record",
    workflow: "demo",
    input: "task",
    cwd: repo,
    status: "done",
    ok: true,
    startedAt: Date.now() - 1000,
    endedAt: Date.now(),
    durationMs: 1000,
    phases,
    totals: computeRunTotals(phases),
    harvest,
  };
}

async function cli(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, {
    cwd,
    stdout: (t) => {
      stdout += t;
    },
    stderr: (t) => {
      stderr += t;
    },
  });
  return { code, stdout, stderr };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}
