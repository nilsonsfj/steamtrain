import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunOptions } from "../src/agents";
import type { AgentEvent } from "../src/types/events";
import {
  type StepResult,
  type WorkflowDeps,
  type WorkflowEvent,
  type WorkflowSpec,
  artifactName,
  collectArtifacts,
  createGitWorktreeManager,
  renderPrompt,
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

/** Deps whose fake agent writes `fileName` into its cwd, then reports success. */
function fileWritingAgentDeps(
  cwd: string,
  fileName: string,
  over: Partial<WorkflowDeps> = {},
): WorkflowDeps {
  const adapter: AgentAdapter = {
    id: "claude",
    binary: "fake",
    run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
      return (async function* () {
        await writeFile(join(opts.cwd ?? cwd, fileName), "written by agent\n");
        yield {
          kind: "result",
          agent: "claude",
          ts: 0,
          isError: false,
          text: "done",
        } as AgentEvent;
      })();
    },
  };
  return { createAdapter: () => adapter, maxConcurrency: 4, cwd, ...over };
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
  return { name: "handoff-test", phases };
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "steamtrain-handoff-test-"));
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

function gitDeps(repo: string, root: string, over: Partial<WorkflowDeps> = {}): WorkflowDeps {
  return agentlessDeps(repo, {
    agentWorkspace: createGitWorktreeManager({
      baseDir: join(root, "worktrees"),
      runId: "handoff-test",
    }),
    artifactsDir: join(root, "artifacts"),
    ...over,
  });
}

