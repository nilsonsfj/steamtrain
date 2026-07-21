import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  runWorkflow,
  validateWorkflow,
} from "../src/workflow";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

/** A fake agent that writes `WRITE <path>\n<content>` from the prompt into its cwd. */
function fileWritingAdapter(): (id: AgentId) => AgentAdapter {
  return (id: AgentId): AgentAdapter => ({
    id,
    binary: "fake",
    defaultModel: "test",
    run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
      return (async function* () {
        const match = /WRITE (\S+)\n([\s\S]*)/.exec(opts.prompt);
        if (match) {
          await writeFile(join(opts.cwd ?? ".", match[1] as string), match[2] as string);
        }
        yield {
          kind: "result",
          agent: "claude",
          ts: 0,
          isError: false,
          text: "done",
          costUsd: 0.01,
        } as AgentEvent;
      })();
    },
  });
}

function agentlessDeps(cwd: string, over: Partial<WorkflowDeps> = {}): WorkflowDeps {
  return {
    createAdapter: () => {
      throw new Error("this workflow must not create agent adapters");
    },
    maxConcurrency: 4,
    cwd,
    ...over,
  };
}

async function runToEvents(
  spec: WorkflowSpec,
  repo: string,
  worktreeBase: string,
  overAdapter?: Partial<WorkflowDeps>,
): Promise<WorkflowEvent[]> {
  const deps: WorkflowDeps = {
    createAdapter: fileWritingAdapter(),
    maxConcurrency: 4,
    cwd: repo,
    agentWorkspace: createGitWorktreeManager({ baseDir: worktreeBase, runId: "merge-wt-test" }),
    ...overAdapter,
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

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "steamtrain-merge-wt-test-"));
  tempRoots.push(dir);
  return dir;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
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

describe("merge mode worktree validation", () => {
  it("rejects perSource combined with mode worktree", () => {
    const bad: WorkflowSpec = {
      name: "w",
      phases: [
        { id: "p1", title: "P1", steps: [{ id: "a", agent: "claude", model: "m", prompt: "x" }] },
        {
          id: "p2",
          title: "P2",
          steps: [
            { id: "land", kind: "merge", dependsOn: ["a"], mode: "worktree", perSource: true },
          ],
        },
      ],
    };
    const result = validateWorkflow(bad);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("worktree");
  });
});

