import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunOptions } from "../src/agents";
import type { AgentEvent, AgentId } from "../src/types/events";
import {
  type StepResult,
  type WorkflowDeps,
  type WorkflowEvent,
  type WorkflowSpec,
  createGitWorktreeManager,
  renderPrompt,
  runWorkflow,
  validateWorkflow,
} from "../src/workflow";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

/**
 * A fake adapter whose "agent" actually edits files: it writes the content
 * after `WRITE <path>\n` in the prompt into the step's cwd (the isolated
 * worktree), which is exactly what a real implement-style agent does. Prompts
 * from the conflict resolver (recognizable by the built-in scaffold) resolve
 * every listed file to `resolved by agent`.
 */
function fileWritingAdapter(): (id: AgentId) => AgentAdapter {
  return (id: AgentId): AgentAdapter => ({
    id,
    binary: "fake",
    run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
      return (async function* () {
        if (opts.prompt.includes("resolving git merge conflicts")) {
          for (const line of opts.prompt.split("\n")) {
            const file = /^- (.+)$/.exec(line)?.[1];
            if (file) await writeFile(join(opts.cwd ?? ".", file), "resolved by agent\n");
          }
        } else {
          const match = /WRITE (\S+)\n([\s\S]*)/.exec(opts.prompt);
          if (match) {
            await writeFile(join(opts.cwd ?? ".", match[1] as string), match[2] as string);
          }
        }
        const result: AgentEvent = {
          kind: "result",
          agent: "claude",
          ts: 0,
          isError: false,
          text: "done",
          costUsd: 0.01,
        };
        yield result;
      })();
    },
  });
}

async function runToEvents(
  spec: WorkflowSpec,
  repo: string,
  worktreeBase: string,
): Promise<WorkflowEvent[]> {
  const deps: WorkflowDeps = {
    createAdapter: fileWritingAdapter(),
    maxConcurrency: 4,
    cwd: repo,
    agentWorkspace: createGitWorktreeManager({ baseDir: worktreeBase, runId: "merge-step-test" }),
  };
  const events: WorkflowEvent[] = [];
  for await (const ev of runWorkflow(spec, { input: "task" }, deps)) events.push(ev);
  return events;
}

function doneResults(events: WorkflowEvent[]): Map<string, StepResult> {
  const map = new Map<string, StepResult>();
  for (const ev of events) {
    if (ev.kind === "step_done") map.set(ev.stepId, ev.result);
  }
  return map;
}

function workflowOk(events: WorkflowEvent[]): boolean {
  const done = events.find((ev) => ev.kind === "workflow_done");
  return done?.kind === "workflow_done" ? done.ok : false;
}