describe("workspace inheritance validation", () => {
  const base = (steps1: object[], steps2: object[] = []): WorkflowSpec =>
    spec(
      [
        { id: "p1", title: "P1", steps: steps1 },
        steps2.length ? { id: "p2", title: "P2", steps: steps2 } : undefined,
      ].filter(Boolean) as WorkflowSpec["phases"],
    );

  it("rejects a workspace value that is not inherit:<stepId>", () => {
    const result = validateWorkflow(
      base(
        [{ id: "a", kind: "command", cmd: "true" }],
        [{ id: "b", kind: "command", cmd: "true", workspace: "fresh" }],
      ),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects inheriting an unknown step", () => {
    const result = validateWorkflow(
      base([{ id: "a", kind: "command", cmd: "true", workspace: "inherit:ghost" }]),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown step 'ghost'");
  });

  it("rejects inheriting a step in the same phase", () => {
    const result = validateWorkflow(
      base([
        { id: "a", kind: "command", cmd: "true" },
        { id: "b", kind: "command", cmd: "true", workspace: "inherit:a" },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not in an earlier phase");
  });

  it("rejects inheriting a step kind that has no worktree", () => {
    const result = validateWorkflow(
      base(
        [
          {
            id: "check",
            kind: "gate",
            condition: { contains: "x" },
          },
        ],
        [{ id: "b", kind: "command", cmd: "true", workspace: "inherit:check" }],
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("gate step");
  });

  it("rejects inheriting a forEach fan-out step", () => {
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
          steps: [{ id: "b", kind: "command", cmd: "true", workspace: "inherit:work" }],
        },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("fan-out");
  });

  it("rejects duplicate artifact template names", () => {
    const result = validateWorkflow(
      base([
        { id: "a", kind: "command", cmd: "true", artifacts: ["report.md", "docs/report.txt"] },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("share the template name 'report'");
  });

  it("rejects absolute and escaping artifact paths", () => {
    // Trailing `..` segments are rejected even when depth-balanced: the last
    // segment becomes the snapshot directory entry, so `src/..` would target
    // the shared run artifacts directory itself.
    for (const bad of [
      "/etc/passwd",
      "../outside.txt",
      "a/../../outside.txt",
      ".",
      "src/..",
      "a/b/..",
    ]) {
      const result = validateWorkflow(
        base([{ id: "a", kind: "command", cmd: "true", artifacts: [bad] }]),
      );
      expect(result.ok, `expected '${bad}' to be rejected`).toBe(false);
    }
  });

  it("accepts a valid inherit + artifacts combination", () => {
    const result = validateWorkflow(
      base(
        [{ id: "a", kind: "command", cmd: "true", artifacts: ["report.md", "coverage/"] }],
        [{ id: "b", kind: "command", cmd: "true", workspace: "inherit:a" }],
      ),
    );
    expect(result.ok).toBe(true);
  });
});

describe("artifact names", () => {
  it("derives template names from the last path segment", () => {
    expect(artifactName("report.md")).toBe("report");
    expect(artifactName("coverage/")).toBe("coverage");
    expect(artifactName("dist/app.tar.gz")).toBe("app.tar");
    expect(artifactName(".env")).toBe(".env");
  });
});

describe("workspace inheritance", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("lets a chain of command steps see each other's files, keeping the checkout clean", async () => {
    const root = await tempDir();
    const repo = await initRepo(root);
    const events = await runToEvents(
      spec([
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "a", kind: "command", cmd: "echo alpha > a.txt" }],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            {
              id: "b",
              kind: "command",
              workspace: "inherit:a",
              cmd: "cat a.txt && echo beta > b.txt",
            },
          ],
        },
        {
          id: "p3",
          title: "P3",
          steps: [{ id: "c", kind: "command", workspace: "inherit:b", cmd: "cat a.txt b.txt" }],
        },
      ]),
      gitDeps(repo, root),
    );
    const results = doneResults(events);
    expect(workflowOk(events)).toBe(true);
    expect(results.get("b")?.output).toContain("alpha");
    expect(results.get("c")?.output).toContain("alpha");
    expect(results.get("c")?.output).toContain("beta");
    // Each step still got its own isolated worktree.
    const roots = ["a", "b", "c"].map((id) => results.get(id)?.worktree?.root);
    expect(new Set(roots).size).toBe(3);
    // The chain's diff base is inherited so a merge of the tail lands everything.
    expect(results.get("c")?.worktree?.baseCommit).toBe(results.get("a")?.worktree?.baseCommit);
    // The user's checkout never saw any of it.
    expect(await git(repo, "status", "--porcelain")).toBe("");
  });

  it("lets a command step verify a fake agent step's edits", async () => {
    const root = await tempDir();
    const repo = await initRepo(root);
    const events = await runToEvents(
      spec([
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "implement", kind: "worker", agent: "claude", model: "m", prompt: "edit" }],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            { id: "verify", kind: "command", workspace: "inherit:implement", cmd: "cat impl.txt" },
          ],
        },
      ]),
      fileWritingAgentDeps(repo, "impl.txt", {
        agentWorkspace: createGitWorktreeManager({
          baseDir: join(root, "worktrees"),
          runId: "handoff-test",
        }),
      }),
    );
    const results = doneResults(events);
    expect(workflowOk(events)).toBe(true);
    expect(results.get("verify")?.output).toContain("written by agent");
    expect(await git(repo, "status", "--porcelain")).toBe("");
  });

  it("merging the tail of an inherited chain lands the whole chain's changes", async () => {
    const root = await tempDir();
    const repo = await initRepo(root);
    const events = await runToEvents(
      spec([
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "a", kind: "command", cmd: "echo alpha > a.txt" }],
        },
        {
          id: "p2",
          title: "P2",
          steps: [{ id: "b", kind: "command", workspace: "inherit:a", cmd: "echo beta > b.txt" }],
        },
        {
          id: "p3",
          title: "P3",
          steps: [{ id: "land", kind: "merge", from: ["b"], mode: "apply" }],
        },
      ]),
      gitDeps(repo, root),
    );
    expect(workflowOk(events)).toBe(true);
    expect((await readFile(join(repo, "a.txt"), "utf8")).trim()).toBe("alpha");
    expect((await readFile(join(repo, "b.txt"), "utf8")).trim()).toBe("beta");
  });

  it("fails the inheriting step when its source failed", async () => {
    const root = await tempDir();
    const repo = await initRepo(root);
    const events = await runToEvents(
      spec([
        { id: "p1", title: "P1", steps: [{ id: "a", kind: "command", cmd: "exit 3" }] },
        {
          id: "p2",
          title: "P2",
          steps: [{ id: "b", kind: "command", workspace: "inherit:a", cmd: "echo ran" }],
        },
      ]),
      gitDeps(repo, root),
    );
    const results = doneResults(events);
    expect(workflowOk(events)).toBe(false);
    expect(results.get("b")?.ok).toBe(false);
    expect(results.get("b")?.error).toContain("dependency 'a' failed");
  });

  it("skips the inheriting step when its source was skipped", async () => {
    const root = await tempDir();
    const repo = await initRepo(root);
    const events = await runToEvents(
      spec([
        { id: "p0", title: "P0", steps: [{ id: "probe", kind: "command", cmd: "echo backend" }] },
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "a",
              kind: "command",
              cmd: "echo alpha > a.txt",
              when: { step: "probe", contains: "frontend" },
            },
          ],
        },
        {
          id: "p2",
          title: "P2",
          steps: [{ id: "b", kind: "command", workspace: "inherit:a", cmd: "cat a.txt" }],
        },
      ]),
      gitDeps(repo, root),
    );
    const results = doneResults(events);
    expect(workflowOk(events)).toBe(true);
    expect(results.get("a")?.skipped).toBe(true);
    expect(results.get("b")?.skipped).toBe(true);
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
          steps: [{ id: "b", kind: "command", workspace: "inherit:a", cmd: "cat a.txt" }],
        },
      ]),
      agentlessDeps(cwd, {
        agentWorkspace: createGitWorktreeManager({
          baseDir: join(root, "worktrees"),
          runId: "handoff-test",
        }),
      }),
    );
    const results = doneResults(events);
    expect(workflowOk(events)).toBe(true);
    expect(results.get("a")?.worktree).toBeUndefined();
    expect(results.get("b")?.output).toContain("alpha");
  });

  it("inherits the latest source worktree on each loop iteration", async () => {
    const root = await tempDir();
    const repo = await initRepo(root);
    const events = await runToEvents(
      spec([
        {
          id: "gen",
          title: "Gen",
          steps: [{ id: "fix", kind: "command", cmd: "echo iter {{iteration}} > marker.txt" }],
        },
        {
          id: "check",
          title: "Check",
          steps: [{ id: "test", kind: "command", workspace: "inherit:fix", cmd: "cat marker.txt" }],
        },
        {
          id: "decide",
          title: "Decide",
          steps: [
            {
              id: "converged",
              kind: "gate",
              dependsOn: ["test"],
              condition: { step: "test", contains: "iter 2" },
              loopTo: "gen",
              maxIterations: 3,
              onFalse: "fail",
            },
          ],
        },
      ]),
      gitDeps(repo, root),
    );
    const results = doneResults(events);
    expect(workflowOk(events)).toBe(true);
    expect(results.get("test")?.output).toContain("iter 2");
    expect(results.get("converged")?.gate?.passed).toBe(true);
  });
});

