import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  createWorkflowRunControl,
  fingerprintChanges,
  fingerprintWorkspace,
  runWorkflow,
} from "../src/workflow";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

/**
 * A fake adapter that records how it was invoked and, optionally, writes a file
 * into its cwd — the way a misbehaving "read-only" agent would.
 */
function fakeAdapter(
  calls: AgentRunOptions[],
  options: { writes?: string; provider?: AgentId } = {},
): (id: AgentId) => AgentAdapter {
  return (id: AgentId) => ({
    id: options.provider ?? id,
    binary: "fake",
    defaultModel: "test",
    run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
      calls.push(opts);
      return (async function* () {
        if (options.writes && opts.cwd) {
          await writeFile(join(opts.cwd, options.writes), "the agent could not resist\n");
        }
        yield { kind: "result", agent: id, ts: 0, isError: false, text: "ok" } as AgentEvent;
      })();
    },
  });
}

async function collect(spec: WorkflowSpec, deps: WorkflowDeps): Promise<WorkflowEvent[]> {
  const events: WorkflowEvent[] = [];
  for await (const ev of runWorkflow(spec, { input: "task" }, deps)) events.push(ev);
  return events;
}

const doneResult = (events: WorkflowEvent[], stepId: string): StepResult | undefined =>
  (
    events.find((e) => e.kind === "step_done" && e.stepId === stepId) as
      | (WorkflowEvent & { kind: "step_done" })
      | undefined
  )?.result;

const startEvent = (events: WorkflowEvent[], stepId: string) =>
  events.find((e) => e.kind === "step_start" && e.stepId === stepId) as
    | (WorkflowEvent & { kind: "step_start" })
    | undefined;

/**
 * A one-step review workflow. The model must be one the agent actually offers:
 * the engine rematerializes a mismatched agent+model pin onto whichever agent
 * can serve the model, which would otherwise quietly move the step off the
 * agent the test is about.
 */
function reviewSpec(permissions: unknown, agent = "claude"): WorkflowSpec {
  const model = agent === "amp" ? "smart" : "opus";
  return {
    name: "wf",
    phases: [
      {
        id: "p",
        title: "P",
        steps: [{ id: "review", agent, model, prompt: "look", permissions } as never],
      },
    ],
  };
}

describe("engine: permission flags reach the adapter", () => {
  it("passes the resolved profile to the adapter", async () => {
    const calls: AgentRunOptions[] = [];
    await collect(reviewSpec("read-only"), {
      createAdapter: fakeAdapter(calls),
      maxConcurrency: 1,
      cwd: "/base",
    });
    expect(calls[0]!.permissions).toMatchObject({ profile: "read-only", verify: true });
  });

  it("passes nothing when no layer declares a profile", async () => {
    const calls: AgentRunOptions[] = [];
    await collect(reviewSpec(undefined), {
      createAdapter: fakeAdapter(calls),
      maxConcurrency: 1,
      cwd: "/base",
    });
    expect(calls[0]!.permissions).toBeUndefined();
  });

  it("inherits the workflow-level default", async () => {
    const calls: AgentRunOptions[] = [];
    const spec = { ...reviewSpec(undefined), permissions: "edit" } as WorkflowSpec;
    await collect(spec, {
      createAdapter: fakeAdapter(calls),
      maxConcurrency: 1,
      cwd: "/base",
    });
    expect(calls[0]!.permissions?.profile).toBe("edit");
  });

  it("inherits the config-level default, and a step still overrides it", async () => {
    const calls: AgentRunOptions[] = [];
    await collect(reviewSpec(undefined), {
      createAdapter: fakeAdapter(calls),
      maxConcurrency: 1,
      cwd: "/base",
      agentConfig: { permissions: "read-only" },
    });
    expect(calls[0]!.permissions?.profile).toBe("read-only");

    const stepCalls: AgentRunOptions[] = [];
    await collect(reviewSpec("full"), {
      createAdapter: fakeAdapter(stepCalls),
      maxConcurrency: 1,
      cwd: "/base",
      agentConfig: { permissions: "read-only" },
    });
    expect(stepCalls[0]!.permissions?.profile).toBe("full");
  });

  it("records the enforcement outcome on the step result", async () => {
    const events = await collect(reviewSpec("read-only"), {
      createAdapter: fakeAdapter([]),
      maxConcurrency: 1,
      cwd: "/base",
    });
    expect(doneResult(events, "review")?.permissions).toMatchObject({
      profile: "read-only",
      enforcement: "native",
    });
  });

  it("badges the step from step_start, before it produces anything", async () => {
    const events = await collect(
      reviewSpec({ profile: "read-only", allow: ["Bash(ls:*)"], deny: ["WebFetch"] }),
      { createAdapter: fakeAdapter([]), maxConcurrency: 1, cwd: "/base" },
    );
    expect(startEvent(events, "review")?.permissions).toEqual({
      profile: "read-only",
      allow: 1,
      deny: 1,
      verify: true,
    });
  });
});