describe("merge mode worktree engine behavior", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("merges two source worktrees into a KEPT staging worktree with both changes", async () => {
    const { repo, worktrees } = await makeRepo();
    const spec: WorkflowSpec = {
      name: "merge-worktree",
      phases: [
        {
          id: "impl",
          title: "Implement",
          steps: [
            { id: "a", agent: "claude", model: "m", prompt: "WRITE a.txt\nfrom a\n" },
            { id: "b", agent: "claude", model: "m", prompt: "WRITE b.txt\nfrom b\n" },
          ],
        },
        {
          id: "integrate",
          title: "Integrate",
          steps: [{ id: "integrate", kind: "merge", dependsOn: ["a", "b"], mode: "worktree" }],
        },
      ],
    };
    const events = await runToEvents(spec, repo, worktrees);
    expect(workflowOk(events)).toBe(true);
    const results = doneResults(events);
    const integrate = results.get("integrate");
    expect(integrate?.ok).toBe(true);
    expect(integrate?.worktree).toBeTruthy();
    expect(integrate?.worktree?.root).toBeTruthy();
    expect(integrate?.worktree?.branch).toBeTruthy();
    expect(integrate?.worktree?.baseCommit).toBeTruthy();
    // Nothing landed in the user's checkout.
    expect(await git(repo, "status", "--porcelain")).toBe("");
    // The kept worktree carries both sources' changes.
    const wtRoot = integrate?.worktree?.root as string;
    expect((await readFile(join(wtRoot, "a.txt"), "utf8")).trim()).toBe("from a");
    expect((await readFile(join(wtRoot, "b.txt"), "utf8")).trim()).toBe("from b");
    // The branch actually exists and is checked out there.
    expect(await git(wtRoot, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      integrate?.worktree?.branch,
    );
    // The kept worktree/branch survive after the run (not cleaned up).
    expect((await stat(wtRoot)).isDirectory()).toBe(true);
  });

  it("a later command step attaching to the merge step sees the merged files", async () => {
    const { repo, worktrees } = await makeRepo();
    const spec: WorkflowSpec = {
      name: "merge-worktree-attach",
      phases: [
        {
          id: "impl",
          title: "Implement",
          steps: [
            { id: "a", agent: "claude", model: "m", prompt: "WRITE a.txt\nfrom a\n" },
            { id: "b", agent: "claude", model: "m", prompt: "WRITE b.txt\nfrom b\n" },
          ],
        },
        {
          id: "integrate",
          title: "Integrate",
          steps: [{ id: "integrate", kind: "merge", dependsOn: ["a", "b"], mode: "worktree" }],
        },
        {
          id: "review",
          title: "Review",
          steps: [
            {
              id: "review",
              kind: "command",
              workspace: "attach:integrate",
              cmd: "cat a.txt b.txt && echo reviewed >> notes.txt",
            },
          ],
        },
      ],
    };
    const events = await runToEvents(spec, repo, worktrees);
    expect(workflowOk(events)).toBe(true);
    const results = doneResults(events);
    expect(results.get("review")?.output).toContain("from a");
    expect(results.get("review")?.output).toContain("from b");
    // Same worktree root as the merge step — attach shares it, no copy.
    expect(results.get("review")?.worktree?.root).toBe(results.get("integrate")?.worktree?.root);
  });

  it("a second merge step (mode apply) lands the full merged+edited diff in the checkout", async () => {
    const { repo, worktrees } = await makeRepo();
    const spec: WorkflowSpec = {
      name: "merge-worktree-then-apply",
      phases: [
        {
          id: "impl",
          title: "Implement",
          steps: [
            { id: "a", agent: "claude", model: "m", prompt: "WRITE a.txt\nfrom a\n" },
            { id: "b", agent: "claude", model: "m", prompt: "WRITE b.txt\nfrom b\n" },
          ],
        },
        {
          id: "integrate",
          title: "Integrate",
          steps: [{ id: "integrate", kind: "merge", dependsOn: ["a", "b"], mode: "worktree" }],
        },
        {
          id: "fix",
          title: "Fix",
          steps: [
            {
              id: "fix",
              kind: "command",
              workspace: "attach:integrate",
              cmd: "echo fixed >> a.txt",
            },
          ],
        },
        {
          id: "deliver",
          title: "Deliver",
          steps: [{ id: "deliver", kind: "merge", from: ["fix"], mode: "apply" }],
        },
      ],
    };
    const events = await runToEvents(spec, repo, worktrees);
    expect(workflowOk(events)).toBe(true);
    const results = doneResults(events);
    expect(results.get("deliver")?.ok).toBe(true);
    // The final checkout has both original files AND fix's edit.
    const aContent = await readFile(join(repo, "a.txt"), "utf8");
    expect(aContent).toContain("from a");
    expect(aContent).toContain("fixed");
    expect((await readFile(join(repo, "b.txt"), "utf8")).trim()).toBe("from b");
  });

  it("dedupes a merge worktree and a step attached to it before harvesting", async () => {
    const { repo, worktrees } = await makeRepo();
    const spec: WorkflowSpec = {
      name: "merge-worktree-dedupe",
      phases: [
        {
          id: "impl",
          title: "Implement",
          steps: [{ id: "a", agent: "claude", model: "m", prompt: "WRITE a.txt\nfrom a\n" }],
        },
        {
          id: "integrate",
          title: "Integrate",
          steps: [{ id: "integrate", kind: "merge", dependsOn: ["a"], mode: "worktree" }],
        },
        {
          id: "fix",
          title: "Fix",
          steps: [
            {
              id: "fix",
              kind: "command",
              workspace: "attach:integrate",
              cmd: "echo more >> a.txt",
            },
          ],
        },
        {
          id: "reland",
          title: "Reland",
          steps: [
            // Names both the merge step AND a step attached to its worktree —
            // same root, deduped down to one source before harvesting.
            { id: "reland", kind: "merge", from: ["integrate", "fix"], mode: "apply" },
          ],
        },
      ],
    };
    const events = await runToEvents(spec, repo, worktrees);
    expect(workflowOk(events)).toBe(true);
    const reland = doneResults(events).get("reland");
    const json = reland?.json as { merged: string[] };
    expect(json.merged).toEqual(["integrate"]);
    expect(reland?.output).toContain("deduped");
    const content = await readFile(join(repo, "a.txt"), "utf8");
    expect(content).toContain("from a");
    expect(content).toContain("more");
  });
});
