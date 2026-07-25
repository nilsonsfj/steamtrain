import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { loadRunDiff } from "../src/tui/history-diff";
import {
  type HistoryPhase,
  type RunRecord,
  computeRunTotals,
  createGitWorktreeManager,
} from "../src/workflow";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

describe("loadRunDiff", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("renders an existing worktree's diff as styled lines", async () => {
    const { repo, root } = await makeRepo();
    const manager = createGitWorktreeManager({ baseDir: join(root, "worktrees"), runId: "r1" });
    const lease = await manager.allocate({
      workflowName: "demo",
      stepId: "implement",
      agent: "claude",
      baseCwd: repo,
      stepCwd: repo,
      iteration: 1,
    });
    if (!lease.root || !lease.branch) throw new Error("expected worktree lease");
    await writeFile(join(lease.root, "feature.txt"), "agent made this\n");

    const steps = await loadRunDiff(recordFor(repo, lease));
    expect(steps).toHaveLength(1);
    const step = steps[0]!;
    expect(step.stepId).toBe("implement");
    expect(step.branch).toBe(lease.branch);
    expect(step.exists).toBe(true);
    expect(step.error).toBeUndefined();
    expect(step.files).toBe(1);
    expect(step.additions).toBe(1);
    expect(step.deletions).toBe(0);

    const header = step.lines.find((line) => line.text.startsWith("A feature.txt"));
    expect(header?.color).toBe("green");
    expect(header?.bold).toBe(true);
    const added = step.lines.find((line) => line.text.includes("agent made this"));
    expect(added?.text).toContain("+agent made this");
    expect(added?.color).toBe("green");
  });

  it("reports a pruned worktree as an error step instead of throwing", async () => {
    const { repo, root } = await makeRepo();
    const manager = createGitWorktreeManager({ baseDir: join(root, "worktrees"), runId: "r2" });
    const lease = await manager.allocate({
      workflowName: "demo",
      stepId: "implement",
      agent: "claude",
      baseCwd: repo,
      stepCwd: repo,
      iteration: 1,
    });
    if (!lease.root || !lease.branch) throw new Error("expected worktree lease");
    await writeFile(join(lease.root, "feature.txt"), "gone soon\n");
    const record = recordFor(repo, lease);
    await rm(lease.root, { recursive: true, force: true });

    const steps = await loadRunDiff(record);
    expect(steps).toHaveLength(1);
    const step = steps[0]!;
    expect(step.exists).toBe(false);
    expect(step.error).toContain("no longer exists");
    expect(step.lines).toEqual([]);
  });

  it("returns an empty list for a run without worktrees", async () => {
    const { repo } = await makeRepo();
    const record: RunRecord = {
      version: 1,
      id: "bare-run",
      workflow: "demo",
      input: "task",
      cwd: repo,
      status: "done",
      ok: true,
      startedAt: Date.now() - 1000,
      endedAt: Date.now(),
      durationMs: 1000,
      phases: [],
      totals: computeRunTotals([]),
    };
    expect(await loadRunDiff(record)).toEqual([]);
  });
});

interface Lease {
  cwd: string;
  root?: string;
  branch?: string;
  baseCommit?: string;
}

function recordFor(repo: string, lease: Lease): RunRecord {
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
    id: "run-1",
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
  };
}

async function makeRepo(): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(join(tmpdir(), "steamtrain-history-diff-test-"));
  tempRoots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "Test User");
  await writeFile(join(repo, "README.md"), "hello\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial");
  return { root, repo };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}