describe("engine: unenforceable profiles are refused", () => {
  it("fails the step before spawning when the agent cannot enforce it", async () => {
    const calls: AgentRunOptions[] = [];
    const events = await collect(reviewSpec("read-only", "amp"), {
      createAdapter: fakeAdapter(calls),
      maxConcurrency: 1,
      cwd: "/base",
    });
    const result = doneResult(events, "review");
    expect(result?.ok).toBe(false);
    expect(result?.error).toMatch(/cannot enforce it/);
    expect(result?.permissions).toMatchObject({ profile: "read-only", enforcement: "none" });
    // The whole point: no agent process was ever started.
    expect(calls).toHaveLength(0);
  });

  it("runs unenforced when the author opts in, and records the gap", async () => {
    const calls: AgentRunOptions[] = [];
    const events = await collect(
      reviewSpec({ profile: "read-only", onUnsupported: "warn" }, "amp"),
      { createAdapter: fakeAdapter(calls), maxConcurrency: 1, cwd: "/base" },
    );
    const result = doneResult(events, "review");
    expect(result?.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(result?.permissions?.enforcement).toBe("none");
    expect(result?.permissions?.gaps?.[0]).toMatch(/amp cannot enforce/);
  });

  it("does not retry an unenforceable step — no retry could change the answer", async () => {
    const calls: AgentRunOptions[] = [];
    const spec: WorkflowSpec = {
      ...reviewSpec("read-only", "amp"),
      retry: { maxAttempts: 3, initialDelayMs: 0 },
    };
    const events = await collect(spec, {
      createAdapter: fakeAdapter(calls),
      maxConcurrency: 1,
      cwd: "/base",
    });
    expect(events.filter((e) => e.kind === "step_retry")).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe("read-only workspace verification", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("fails a read-only step that modified its workspace, with the paths", async () => {
    const root = await tempDir();
    const repo = join(root, "repo");
    await initRepo(repo);

    const events = await collect(
      reviewSpec({ profile: "read-only", onUnsupported: "warn" }, "amp"),
      {
        createAdapter: fakeAdapter([], { writes: "sneaky.txt" }),
        maxConcurrency: 1,
        cwd: repo,
        agentWorkspace: createGitWorktreeManager({
          baseDir: join(root, "worktrees"),
          runId: "run-perm",
        }),
      },
    );

    const result = doneResult(events, "review");
    expect(result?.ok).toBe(false);
    expect(result?.error).toMatch(/permission violation/);
    expect(result?.permissions?.violations?.join(" ")).toContain("sneaky.txt");
    expect(result?.permissions?.verified).toBe(true);
  });

  it("passes a read-only step that touched nothing", async () => {
    const root = await tempDir();
    const repo = join(root, "repo");
    await initRepo(repo);

    const events = await collect(reviewSpec("read-only", "claude"), {
      createAdapter: fakeAdapter([]),
      maxConcurrency: 1,
      cwd: repo,
      agentWorkspace: createGitWorktreeManager({
        baseDir: join(root, "worktrees"),
        runId: "run-perm-ok",
      }),
    });

    const result = doneResult(events, "review");
    expect(result?.ok).toBe(true);
    expect(result?.permissions?.violations).toBeUndefined();
    expect(result?.permissions?.verified).toBe(true);
  });

  it("judges an attached step against ITS OWN baseline, not the repo's cleanliness", async () => {
    const root = await tempDir();
    const repo = join(root, "repo");
    await initRepo(repo);
    const manager = createGitWorktreeManager({
      baseDir: join(root, "worktrees"),
      runId: "run-attach",
    });

    // impl writes, then review attaches to impl's dirty worktree and behaves.
    const spec: WorkflowSpec = {
      name: "wf",
      phases: [
        {
          id: "a",
          title: "A",
          steps: [{ id: "impl", agent: "claude", model: "opus", prompt: "write" }],
        },
        {
          id: "b",
          title: "B",
          steps: [
            {
              id: "review",
              agent: "claude",
              model: "opus",
              dependsOn: ["impl"],
              workspace: "attach:impl",
              permissions: "read-only",
              prompt: "look",
            },
          ],
        },
      ],
    };

    let call = 0;
    const adapter = (id: AgentId): AgentAdapter => ({
      id,
      binary: "fake",
      defaultModel: "test",
      run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
        const isImpl = call === 0;
        call += 1;
        return (async function* () {
          // Only the implement step writes; the reviewer inherits that edit as
          // its starting state and must not be blamed for it.
          if (isImpl && opts.cwd) await writeFile(join(opts.cwd, "impl.txt"), "work\n");
          yield { kind: "result", agent: id, ts: 0, isError: false, text: "ok" } as AgentEvent;
        })();
      },
    });

    const events = await collect(spec, {
      createAdapter: adapter,
      maxConcurrency: 1,
      cwd: repo,
      agentWorkspace: manager,
    });

    expect(doneResult(events, "impl")?.ok).toBe(true);
    const review = doneResult(events, "review");
    expect(review?.ok).toBe(true);
    expect(review?.permissions?.violations).toBeUndefined();
  });

  it("skips verification (rather than failing) outside a git repository", async () => {
    const root = await tempDir();
    const events = await collect(reviewSpec("read-only", "claude"), {
      createAdapter: fakeAdapter([], { writes: "anything.txt" }),
      maxConcurrency: 1,
      cwd: root,
    });
    const result = doneResult(events, "review");
    expect(result?.ok).toBe(true);
    expect(result?.permissions?.verified).toBe(false);
  });
});

describe("fingerprintWorkspace", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("changes with content, ignores gitignored paths, and names what moved", async () => {
    const root = await tempDir();
    const repo = join(root, "repo");
    await initRepo(repo);
    await writeFile(join(repo, ".gitignore"), "ignored/\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "ignore");

    const before = await fingerprintWorkspace(repo);
    expect(before).toBeDefined();

    // A gitignored write must not register.
    await mkdir(join(repo, "ignored"), { recursive: true });
    await writeFile(join(repo, "ignored", "cache.bin"), "junk\n");
    expect((await fingerprintWorkspace(repo))?.tree).toBe(before?.tree);

    // Editing an ALREADY dirty tracked file must register (the attach case).
    await writeFile(join(repo, "README.md"), "changed\n");
    const dirty = await fingerprintWorkspace(repo);
    expect(dirty?.tree).not.toBe(before?.tree);
    await writeFile(join(repo, "README.md"), "changed again\n");
    const dirtier = await fingerprintWorkspace(repo);
    expect(dirtier?.tree).not.toBe(dirty?.tree);
    expect((await fingerprintChanges(dirty, dirtier)).join(" ")).toContain("README.md");
  });

  it("reports no changes and no fingerprint outside a repository", async () => {
    const root = await tempDir();
    expect(await fingerprintWorkspace(root)).toBeUndefined();
    expect(await fingerprintChanges(undefined, undefined)).toEqual([]);
  });
});

describe("mid-run steering: clamp a pending step's sandbox", () => {
  const chain: WorkflowSpec = {
    name: "chain",
    phases: [
      {
        id: "p1",
        title: "P1",
        steps: [{ id: "a", agent: "claude", model: "opus", prompt: "{{input}}" }],
      },
      {
        id: "p2",
        title: "P2",
        steps: [
          {
            id: "b",
            agent: "claude",
            model: "opus",
            dependsOn: ["a"],
            prompt: "b",
            permissions: "full",
          },
        ],
      },
    ],
  };

  it("applies a permissions edit to a step that has not started yet", async () => {
    const control = createWorkflowRunControl();
    const calls: AgentRunOptions[] = [];
    const deps: WorkflowDeps = {
      createAdapter: fakeAdapter(calls),
      maxConcurrency: 1,
      cwd: "/base",
      control,
    };
    control.pause("human:test");

    const events: WorkflowEvent[] = [];
    for await (const event of runWorkflow(chain, { input: "task" }, deps)) {
      events.push(event);
      if (event.kind === "run_paused") {
        // 'b' has not started: clamp it, then let the run continue.
        expect(control.editStep("b", { permissions: "read-only" }, "human:test")).toEqual({
          ok: true,
        });
        control.resume("human:test");
      }
    }

    // 'a' ran unrestricted (it declares nothing); 'b' ran under the clamp.
    expect(calls[0]!.permissions).toBeUndefined();
    expect(calls[1]!.permissions?.profile).toBe("read-only");
    expect(doneResult(events, "b")?.permissions?.profile).toBe("read-only");
    expect(doneResult(events, "b")?.edited).toBe(true);
  });

  it("rejects a profile that cannot mean anything, and an unknown one", async () => {
    const control = createWorkflowRunControl();
    const deps: WorkflowDeps = {
      createAdapter: fakeAdapter([]),
      maxConcurrency: 1,
      cwd: "/base",
      control,
    };
    control.pause("human:test");
    const spec: WorkflowSpec = {
      name: "wf",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "a", agent: "claude", model: "opus", prompt: "x" }],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            { id: "g", kind: "gate", dependsOn: ["a"], condition: { step: "a", ok: true } },
            {
              id: "art",
              agent: "claude",
              model: "opus",
              dependsOn: ["a"],
              prompt: "y",
              artifacts: ["report.md"],
            },
          ],
        },
      ],
    };

    for await (const event of runWorkflow(spec, { input: "task" }, deps)) {
      if (event.kind !== "run_paused") continue;
      expect(control.editStep("g", { permissions: "read-only" })).toMatchObject({ ok: false });
      expect(control.editStep("art", { permissions: "read-only" })).toMatchObject({ ok: false });
      expect(control.editStep("art", { permissions: "nope" })).toMatchObject({ ok: false });
      // Clearing is always legal.
      expect(control.editStep("art", { permissions: "" })).toEqual({ ok: true });
      control.resume();
    }
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "steamtrain-perm-test-"));
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
