import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli";
import {
  type HistoryPhase,
  type RunRecord,
  WORKFLOW_HISTORY_DIR,
  computeRunTotals,
  createGitWorktreeManager,
  createWorkflowHistoryStore,
} from "../src/workflow";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

describe("workflow history diff/apply/prune CLI", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("shows a per-step diff, applies it to the workspace, and prunes worktrees", async () => {
    const { repo, recordRun } = await makeRepoWithRun();
    const runId = await recordRun(async (worktree) => {
      await writeFile(join(worktree, "feature.txt"), "agent made this\n");
    });

    // --diff shows the change
    const diffOut = await cli(repo, ["workflow", "history", "show", runId, "--diff"]);
    expect(diffOut.code).toBe(0);
    expect(diffOut.stdout).toContain("A feature.txt");
    expect(diffOut.stdout).toContain("agent made this");

    // --diff --stat omits the patch body
    const statOut = await cli(repo, ["workflow", "history", "show", runId, "--diff", "--stat"]);
    expect(statOut.code).toBe(0);
    expect(statOut.stdout).toContain("A feature.txt");
    expect(statOut.stdout).not.toContain("+agent made this");

    // apply lands the change uncommitted and records harvest status
    const applyOut = await cli(repo, ["workflow", "history", "apply", runId]);
    expect(applyOut.code).toBe(0);
    expect(await readFile(join(repo, "feature.txt"), "utf8")).toBe("agent made this\n");
    expect(await git(repo, "status", "--porcelain")).toContain("feature.txt");
    const store = createWorkflowHistoryStore(join(repo, WORKFLOW_HISTORY_DIR));
    const applied = await store.get(runId);
    expect(applied?.harvest?.appliedSteps).toEqual(["implement"]);

    const showOut = await cli(repo, ["workflow", "history", "show", runId]);
    expect(showOut.stdout).toContain("harvest:  applied implement");

    // prune removes the worktree; a later diff reports it is gone
    const pruneOut = await cli(repo, ["workflow", "history", "prune", runId]);
    expect(pruneOut.code).toBe(0);
    expect(pruneOut.stdout).toContain("pruned 1/1");
    const pruned = await store.get(runId);
    expect(pruned?.harvest?.prunedAt).toBeTypeOf("number");
    const goneOut = await cli(repo, ["workflow", "history", "show", runId, "--diff"]);
    expect(goneOut.stderr).toContain("no longer exists");
  });

  it("prunes every loop iteration's worktree, not just the final one", async () => {
    const { repo } = await makeRepoWithRun();
    const wtBase = await mkdtemp(join(tmpdir(), "steamtrain-harvest-loop-wt-"));
    tempRoots.push(wtBase);
    const manager = createGitWorktreeManager({ baseDir: wtBase, runId: "loop-run" });

    // A loop body step allocates a fresh worktree per iteration; the record
    // holds one phase entry per iteration with the same stepId.
    const leases = [];
    for (const iteration of [1, 2]) {
      const lease = await manager.allocate({
        workflowName: "demo",
        stepId: "implement",
        agent: "claude",
        baseCwd: repo,
        stepCwd: repo,
        iteration,
      });
      if (!lease.root || !lease.branch) throw new Error("expected worktree lease");
      await writeFile(join(lease.root, `iter${iteration}.txt`), "x\n");
      leases.push(lease);
    }
    const phases: HistoryPhase[] = leases.map((lease, index) => ({
      phaseId: "impl",
      title: "Implement",
      index,
      stepCount: 1,
      done: true,
      ok: true,
      steps: [
        {
          stepId: "implement",
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
    }));
    const store = createWorkflowHistoryStore(join(repo, WORKFLOW_HISTORY_DIR));
    await store.save(bareRecord("loop-run-id", repo, phases));

    const pruneOut = await cli(repo, ["workflow", "history", "prune", "loop-run-id"]);
    expect(pruneOut.code).toBe(0);
    expect(pruneOut.stdout).toContain("pruned 2/2");
    for (const lease of leases) {
      await expect(stat(lease.root as string)).rejects.toThrow();
    }
  });

  it("applies to a named branch with --mode branch and records the delivery", async () => {
    const { repo, recordRun } = await makeRepoWithRun();
    const runId = await recordRun(async (worktree) => {
      await writeFile(join(worktree, "feature.txt"), "branch delivery\n");
    });

    const out = await cli(repo, [
      "workflow",
      "history",
      "apply",
      runId,
      "--mode",
      "branch",
      "--branch",
      "steamtrain/merged/manual-test",
    ]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("left on branch steamtrain/merged/manual-test");
    // The checkout is untouched (only the history dir is new); the branch holds the merged state.
    expect(await git(repo, "status", "--porcelain")).not.toContain("feature.txt");
    expect(await git(repo, "show", "steamtrain/merged/manual-test:feature.txt")).toBe(
      "branch delivery",
    );

    const store = createWorkflowHistoryStore(join(repo, WORKFLOW_HISTORY_DIR));
    const record = await store.get(runId);
    expect(record?.harvest?.branch).toBe("steamtrain/merged/manual-test");
    const show = await cli(repo, ["workflow", "history", "show", runId]);
    expect(show.stdout).toContain("on branch steamtrain/merged/manual-test");
  });

  it("guides recovery on conflicts and resolves them with --onconflict", async () => {
    const { repo, recordConflictingRun } = await makeRepoWithRun();
    const runId = await recordConflictingRun("first version\n", "second version\n");

    const conflicted = await cli(repo, ["workflow", "history", "apply", runId]);
    expect(conflicted.code).toBe(1);
    expect(conflicted.stderr).toContain("conflicts");
    expect(conflicted.stderr).toContain("--onconflict ours|theirs");
    // A failed harvest leaves the checkout untouched.
    expect(await git(repo, "status", "--porcelain")).not.toContain("clash.txt");

    const resolved = await cli(repo, [
      "workflow",
      "history",
      "apply",
      runId,
      "--onconflict",
      "theirs",
    ]);
    expect(resolved.code).toBe(0);
    expect(await readFile(join(repo, "clash.txt"), "utf8")).toBe("second version\n");
  });

  it("rejects invalid apply flags", async () => {
    const { repo, recordRun } = await makeRepoWithRun();
    const runId = await recordRun(async () => {});
    const badMode = await cli(repo, ["workflow", "history", "apply", runId, "--mode", "zip"]);
    expect(badMode.code).toBe(1);
    expect(badMode.stderr).toContain("--mode must be");
    const badConflict = await cli(repo, [
      "workflow",
      "history",
      "apply",
      runId,
      "--onconflict",
      "agent",
    ]);
    expect(badConflict.code).toBe(1);
    expect(badConflict.stderr).toContain("--onconflict must be");
  });

  it("errors usefully for runs without worktrees", async () => {
    const { repo } = await makeRepoWithRun();
    const store = createWorkflowHistoryStore(join(repo, WORKFLOW_HISTORY_DIR));
    await store.save(bareRecord("bare-run", repo, []));
    const out = await cli(repo, ["workflow", "history", "show", "bare-run", "--diff"]);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("no step worktrees");
  });
});

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

function bareRecord(id: string, cwd: string, phases: HistoryPhase[]): RunRecord {
  return {
    version: 1,
    id,
    workflow: "demo",
    input: "task",
    cwd,
    status: "done",
    ok: true,
    startedAt: Date.now() - 1000,
    endedAt: Date.now(),
    durationMs: 1000,
    phases,
    totals: computeRunTotals(phases),
  };
}

interface Harness {
  repo: string;
  /** Simulate a run: allocate a worktree, let `edit` change it, record history. */
  recordRun: (edit: (worktreeRoot: string) => Promise<void>) => Promise<string>;
  /** Simulate a fan-out run: two steps writing competing content to the same file. */
  recordConflictingRun: (contentA: string, contentB: string) => Promise<string>;
}

async function makeRepoWithRun(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "steamtrain-harvest-cli-test-"));
  tempRoots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "Test User");
  await writeFile(join(repo, "README.md"), "hello\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial");

  let runCounter = 0;
  return {
    repo,
    recordRun: async (edit) => {
      const manager = createGitWorktreeManager({
        baseDir: join(root, "worktrees"),
        runId: `cli-${runCounter++}`,
      });
      const lease = await manager.allocate({
        workflowName: "demo",
        stepId: "implement",
        agent: "claude",
        baseCwd: repo,
        stepCwd: repo,
        iteration: 1,
      });
      if (!lease.root || !lease.branch) throw new Error("expected worktree lease");
      await edit(lease.root);
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
              stepId: "implement",
              blockKind: "worker",
              agent: "claude",
              model: "m",
              status: "done",
              text: "done",
              cached: false,
              worktree: {
                originalCwd: repo,
                cwd: lease.cwd,
                root: lease.root,
                branch: lease.branch,
                baseCommit: lease.baseCommit,
              },
            },
          ],
        },
      ];
      const id = `run-${runCounter}`;
      const store = createWorkflowHistoryStore(join(repo, WORKFLOW_HISTORY_DIR));
      await store.save(bareRecord(id, repo, phases));
      return id;
    },
    recordConflictingRun: async (contentA, contentB) => {
      const manager = createGitWorktreeManager({
        baseDir: join(root, "worktrees"),
        runId: `cli-${runCounter++}`,
      });
      const steps = [];
      for (const [stepId, content] of [
        ["impl-a", contentA],
        ["impl-b", contentB],
      ] as const) {
        const lease = await manager.allocate({
          workflowName: "demo",
          stepId,
          agent: "claude",
          baseCwd: repo,
          stepCwd: repo,
          iteration: 1,
        });
        if (!lease.root || !lease.branch) throw new Error("expected worktree lease");
        await writeFile(join(lease.root, "clash.txt"), content);
        steps.push({
          stepId,
          blockKind: "worker" as const,
          agent: "claude" as const,
          model: "m",
          status: "done" as const,
          text: "done",
          cached: false,
          worktree: {
            originalCwd: repo,
            cwd: lease.cwd,
            root: lease.root,
            branch: lease.branch,
            baseCommit: lease.baseCommit,
          },
        });
      }
      const phases: HistoryPhase[] = [
        {
          phaseId: "impl",
          title: "Implement",
          index: 0,
          stepCount: 2,
          done: true,
          ok: true,
          steps,
        },
      ];
      const id = `run-${runCounter}`;
      const store = createWorkflowHistoryStore(join(repo, WORKFLOW_HISTORY_DIR));
      await store.save(bareRecord(id, repo, phases));
      return id;
    },
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}