describe("declared artifacts", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("snapshots declared files and directories out of the worktree", async () => {
    const root = await tempDir();
    const repo = await initRepo(root);
    const events = await runToEvents(
      spec([
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "build",
              kind: "command",
              cmd: "echo findings > report.md && mkdir -p coverage/sub && echo 1 > coverage/lcov.info && echo 2 > coverage/sub/deep.txt",
              artifacts: ["report.md", "coverage/"],
            },
          ],
        },
        {
          id: "p2",
          title: "P2",
          steps: [{ id: "read", kind: "command", cmd: "cat {{steps.build.artifacts.report}}" }],
        },
      ]),
      gitDeps(repo, root),
    );
    const results = doneResults(events);
    expect(workflowOk(events)).toBe(true);

    const artifacts = results.get("build")?.artifacts ?? [];
    expect(artifacts.map((a) => a.name).sort()).toEqual(["coverage", "report"]);
    const report = artifacts.find((a) => a.name === "report");
    const coverage = artifacts.find((a) => a.name === "coverage");
    expect(report?.files).toBe(1);
    expect(report?.bytes).toBeGreaterThan(0);
    expect(coverage?.files).toBe(2);
    // Snapshots live under the run's artifact dir, not inside the worktree.
    expect(report?.path.startsWith(join(root, "artifacts"))).toBe(true);
    expect((await readFile(report?.path as string, "utf8")).trim()).toBe("findings");
    expect((await readFile(join(coverage?.path as string, "sub", "deep.txt"), "utf8")).trim()).toBe(
      "2",
    );
    // A later step consumed the snapshot path through the template.
    expect(results.get("read")?.output).toContain("findings");
  });

  it("snapshots a fake agent step's declared artifact", async () => {
    const root = await tempDir();
    const repo = await initRepo(root);
    const events = await runToEvents(
      spec([
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "author",
              kind: "worker",
              agent: "claude",
              model: "m",
              prompt: "write",
              artifacts: ["notes.md"],
            },
          ],
        },
      ]),
      fileWritingAgentDeps(repo, "notes.md", {
        agentWorkspace: createGitWorktreeManager({
          baseDir: join(root, "worktrees"),
          runId: "handoff-test",
        }),
        artifactsDir: join(root, "artifacts"),
      }),
    );
    const results = doneResults(events);
    expect(workflowOk(events)).toBe(true);
    const artifact = results.get("author")?.artifacts?.[0];
    expect(artifact?.name).toBe("notes");
    expect((await readFile(artifact?.path as string, "utf8")).trim()).toBe("written by agent");
  });

  it("fails the step when a declared artifact was not produced", async () => {
    const root = await tempDir();
    const repo = await initRepo(root);
    const events = await runToEvents(
      spec([
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "build",
              kind: "command",
              cmd: "echo ok",
              artifacts: ["report.md"],
            },
          ],
        },
      ]),
      gitDeps(repo, root),
    );
    const results = doneResults(events);
    expect(workflowOk(events)).toBe(false);
    expect(results.get("build")?.ok).toBe(false);
    expect(results.get("build")?.error).toContain("declared artifact not produced: report.md");
  });

  it("does not snapshot artifacts of a failed step", async () => {
    const root = await tempDir();
    const repo = await initRepo(root);
    const events = await runToEvents(
      spec([
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "build",
              kind: "command",
              cmd: "echo findings > report.md && exit 1",
              artifacts: ["report.md"],
            },
          ],
        },
      ]),
      gitDeps(repo, root),
    );
    const results = doneResults(events);
    expect(workflowOk(events)).toBe(false);
    expect(results.get("build")?.artifacts).toBeUndefined();
  });
});