describe("merge workflow step", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("applies an implement step's worktree changes to the workspace", async () => {
    const { repo, worktrees } = await makeRepo();
    const spec: WorkflowSpec = {
      name: "implement-and-land",
      phases: [
        {
          id: "impl",
          title: "Implement",
          steps: [
            {
              id: "implement",
              agent: "claude",
              model: "m",
              prompt: "WRITE feature.txt\nthe feature\n",
            },
          ],
        },
        {
          id: "land",
          title: "Land",
          steps: [{ id: "land", kind: "merge", dependsOn: ["implement"] }],
        },
      ],
    };

    const events = await runToEvents(spec, repo, worktrees);
    expect(workflowOk(events)).toBe(true);
    const land = doneResults(events).get("land");
    expect(land?.ok).toBe(true);
    expect(land?.output).toContain("merged 1 worktree(s)");
    const json = land?.json as { mode: string; merged: string[]; additions: number };
    expect(json.mode).toBe("apply");
    expect(json.merged).toEqual(["implement"]);
    expect(await readFile(join(repo, "feature.txt"), "utf8")).toBe("the feature\n");
    // Landed as uncommitted changes — the user's history is untouched.
    expect(await git(repo, "status", "--porcelain")).toContain("feature.txt");
  });

  it("merges every fan-out child worktree onto a named branch", async () => {
    const { repo, worktrees } = await makeRepo();
    const spec: WorkflowSpec = {
      name: "fanout-branch",
      phases: [
        {
          id: "split",
          title: "Split",
          steps: [{ id: "targets", kind: "distributor", items: ["one", "two"] }],
        },
        {
          id: "work",
          title: "Work",
          steps: [
            {
              id: "impl",
              forEach: "steps.targets.items",
              agent: "claude",
              model: "m",
              prompt: "WRITE {{item}}.txt\ncontent of {{item}}\n",
            },
          ],
        },
        {
          id: "land",
          title: "Land",
          steps: [
            {
              id: "land",
              kind: "merge",
              dependsOn: ["impl"],
              mode: "branch",
              branch: "steamtrain/merged/fanout-test",
            },
          ],
        },
      ],
    };

    const events = await runToEvents(spec, repo, worktrees);
    expect(workflowOk(events)).toBe(true);
    const land = doneResults(events).get("land");
    expect(land?.ok).toBe(true);
    const json = land?.json as { merged: string[]; branches: string[] };
    expect(json.merged).toEqual(["impl[0]", "impl[1]"]);
    expect(json.branches).toEqual(["steamtrain/merged/fanout-test"]);
    // Workspace untouched; both files live on the branch.
    expect(await git(repo, "status", "--porcelain")).toBe("");
    expect(await git(repo, "show", "steamtrain/merged/fanout-test:one.txt")).toBe("content of one");
    expect(await git(repo, "show", "steamtrain/merged/fanout-test:two.txt")).toBe("content of two");
  });

  it("resolves competing edits through the conflict agent and accounts its cost", async () => {
    const { repo, worktrees } = await makeRepo();
    const spec: WorkflowSpec = {
      name: "competing",
      phases: [
        {
          id: "impl",
          title: "Two implementations",
          steps: [
            { id: "a", agent: "claude", model: "m", prompt: "WRITE shared.txt\nversion A\n" },
            { id: "b", agent: "claude", model: "m", prompt: "WRITE shared.txt\nversion B\n" },
          ],
        },
        {
          id: "land",
          title: "Land",
          steps: [
            {
              id: "land",
              kind: "merge",
              dependsOn: ["a", "b"],
              onConflict: "agent",
              agent: "claude",
              model: "m",
            },
          ],
        },
      ],
    };

    const events = await runToEvents(spec, repo, worktrees);
    expect(workflowOk(events)).toBe(true);
    const land = doneResults(events).get("land");
    expect(land?.ok).toBe(true);
    const json = land?.json as { conflicts: { files: string[]; resolvedBy: string }[] };
    expect(json.conflicts).toEqual([{ stepId: "b", files: ["shared.txt"], resolvedBy: "agent" }]);
    // The conflict-resolution agent turn is billed to the merge step.
    expect(land?.costUsd).toBe(0.01);
    expect(await readFile(join(repo, "shared.txt"), "utf8")).toBe("resolved by agent\n");
  });

  it("fails the merge step (and run) on conflicts when onConflict is fail", async () => {
    const { repo, worktrees } = await makeRepo();
    const spec: WorkflowSpec = {
      name: "competing-fail",
      phases: [
        {
          id: "impl",
          title: "Two implementations",
          steps: [
            { id: "a", agent: "claude", model: "m", prompt: "WRITE shared.txt\nversion A\n" },
            { id: "b", agent: "claude", model: "m", prompt: "WRITE shared.txt\nversion B\n" },
          ],
        },
        {
          id: "land",
          title: "Land",
          steps: [{ id: "land", kind: "merge", dependsOn: ["a", "b"] }],
        },
      ],
    };

    const events = await runToEvents(spec, repo, worktrees);
    expect(workflowOk(events)).toBe(false);
    const land = doneResults(events).get("land");
    expect(land?.ok).toBe(false);
    expect(land?.error).toContain("conflicts");
    // The workspace stays pristine on failure.
    expect(await git(repo, "status", "--porcelain")).toBe("");
  });

  it("succeeds with a no-changes result when sources did not edit anything", async () => {
    const { repo, worktrees } = await makeRepo();
    const spec: WorkflowSpec = {
      name: "review-only",
      phases: [
        {
          id: "review",
          title: "Review",
          steps: [{ id: "review", agent: "claude", model: "m", prompt: "just look around" }],
        },
        {
          id: "land",
          title: "Land",
          steps: [{ id: "land", kind: "merge", dependsOn: ["review"] }],
        },
      ],
    };

    const events = await runToEvents(spec, repo, worktrees);
    expect(workflowOk(events)).toBe(true);
    const land = doneResults(events).get("land");
    expect(land?.ok).toBe(true);
    expect((land?.json as { noChanges: boolean }).noChanges).toBe(true);
    expect(land?.output).toContain("no changes to merge");
  });

  it("fails gracefully when steps ran without worktrees (not a git repo)", async () => {
    const root = await tempDir();
    const plainDir = join(root, "plain");
    await mkdir(plainDir, { recursive: true });
    const spec: WorkflowSpec = {
      name: "no-git",
      phases: [
        {
          id: "impl",
          title: "Implement",
          steps: [{ id: "implement", agent: "claude", model: "m", prompt: "WRITE f.txt\nx\n" }],
        },
        {
          id: "land",
          title: "Land",
          steps: [{ id: "land", kind: "merge", dependsOn: ["implement"] }],
        },
      ],
    };

    const events = await runToEvents(spec, plainDir, join(root, "worktrees"));
    const land = doneResults(events).get("land");
    expect(land?.ok).toBe(false);
    expect(land?.error).toMatch(/git repository/);
  });
});

