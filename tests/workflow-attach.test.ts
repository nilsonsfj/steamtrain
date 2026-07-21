import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
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

/** Deps whose adapter throws — proves command-only workflows spawn no agent. */
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

function gitDeps(repo: string, root: string, over: Partial<WorkflowDeps> = {}): WorkflowDeps {
  return agentlessDeps(repo, {
    agentWorkspace: createGitWorktreeManager({
      baseDir: join(root, "worktrees"),
      runId: "attach-test",
    }),
    artifactsDir: join(root, "artifacts"),
    ...over,
  });
}

async function runToEvents(spec: WorkflowSpec, deps: WorkflowDeps): Promise<WorkflowEvent[]> {
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

function spec(phases: WorkflowSpec["phases"]): WorkflowSpec {
  return { name: "attach-test", phases };
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "steamtrain-attach-test-"));
  tempRoots.push(dir);
  return dir;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function initRepo(root: string): Promise<string> {
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "Test User");
  await writeFile(join(repo, "README.md"), "hello\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial");
  return repo;
}

describe("workspace attach validation", () => {
  const base = (steps1: object[], steps2: object[] = [], steps3: object[] = []): WorkflowSpec =>
    spec(
      [
        { id: "p1", title: "P1", steps: steps1 },
        steps2.length ? { id: "p2", title: "P2", steps: steps2 } : undefined,
        steps3.length ? { id: "p3", title: "P3", steps: steps3 } : undefined,
      ].filter(Boolean) as WorkflowSpec["phases"],
    );

  it("accepts attach:<stepId> syntax", () => {
    const result = validateWorkflow(
      base(
        [{ id: "a", kind: "command", cmd: "true" }],
        [{ id: "b", kind: "command", cmd: "true", workspace: "attach:a" }],
      ),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects attaching to a forEach fan-out source", () => {
    const result = validateWorkflow(
      spec([
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "split", kind: "distributor", items: ["one", "two"] }],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            {
              id: "work",
              kind: "processor",
              forEach: "steps.split.items",
              agent: "claude",
              model: "m",
              prompt: "{{item}}",
            },
          ],
        },
        {
          id: "p3",
          title: "P3",
          steps: [{ id: "b", kind: "command", cmd: "true", workspace: "attach:work" }],
        },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("fan-out");
  });

  it("rejects a step that attaches AND has its own forEach", () => {
    const result = validateWorkflow(
      spec([
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "a", kind: "command", cmd: "true" }],
        },
        {
          id: "p2",
          title: "P2",
          steps: [{ id: "split", kind: "distributor", items: ["one", "two"] }],
        },
        {
          id: "p3",
          title: "P3",
          steps: [
            {
              id: "b",
              kind: "processor",
              workspace: "attach:a",
              forEach: "steps.split.items",
              agent: "claude",
              model: "m",
              prompt: "{{item}}",
            },
          ],
        },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("cannot combine workspace attach with forEach");
  });

  it("rejects two unordered co-attachers of the same source", () => {
    const result = validateWorkflow(
      base(
        [{ id: "a", kind: "command", cmd: "true" }],
        [
          { id: "b", kind: "command", cmd: "true", workspace: "attach:a" },
          { id: "c", kind: "command", cmd: "true", workspace: "attach:a" },
        ],
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not ordered");
    expect(result.error).toContain("'b'");
    expect(result.error).toContain("'c'");
  });

  it("accepts a strictly-ordered chain of attachers", () => {
    const result = validateWorkflow(
      base(
        [{ id: "a", kind: "command", cmd: "true" }],
        [{ id: "b", kind: "command", cmd: "true", workspace: "attach:a" }],
        [{ id: "c", kind: "command", cmd: "true", workspace: "attach:a", dependsOn: ["b"] }],
      ),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts ordering across an attach chain (attach-from-attach)", () => {
    // c attaches to b, which itself attaches to a — b and c share a's
    // worktree transitively; c depends on b so they're ordered.
    const result = validateWorkflow(
      base(
        [{ id: "a", kind: "command", cmd: "true" }],
        [{ id: "b", kind: "command", cmd: "true", workspace: "attach:a" }],
        [{ id: "c", kind: "command", cmd: "true", workspace: "attach:b", dependsOn: ["b"] }],
      ),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects attaching to an apply/branch/pr merge step", () => {
    const result = validateWorkflow(
      base(
        [{ id: "a", kind: "command", cmd: "true" }],
        [{ id: "land", kind: "merge", from: ["a"], mode: "apply" }],
        [{ id: "b", kind: "command", cmd: "true", workspace: "attach:land" }],
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("merge step");
  });

  it("accepts attaching to a worktree-mode merge step", () => {
    const result = validateWorkflow(
      base(
        [{ id: "a", kind: "command", cmd: "true" }],
        [{ id: "land", kind: "merge", from: ["a"], mode: "worktree" }],
        [{ id: "b", kind: "command", cmd: "true", workspace: "attach:land" }],
      ),
    );
    expect(result.ok).toBe(true);
  });
});

describe("workspace attach engine behavior", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("lets attached command steps see and accumulate each other's edits in ONE worktree", async () => {
    const root = await tempDir();
    const repo = await initRepo(root);
    const events = await runToEvents(
      spec([
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "gen", kind: "command", cmd: "echo alpha > a.txt" }],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            {
              id: "review",
              kind: "command",
              workspace: "attach:gen",
              cmd: "cat a.txt && echo beta > b.txt",
            },
          ],
        },
        {
          id: "p3",
          title: "P3",
          steps: [
            {
              id: "test",
              kind: "command",
              workspace: "attach:gen",
              dependsOn: ["review"],
              cmd: "cat a.txt b.txt",
            },
          ],
        },
      ]),
      gitDeps(repo, root),
    );
    const results = doneResults(events);
    expect(workflowOk(events)).toBe(true);
    expect(results.get("review")?.output).toContain("alpha");
    expect(results.get("test")?.output).toContain("alpha");
    expect(results.get("test")?.output).toContain("beta");
    // All three steps share the SAME worktree root — attach never forks.
    const roots = ["gen", "review", "test"].map((id) => results.get(id)?.worktree?.root);
    expect(new Set(roots).size).toBe(1);
    // Every attacher's recorded worktree carries the SAME branch/baseCommit
    // as the source, so templates/merge treat it identically.
    expect(results.get("review")?.worktree?.branch).toBe(results.get("gen")?.worktree?.branch);
    expect(results.get("test")?.worktree?.baseCommit).toBe(
      results.get("gen")?.worktree?.baseCommit,
    );
    // The user's checkout never saw any of it.
    expect(await git(repo, "status", "--porcelain")).toBe("");
  });

  it("converges a review/fix loop: iteration N+1 sees iteration N's attached edits", async () => {
    const root = await tempDir();
    const repo = await initRepo(root);
    // `gen` owns the worktree once (outside the loop body); `fix` attaches and
    // appends a marker line each iteration; `gate` reads the accumulated file
    // and loops until it has seen 3 markers — proving fix's edits from a
    // PRIOR iteration are visible when `fix` runs again (unlike `inherit`,
    // which would fork a fresh copy each time and never accumulate).
    const events = await runToEvents(
      spec([
        {
          id: "gen",
          title: "Gen",
          steps: [{ id: "owner", kind: "command", cmd: "touch marks.txt" }],
        },
        {
          id: "loop",
          title: "Loop",
          steps: [
            {
              id: "fix",
              kind: "command",
              workspace: "attach:owner",
              cmd: "echo mark >> marks.txt",
            },
          ],
        },
        {
          id: "check",
          title: "Check",
          steps: [
            {
              id: "check",
              kind: "command",
              workspace: "attach:owner",
              dependsOn: ["fix"],
              cmd: "wc -l < marks.txt",
            },
          ],
        },
        {
          id: "decide",
          title: "Decide",
          steps: [
            {
              id: "gate",
              kind: "gate",
              dependsOn: ["check"],
              condition: { step: "check", contains: "3" },
              loopTo: "loop",
              maxIterations: 5,
              onFalse: "fail",
            },
          ],
        },
      ]),
      gitDeps(repo, root),
    );
    const results = doneResults(events);
    expect(workflowOk(events)).toBe(true);
    expect(results.get("gate")?.gate?.passed).toBe(true);
    expect(results.get("check")?.output).toContain("3");
  });

  it("fails to attach when the source worktree no longer exists on disk", async () => {
    const root = await tempDir();
    const repo = await initRepo(root);
    const manager = createGitWorktreeManager({
      baseDir: join(root, "worktrees"),
      runId: "attach-test",
    });
    const events = await runToEvents(
      spec([
        { id: "p1", title: "P1", steps: [{ id: "a", kind: "command", cmd: "echo hi > a.txt" }] },
      ]),
      agentlessDeps(repo, { agentWorkspace: manager }),
    );
    const results = doneResults(events);
    const worktreeRoot = results.get("a")?.worktree?.root;
    expect(worktreeRoot).toBeTruthy();
    await rm(worktreeRoot as string, { recursive: true, force: true });

    await expect(
      manager.allocate({
        workflowName: "w",
        stepId: "b",
        agent: "command",
        baseCwd: repo,
        stepCwd: repo,
        iteration: 1,
        attachTo: {
          stepId: "a",
          root: worktreeRoot as string,
          branch: "steamtrain/attach-test/gone",
        },
      }),
    ).rejects.toThrow(/no longer exists/);
  });

  it("falls back to the shared cwd outside a git repository", async () => {
    const root = await tempDir();
    const cwd = join(root, "plain");
    await mkdir(cwd, { recursive: true });
    const events = await runToEvents(
      spec([
        { id: "p1", title: "P1", steps: [{ id: "a", kind: "command", cmd: "echo alpha > a.txt" }] },
        {
          id: "p2",
          title: "P2",
          steps: [{ id: "b", kind: "command", workspace: "attach:a", cmd: "cat a.txt" }],
        },
      ]),
      agentlessDeps(cwd, {
        agentWorkspace: createGitWorktreeManager({
          baseDir: join(root, "worktrees"),
          runId: "attach-test",
        }),
      }),
    );
    const results = doneResults(events);
    expect(workflowOk(events)).toBe(true);
    expect(results.get("a")?.worktree).toBeUndefined();
    expect(results.get("b")?.output).toContain("alpha");
  });

  it("fails the attacher when its source failed", async () => {
    const root = await tempDir();
    const repo = await initRepo(root);
    const events = await runToEvents(
      spec([
        { id: "p1", title: "P1", steps: [{ id: "a", kind: "command", cmd: "exit 3" }] },
        {
          id: "p2",
          title: "P2",
          steps: [{ id: "b", kind: "command", workspace: "attach:a", cmd: "echo ran" }],
        },
      ]),
      gitDeps(repo, root),
    );
    const results = doneResults(events);
    expect(workflowOk(events)).toBe(false);
    expect(results.get("b")?.ok).toBe(false);
    expect(results.get("b")?.error).toContain("dependency 'a' failed");
  });

  it("merging the tail of an attach group harvests the single shared worktree once", async () => {
    const root = await tempDir();
    const repo = await initRepo(root);
    const events = await runToEvents(
      spec([
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "gen", kind: "command", cmd: "echo alpha > a.txt" }],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            { id: "fix", kind: "command", workspace: "attach:gen", cmd: "echo beta > b.txt" },
          ],
        },
        {
          id: "p3",
          title: "P3",
          steps: [
            // `from` names BOTH gen and fix — same worktree root, deduped.
            { id: "land", kind: "merge", from: ["gen", "fix"], mode: "apply" },
          ],
        },
      ]),
      gitDeps(repo, root),
    );
    expect(workflowOk(events)).toBe(true);
    const land = doneResults(events).get("land");
    const json = land?.json as { merged: string[] };
    expect(json.merged).toEqual(["gen"]);
    expect(land?.output).toContain("deduped");
  });
});