describe("artifact snapshot guard", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("refuses to snapshot a name that resolves outside the step's snapshot dir", async () => {
    // Defense in depth below the validator: a depth-balanced trailing `..`
    // must never let rm/cp target the shared run artifacts directory.
    const root = await tempDir();
    const stepCwd = join(root, "work");
    const artifactsDir = join(root, "artifacts");
    await mkdir(join(stepCwd, "src"), { recursive: true });
    await mkdir(join(artifactsDir, "other-step"), { recursive: true });
    await writeFile(join(artifactsDir, "other-step", "keep.txt"), "precious\n");

    await expect(
      collectArtifacts({ declared: ["src/.."], stepCwd, artifactsDir, stepId: "evil" }),
    ).rejects.toThrow("resolves outside the step's snapshot directory");
    // The other step's snapshot survived untouched.
    expect((await readFile(join(artifactsDir, "other-step", "keep.txt"), "utf8")).trim()).toBe(
      "precious",
    );
  });
});

describe("artifact templates", () => {
  it("renders the snapshot path by name and empty text for unknowns", () => {
    const results = new Map([
      [
        "build",
        {
          ok: true,
          artifacts: [{ name: "report", path: "/runs/artifacts/build/report" }],
        },
      ],
    ]);
    const ctx = { input: "", outputs: new Map<string, string>(), results };
    expect(renderPrompt("read {{steps.build.artifacts.report}}", ctx)).toBe(
      "read /runs/artifacts/build/report",
    );
    expect(renderPrompt("read {{steps.build.artifacts.ghost}}", ctx)).toBe("read ");
    expect(renderPrompt("read {{steps.ghost.artifacts.report}}", ctx)).toBe("read ");
  });
});