describe("merge step validation", () => {
  it("requires from or dependsOn", () => {
    const result = validateWorkflow(spec1([{ id: "land", kind: "merge" } as never]));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("merge step requires from or dependsOn");
  });

  it("rejects from references to unknown or same-phase steps", () => {
    const bad: WorkflowSpec = {
      name: "w",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "land", kind: "merge", from: ["ghost"] }],
        },
      ],
    };
    const result = validateWorkflow(bad);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown step 'ghost'");
  });

  it("requires agent and model for onConflict agent", () => {
    const bad: WorkflowSpec = {
      name: "w",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "a", agent: "claude", model: "m", prompt: "x" }],
        },
        {
          id: "p2",
          title: "P2",
          steps: [{ id: "land", kind: "merge", dependsOn: ["a"], onConflict: "agent" }],
        },
      ],
    };
    const result = validateWorkflow(bad);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('onConflict "agent" requires agent and model');
  });
});

describe("worktree template fields", () => {
  it("renders steps.<id>.worktree.root/branch/cwd (empty when absent)", () => {
    const results = new Map([
      [
        "impl",
        {
          ok: true,
          worktree: { root: "/tmp/wt", branch: "steamtrain/x/impl", cwd: "/tmp/wt/src" },
        },
      ],
      ["plain", { ok: true }],
    ]);
    const ctx = { input: "", outputs: new Map<string, string>(), results };
    expect(renderPrompt("{{steps.impl.worktree.root}}", ctx)).toBe("/tmp/wt");
    expect(renderPrompt("{{steps.impl.worktree.branch}}", ctx)).toBe("steamtrain/x/impl");
    expect(renderPrompt("{{steps.impl.worktree.cwd}}", ctx)).toBe("/tmp/wt/src");
    expect(renderPrompt("{{steps.plain.worktree.root}}", ctx)).toBe("");
  });
});

function spec1(steps: WorkflowSpec["phases"][number]["steps"]): WorkflowSpec {
  return { name: "w", phases: [{ id: "p1", title: "P1", steps }] };
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "steamtrain-merge-step-test-"));
  tempRoots.push(dir);
  return dir;
}

async function makeRepo(): Promise<{ repo: string; worktrees: string }> {
  const root = await tempDir();
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "Test User");
  await writeFile(join(repo, "README.md"), "hello\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial");
  return { repo, worktrees: join(root, "worktrees") };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}
