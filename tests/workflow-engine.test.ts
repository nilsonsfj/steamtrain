import { resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunOptions } from "../src/agents";
import type { AgentEvent, AgentId } from "../src/types/events";
import {
  type AgentWorkspaceManager,
  type AgentWorkspaceRequest,
  MAX_STEPS,
  type StepResult,
  type WorkflowDeps,
  type WorkflowEvent,
  type WorkflowSpec,
  runWorkflow,
} from "../src/workflow";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface RunRecord {
  id: AgentId;
  opts: AgentRunOptions;
}
interface FakeState {
  runs: RunRecord[];
  active: number;
  peak: number;
  delayMs: number;
}
type Script = (opts: AgentRunOptions, id: AgentId) => AgentEvent[];

/** A default adapter script: streams a little text, then echoes the model in its result. */
const echo: Script = (opts) => [
  { kind: "session_start", agent: "claude", ts: 0 },
  { kind: "text_delta", agent: "claude", ts: 0, text: "working" },
  {
    kind: "result",
    agent: "claude",
    ts: 0,
    isError: false,
    text: `out:${opts.model}`,
    costUsd: 0.002,
  },
];

function makeCreateAdapter(script: Script, state: FakeState) {
  return (id: AgentId): AgentAdapter => ({
    id,
    binary: "fake",
    defaultModel: "test",
    run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
      return (async function* () {
        state.runs.push({ id, opts });
        state.active += 1;
        state.peak = Math.max(state.peak, state.active);
        try {
          if (state.delayMs > 0) await delay(state.delayMs);
          let first = true;
          for (const event of script(opts, id)) {
            if (!first && opts.signal?.aborted) return; // mimic process kill on cancel
            first = false;
            await Promise.resolve();
            yield event;
          }
        } finally {
          state.active -= 1;
        }
      })();
    },
  });
}

function makeDeps(
  script: Script,
  over: {
    maxConcurrency?: number;
    cwd?: string;
    delayMs?: number;
    agentWorkspace?: AgentWorkspaceManager;
  } = {},
): { deps: WorkflowDeps; state: FakeState } {
  const state: FakeState = { runs: [], active: 0, peak: 0, delayMs: over.delayMs ?? 0 };
  const deps: WorkflowDeps = {
    createAdapter: makeCreateAdapter(script, state),
    maxConcurrency: over.maxConcurrency ?? 4,
    cwd: over.cwd ?? "/base",
    agentWorkspace: over.agentWorkspace,
  };
  return { deps, state };
}

async function collect(
  spec: WorkflowSpec,
  input: string,
  deps: WorkflowDeps,
  opts: { signal?: AbortSignal; cache?: Map<string, StepResult> } = {},
): Promise<WorkflowEvent[]> {
  const events: WorkflowEvent[] = [];
  for await (const ev of runWorkflow(spec, { input, cache: opts.cache }, deps, opts.signal)) {
    events.push(ev);
  }
  return events;
}

const twoPhase: WorkflowSpec = {
  name: "two-phase",
  phases: [
    {
      id: "p1",
      title: "P1",
      steps: [
        { id: "a", agent: "claude", model: "ma", prompt: "{{input}}" },
        { id: "b", agent: "claude", model: "mb", prompt: "{{input}}" },
        { id: "c", agent: "claude", model: "mc", prompt: "{{input}}" },
      ],
    },
    {
      id: "p2",
      title: "P2",
      steps: [{ id: "d", agent: "claude", model: "md", prompt: "{{input}}" }],
    },
  ],
};

describe("runWorkflow", () => {
  it("runs phases sequentially and steps within a phase in parallel", async () => {
    const { deps, state } = makeDeps(echo, { maxConcurrency: 3, delayMs: 20 });
    const events = await collect(twoPhase, "hi", deps);

    expect(state.peak).toBe(3); // all three phase-1 steps overlapped

    const lastP1Done = lastIndex(events, (e) => e.kind === "step_done" && e.stepId !== "d");
    const dStart = events.findIndex((e) => e.kind === "step_start" && e.stepId === "d");
    expect(dStart).toBeGreaterThan(lastP1Done); // phase 2 started only after phase 1

    expect(events.at(-1)).toMatchObject({ kind: "workflow_done", ok: true });
  });

  it("honors maxConcurrency", async () => {
    const { deps, state } = makeDeps(echo, { maxConcurrency: 2, delayMs: 20 });
    const events = await collect(twoPhase, "hi", deps);
    expect(state.peak).toBe(2);
  });

  it("feeds a prior step's output into a later step's prompt", async () => {
    const spec: WorkflowSpec = {
      name: "chain",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "a", agent: "claude", model: "alpha", prompt: "{{input}}" }],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            {
              id: "b",
              agent: "claude",
              model: "beta",
              prompt: "use {{steps.a.output}}",
              dependsOn: ["a"],
            },
          ],
        },
      ],
    };
    const { deps, state } = makeDeps(echo);
    await collect(spec, "x", deps);

    const bRun = state.runs.find((r) => r.opts.model === "beta");
    expect(bRun?.opts.prompt).toBe("use out:alpha");
  });

  it("marks a failed step not-ok but still runs later phases", async () => {
    const failing: Script = (opts, id) =>
      opts.model === "bad"
        ? [{ kind: "error", agent: id, ts: 0, message: "boom" }]
        : echo(opts, id);
    const spec: WorkflowSpec = {
      name: "fail",
      // This test asserts failure handling, not retry; keep "a" to one attempt.
      retry: { maxAttempts: 1 },
      phases: [
        { id: "p1", title: "P1", steps: [{ id: "a", agent: "claude", model: "bad", prompt: "x" }] },
        { id: "p2", title: "P2", steps: [{ id: "b", agent: "claude", model: "ok", prompt: "x" }] },
      ],
    };
    const { deps, state } = makeDeps(failing);
    const events = await collect(spec, "x", deps);

    const aDone = events.find((e) => e.kind === "step_done" && e.stepId === "a");
    expect(aDone && aDone.kind === "step_done" && aDone.result.ok).toBe(false);
    expect(state.runs.some((r) => r.opts.model === "ok")).toBe(true); // phase 2 ran
    expect(events.at(-1)).toMatchObject({ kind: "workflow_done", ok: false });
  });

  it("resumes completed steps from the cache without re-running them", async () => {
    const spec: WorkflowSpec = {
      name: "resume",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "a", agent: "claude", model: "ma", prompt: "{{input}}" }],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            {
              id: "b",
              agent: "claude",
              model: "mb",
              prompt: "{{steps.a.output}}",
              dependsOn: ["a"],
            },
          ],
        },
      ],
    };
    const cache = new Map<string, StepResult>([
      ["a", { stepId: "a", ok: true, output: "CACHED", durationMs: 1 }],
    ]);
    const { deps, state } = makeDeps(echo);
    const events = await collect(spec, "x", deps, { cache });

    expect(state.runs.some((r) => r.opts.model === "ma")).toBe(false); // 'a' not re-run
    const aDone = events.find((e) => e.kind === "step_done" && e.stepId === "a");
    expect(aDone && aDone.kind === "step_done" && aDone.cached).toBe(true);

    const bRun = state.runs.find((r) => r.opts.model === "mb");
    expect(bRun?.opts.prompt).toBe("CACHED");
  });

  it("passes per-step cwd, env, effort and extraArgs to the adapter", async () => {
    const spec: WorkflowSpec = {
      name: "targets",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "a",
              agent: "claude",
              model: "ma",
              prompt: "x",
              cwd: "sub/dir",
              env: { FOO: "bar" },
              effort: "high",
              extraArgs: ["--add-dir", "."],
            },
          ],
        },
      ],
    };
    const { deps, state } = makeDeps(echo, { cwd: "/base" });
    await collect(spec, "x", deps);

    const rec = state.runs[0];
    expect(rec?.opts.cwd).toBe(resolvePath("/base", "sub/dir"));
    expect(rec?.opts.env).toEqual({ FOO: "bar" });
    expect(rec?.opts.effort).toBe("high");
    expect(rec?.opts.extraArgs).toEqual(["--add-dir", "."]);
  });

  it("runs parallel agent steps in separate allocated workspaces", async () => {
    const requests: AgentWorkspaceRequest[] = [];
    const agentWorkspace: AgentWorkspaceManager = {
      async allocate(request) {
        requests.push(request);
        return {
          cwd: `/isolated/${request.stepId}`,
          root: `/isolated/${request.stepId}`,
          branch: `steamtrain/test/${request.stepId}`,
          dispose: () => {},
        };
      },
    };
    const { deps, state } = makeDeps(echo, {
      maxConcurrency: 3,
      delayMs: 20,
      agentWorkspace,
    });

    const events = await collect(twoPhase, "hi", deps);

    expect(requests.map((request) => request.stepId)).toEqual(["a", "b", "c", "d"]);
    expect(new Set(state.runs.map((run) => run.opts.cwd)).size).toBe(4);
    expect(state.runs.map((run) => run.opts.cwd)).toEqual([
      "/isolated/a",
      "/isolated/b",
      "/isolated/c",
      "/isolated/d",
    ]);
    const aDone = events.find((event) => event.kind === "step_done" && event.stepId === "a");
    expect(aDone && aDone.kind === "step_done" && aDone.result.worktree).toEqual({
      originalCwd: "/base",
      cwd: "/isolated/a",
      root: "/isolated/a",
      branch: "steamtrain/test/a",
      linkedIgnoredPaths: undefined,
    });
  });

  it("announces the allocated workspace live via step_workspace", async () => {
    const agentWorkspace: AgentWorkspaceManager = {
      async allocate(request) {
        return {
          cwd: `/isolated/${request.stepId}`,
          root: `/isolated/${request.stepId}`,
          branch: `steamtrain/test/${request.stepId}`,
          baseCommit: "abc123",
          dispose: () => {},
        };
      },
    };
    const { deps } = makeDeps(echo, { agentWorkspace });
    const spec: WorkflowSpec = {
      name: "ws-live",
      phases: [
        { id: "p1", title: "P1", steps: [{ id: "a", agent: "claude", model: "m", prompt: "x" }] },
      ],
    };

    const events = await collect(spec, "hi", deps);

    const kinds = events.map((event) => event.kind);
    // The workspace announcement lands between the step's start and its done,
    // so live views learn the worktree while the step is still running.
    expect(kinds.indexOf("step_workspace")).toBeGreaterThan(kinds.indexOf("step_start"));
    expect(kinds.indexOf("step_workspace")).toBeLessThan(kinds.indexOf("step_done"));
    const ws = events.find((event) => event.kind === "step_workspace");
    expect(ws && ws.kind === "step_workspace" && ws.stepId).toBe("a");
    expect(ws && ws.kind === "step_workspace" && ws.cwd).toBe("/isolated/a");
    expect(ws && ws.kind === "step_workspace" && ws.worktree).toEqual({
      originalCwd: "/base",
      cwd: "/isolated/a",
      root: "/isolated/a",
      branch: "steamtrain/test/a",
      baseCommit: "abc123",
      linkedIgnoredPaths: undefined,
    });
  });

  it("step_workspace carries the plain cwd (no worktree) outside isolation", async () => {
    const { deps } = makeDeps(echo, {});
    const spec: WorkflowSpec = {
      name: "ws-plain",
      phases: [
        { id: "p1", title: "P1", steps: [{ id: "a", agent: "claude", model: "m", prompt: "x" }] },
      ],
    };

    const events = await collect(spec, "hi", deps);

    const ws = events.find((event) => event.kind === "step_workspace");
    expect(ws && ws.kind === "step_workspace" && ws.cwd).toBe("/base");
    expect(ws && ws.kind === "step_workspace" && ws.worktree).toBeUndefined();
  });

  it("runs forEach children in separate allocated workspaces", async () => {
    const requests: AgentWorkspaceRequest[] = [];
    const agentWorkspace: AgentWorkspaceManager = {
      async allocate(request) {
        requests.push(request);
        return { cwd: `/isolated/${request.stepId}`, dispose: () => {} };
      },
    };
    const spec: WorkflowSpec = {
      name: "dynamic-isolation",
      phases: [
        {
          id: "split",
          title: "Split",
          steps: [{ id: "targets", kind: "distributor", items: ["api", "web"] }],
        },
        {
          id: "process",
          title: "Process",
          steps: [
            {
              id: "review-each",
              kind: "processor",
              agent: "claude",
              model: "m",
              dependsOn: ["targets"],
              forEach: "steps.targets.items",
              prompt: "review {{item}}",
            },
          ],
        },
      ],
    };
    const { deps, state } = makeDeps(echo, { maxConcurrency: 2, agentWorkspace });

    await collect(spec, "task", deps);

    expect(requests.map((request) => request.stepId)).toEqual(["review-each[0]", "review-each[1]"]);
    expect(requests.map((request) => request.item?.value)).toEqual(["api", "web"]);
    expect(state.runs.map((run) => run.opts.cwd)).toEqual([
      "/isolated/review-each[0]",
      "/isolated/review-each[1]",
    ]);
  });

  it("reports workspace allocation failures as step failures", async () => {
    const agentWorkspace: AgentWorkspaceManager = {
      async allocate() {
        throw new Error("unable to create worktree");
      },
    };
    const spec: WorkflowSpec = {
      name: "workspace-failure",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "a", agent: "claude", model: "ma", prompt: "x" }],
        },
      ],
    };
    const { deps, state } = makeDeps(echo, { agentWorkspace });

    const events = await collect(spec, "task", deps);

    expect(state.runs).toHaveLength(0);
    const done = events.find((event) => event.kind === "step_done" && event.stepId === "a");
    expect(done && done.kind === "step_done" && done.result).toMatchObject({
      ok: false,
      error: "unable to create worktree",
    });
    expect(events.at(-1)).toMatchObject({ kind: "workflow_done", ok: false });
  });

  it("executes distributor, consolidator, and gate blocks", async () => {
    const spec: WorkflowSpec = {
      name: "blocks",
      phases: [
        {
          id: "split",
          title: "Split",
          steps: [{ id: "split", kind: "distributor", items: ["{{input}}:a", "{{input}}:b"] }],
        },
        {
          id: "merge",
          title: "Merge",
          steps: [
            {
              id: "merge",
              kind: "consolidator",
              dependsOn: ["split"],
              prompt: "items:\n{{steps.split.items}}",
            },
          ],
        },
        {
          id: "gate",
          title: "Gate",
          steps: [
            {
              id: "ready",
              kind: "gate",
              dependsOn: ["merge"],
              condition: { step: "merge", contains: "task:a" },
              target: "ready",
            },
          ],
        },
        {
          id: "work",
          title: "Work",
          steps: [
            {
              id: "work",
              kind: "worker",
              agent: "claude",
              model: "mw",
              dependsOn: ["ready"],
              prompt: "{{steps.ready.target}} {{steps.merge.output}}",
            },
          ],
        },
      ],
    };
    const { deps, state } = makeDeps(echo);
    const events = await collect(spec, "task", deps);

    const split = events.find((e) => e.kind === "step_done" && e.stepId === "split");
    expect(split && split.kind === "step_done" && split.result.items).toEqual(["task:a", "task:b"]);
    const gate = events.find((e) => e.kind === "gate_evaluated");
    expect(gate).toMatchObject({ kind: "gate_evaluated", stepId: "ready", passed: true });
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]?.opts.prompt).toBe("ready items:\ntask:a\ntask:b");
    expect(events.at(-1)).toMatchObject({ kind: "workflow_done", ok: true });
  });

  it("dynamically fans a processor out over distributor items", async () => {
    const spec: WorkflowSpec = {
      name: "dynamic",
      phases: [
        {
          id: "split",
          title: "Split",
          steps: [{ id: "targets", kind: "distributor", items: ["api", "web", "docs"] }],
        },
        {
          id: "process",
          title: "Process",
          steps: [
            {
              id: "review-each",
              kind: "processor",
              agent: "claude",
              model: "m",
              dependsOn: ["targets"],
              forEach: "steps.targets.items",
              prompt: "review {{item.index}} {{item}} for {{input}}",
            },
          ],
        },
        {
          id: "report",
          title: "Report",
          steps: [
            {
              id: "report",
              kind: "consolidator",
              dependsOn: ["review-each"],
              prompt: "{{steps.review-each.output}}",
            },
          ],
        },
      ],
    };
    const { deps, state } = makeDeps(echo, { maxConcurrency: 2, delayMs: 10 });
    const events = await collect(spec, "task", deps);

    expect(state.runs).toHaveLength(3);
    expect(state.peak).toBe(2);
    expect(state.runs.map((r) => r.opts.prompt)).toEqual([
      "review 0 api for task",
      "review 1 web for task",
      "review 2 docs for task",
    ]);

    const childStarts = events.filter(
      (e) => e.kind === "step_start" && e.parentStepId === "review-each",
    );
    expect(childStarts.map((e) => (e.kind === "step_start" ? e.stepId : ""))).toEqual([
      "review-each[0]",
      "review-each[1]",
      "review-each[2]",
    ]);
    expect(childStarts[0]).toMatchObject({
      kind: "step_start",
      item: { sourceStepId: "targets", index: 0, value: "api" },
    });

    const parentDone = events.find((e) => e.kind === "step_done" && e.stepId === "review-each");
    expect(
      parentDone && parentDone.kind === "step_done" && parentDone.result.childResults,
    ).toHaveLength(3);
    expect(parentDone && parentDone.kind === "step_done" && parentDone.result.output).toContain(
      "--- review-each[0] (api) ---",
    );

    const reportDone = events.find((e) => e.kind === "step_done" && e.stepId === "report");
    expect(reportDone && reportDone.kind === "step_done" && reportDone.result.output).toContain(
      "review-each[2]",
    );
    expect(events.at(-1)).toMatchObject({ kind: "workflow_done", ok: true });
  });

  it("parses agent-backed distributor output into fan-out items", async () => {
    const script: Script = (opts, id) =>
      opts.model === "splitter"
        ? [
            {
              kind: "result",
              agent: id,
              ts: 0,
              isError: false,
              text: "api\nweb\n\ndocs",
            },
          ]
        : echo(opts, id);
    const spec: WorkflowSpec = {
      name: "agent-split",
      phases: [
        {
          id: "split",
          title: "Split",
          steps: [
            {
              id: "split",
              kind: "distributor",
              agent: "claude",
              model: "splitter",
              prompt: "split {{input}}",
            },
          ],
        },
        {
          id: "work",
          title: "Work",
          steps: [
            {
              id: "work",
              kind: "processor",
              agent: "claude",
              model: "m",
              dependsOn: ["split"],
              forEach: "steps.split.items",
              prompt: "{{item}}",
            },
          ],
        },
      ],
    };
    const { deps, state } = makeDeps(script);
    const events = await collect(spec, "task", deps);

    const splitDone = events.find((e) => e.kind === "step_done" && e.stepId === "split");
    expect(splitDone && splitDone.kind === "step_done" && splitDone.result.items).toEqual([
      "api",
      "web",
      "docs",
    ]);
    expect(state.runs.map((r) => r.opts.prompt)).toEqual(["split task", "api", "web", "docs"]);
  });

  it("does not fan out when the distributor source failed", async () => {
    const failingSplit: Script = (opts, id) =>
      opts.model === "splitter"
        ? [{ kind: "error", agent: id, ts: 0, message: "split failed" }]
        : echo(opts, id);
    const spec: WorkflowSpec = {
      name: "failed-split",
      phases: [
        {
          id: "split",
          title: "Split",
          steps: [
            {
              id: "split",
              kind: "distributor",
              agent: "claude",
              model: "splitter",
              prompt: "split",
            },
          ],
        },
        {
          id: "work",
          title: "Work",
          steps: [
            {
              id: "work",
              kind: "processor",
              agent: "claude",
              model: "m",
              dependsOn: ["split"],
              forEach: "steps.split.items",
              prompt: "{{item}}",
            },
          ],
        },
      ],
    };
    const { deps, state } = makeDeps(failingSplit);
    const events = await collect(spec, "task", deps);

    expect(state.runs).toHaveLength(1);
    expect(events.some((e) => e.kind === "step_start" && e.stepId === "work[0]")).toBe(false);
    const workDone = events.find((e) => e.kind === "step_done" && e.stepId === "work");
    expect(workDone && workDone.kind === "step_done" && workDone.result.ok).toBe(false);
    expect(workDone && workDone.kind === "step_done" && workDone.result.error).toMatch(
      /dependency 'split' failed/,
    );
    // The downstream step's error carries the root cause so UIs surfacing only
    // this step (often the run's last one) still explain what actually broke.
    expect(workDone && workDone.kind === "step_done" && workDone.result.error).toContain(
      "split failed",
    );
    expect(workDone && workDone.kind === "step_done" && workDone.result.output).toContain(
      "split failed",
    );
  });

  it("enforces the dynamic step cap for agent-generated distributor items", async () => {
    const manyItems = Array.from({ length: MAX_STEPS }, (_, i) => `item-${i}`).join("\n");
    const script: Script = (opts, id) =>
      opts.model === "splitter"
        ? [{ kind: "result", agent: id, ts: 0, isError: false, text: manyItems }]
        : echo(opts, id);
    const spec: WorkflowSpec = {
      name: "runtime-cap",
      phases: [
        {
          id: "split",
          title: "Split",
          steps: [
            {
              id: "split",
              kind: "distributor",
              agent: "claude",
              model: "splitter",
              prompt: "split",
            },
          ],
        },
        {
          id: "work",
          title: "Work",
          steps: [
            {
              id: "work",
              kind: "processor",
              agent: "claude",
              model: "m",
              dependsOn: ["split"],
              forEach: "steps.split.items",
              prompt: "{{item}}",
            },
          ],
        },
      ],
    };
    const { deps, state } = makeDeps(script);
    const events = await collect(spec, "task", deps);

    expect(state.runs).toHaveLength(1);
    const workDone = events.find((e) => e.kind === "step_done" && e.stepId === "work");
    expect(workDone && workDone.kind === "step_done" && workDone.result.ok).toBe(false);
    expect(workDone && workDone.kind === "step_done" && workDone.result.error).toMatch(
      /exceed max workflow steps/,
    );
  });

  it("stops later phases when a gate fails with onFalse fail", async () => {
    const spec: WorkflowSpec = {
      name: "fail-stop",
      phases: [
        {
          id: "split",
          title: "Split",
          steps: [{ id: "split", kind: "distributor", items: ["nope"] }],
        },
        {
          id: "gate",
          title: "Gate",
          steps: [
            {
              id: "gate",
              kind: "gate",
              dependsOn: ["split"],
              condition: { step: "split", contains: "yes" },
              onFalse: "fail",
            },
          ],
        },
        {
          id: "later",
          title: "Later",
          steps: [{ id: "later", agent: "claude", model: "ml", prompt: "should not run" }],
        },
      ],
    };
    const { deps, state } = makeDeps(echo);
    const events = await collect(spec, "x", deps);

    expect(state.runs).toHaveLength(0);
    expect(events.some((e) => e.kind === "phase_start" && e.phaseId === "later")).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: "workflow_done", ok: false });
  });

  it("skips steps whose dependsOn references a failed earlier step", async () => {
    const failing: Script = (opts, id) =>
      opts.model === "bad"
        ? [{ kind: "error", agent: id, ts: 0, message: "boom" }]
        : echo(opts, id);
    const spec: WorkflowSpec = {
      name: "skip-deps",
      // This test exercises dependency-skipping, not retry; keep "a" to one run.
      retry: { maxAttempts: 1 },
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "a", agent: "claude", model: "bad", prompt: "x" }],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            {
              id: "b",
              kind: "consolidator",
              dependsOn: ["a"],
              prompt: "{{steps.a.output}}",
            },
          ],
        },
      ],
    };
    const { deps, state } = makeDeps(failing);
    const events = await collect(spec, "x", deps);

    expect(state.runs).toHaveLength(1);
    const skipped = events.find((e) => e.kind === "step_done" && e.stepId === "b");
    expect(skipped && skipped.kind === "step_done" && skipped.result.ok).toBe(false);
    expect(skipped && skipped.kind === "step_done" && skipped.result.error).toMatch(
      /dependency 'a' failed/,
    );
  });

  it("drops empty static distributor items before fan-out", async () => {
    const spec: WorkflowSpec = {
      name: "trim-items",
      phases: [
        {
          id: "split",
          title: "Split",
          steps: [{ id: "targets", kind: "distributor", items: ["api", "  ", "web"] }],
        },
        {
          id: "work",
          title: "Work",
          steps: [
            {
              id: "work",
              kind: "processor",
              agent: "claude",
              model: "m",
              dependsOn: ["targets"],
              forEach: "steps.targets.items",
              prompt: "{{item}}",
            },
          ],
        },
      ],
    };
    const { deps, state } = makeDeps(echo);
    const events = await collect(spec, "task", deps);

    const split = events.find((e) => e.kind === "step_done" && e.stepId === "targets");
    expect(split && split.kind === "step_done" && split.result.items).toEqual(["api", "web"]);
    expect(state.runs.map((r) => r.opts.prompt)).toEqual(["api", "web"]);
  });

  it("still enforces MAX_STEPS after resuming cached forEach parents", async () => {
    const runtimeItems = Array.from({ length: 600 }, (_, i) => `a${i}`).join("\n");
    const staticItems = Array.from({ length: 500 }, (_, i) => `b${i}`);
    const splitScript: Script = (opts, id) =>
      opts.model === "splitter"
        ? [{ kind: "result", agent: id, ts: 0, isError: false, text: runtimeItems }]
        : echo(opts, id);
    const spec: WorkflowSpec = {
      name: "cap-resume",
      phases: [
        {
          id: "p1",
          title: "S1",
          steps: [
            {
              id: "split1",
              kind: "distributor",
              agent: "claude",
              model: "splitter",
              prompt: "split",
            },
          ],
        },
        {
          id: "p2",
          title: "W1",
          steps: [
            {
              id: "work1",
              agent: "claude",
              model: "m",
              dependsOn: ["split1"],
              forEach: "steps.split1.items",
              prompt: "{{item}}",
            },
          ],
        },
        {
          id: "p3",
          title: "S2",
          steps: [{ id: "split2", kind: "distributor", items: staticItems }],
        },
        {
          id: "p4",
          title: "W2",
          steps: [
            {
              id: "work2",
              agent: "claude",
              model: "m",
              dependsOn: ["work1", "split2"],
              forEach: "steps.split2.items",
              prompt: "{{item}}",
            },
          ],
        },
      ],
    };
    const { deps } = makeDeps(splitScript);
    const cache = new Map<string, StepResult>();
    const first = await collect(spec, "x", deps, { cache });
    const work2First = first.find((e) => e.kind === "step_done" && e.stepId === "work2");
    expect(work2First && work2First.kind === "step_done" && work2First.result.ok).toBe(false);

    const resumed = await collect(spec, "x", deps, { cache });
    const work2Resume = resumed.find((e) => e.kind === "step_done" && e.stepId === "work2");
    expect(work2Resume && work2Resume.kind === "step_done" && work2Resume.result.ok).toBe(false);
    expect(work2Resume && work2Resume.kind === "step_done" && work2Resume.cached).toBe(false);
  });

  it("still stops after a cached gate with onFalse stop on resume", async () => {
    const spec: WorkflowSpec = {
      name: "stop-resume",
      phases: [
        {
          id: "split",
          title: "Split",
          steps: [{ id: "split", kind: "distributor", items: ["nope"] }],
        },
        {
          id: "gate",
          title: "Gate",
          steps: [
            {
              id: "gate",
              kind: "gate",
              dependsOn: ["split"],
              condition: { step: "split", contains: "yes" },
              onFalse: "stop",
            },
          ],
        },
        {
          id: "later",
          title: "Later",
          steps: [{ id: "later", agent: "claude", model: "ml", prompt: "should not run" }],
        },
      ],
    };
    const { deps, state } = makeDeps(echo);
    const cache = new Map<string, StepResult>();
    await collect(spec, "x", deps, { cache });

    const resumed = await collect(spec, "x", deps, { cache });
    expect(state.runs).toHaveLength(0);
    expect(resumed.some((e) => e.kind === "phase_start" && e.phaseId === "later")).toBe(false);
    expect(resumed.some((e) => e.kind === "step_done" && e.stepId === "gate" && e.cached)).toBe(
      false,
    );
  });

  it("stops after a blocking gate with onFalse stop", async () => {
    const spec: WorkflowSpec = {
      name: "stop",
      phases: [
        {
          id: "split",
          title: "Split",
          steps: [{ id: "split", kind: "distributor", items: ["nope"] }],
        },
        {
          id: "gate",
          title: "Gate",
          steps: [
            {
              id: "gate",
              kind: "gate",
              dependsOn: ["split"],
              condition: { step: "split", contains: "yes" },
              onFalse: "stop",
            },
          ],
        },
        {
          id: "later",
          title: "Later",
          steps: [{ id: "later", agent: "claude", model: "ml", prompt: "should not run" }],
        },
      ],
    };
    const { deps, state } = makeDeps(echo);
    const events = await collect(spec, "x", deps);

    expect(events).toContainEqual(
      expect.objectContaining({ kind: "gate_evaluated", stepId: "gate", passed: false }),
    );
    expect(state.runs).toHaveLength(0);
    expect(events.some((e) => e.kind === "phase_start" && e.phaseId === "later")).toBe(false);
    // onFalse: "stop" is a graceful halt — workflow stays ok
    expect(events.at(-1)).toMatchObject({ kind: "workflow_done", ok: true });
  });

  it("aborts mid-run without hanging and does not start later phases", async () => {
    const { deps } = makeDeps(echo, { maxConcurrency: 2, delayMs: 30 });
    const ac = new AbortController();
    const events: WorkflowEvent[] = [];
    for await (const ev of runWorkflow(twoPhase, { input: "x" }, deps, ac.signal)) {
      events.push(ev);
      if (ev.kind === "step_start") ac.abort(); // cancel as soon as work begins
    }

    expect(events.some((e) => e.kind === "step_start" && e.stepId === "d")).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: "workflow_done", ok: false });
  });

  it("rejects an invalid workflow before running anything", async () => {
    const bad: WorkflowSpec = {
      name: "bad",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "a", agent: "claude", model: "m", prompt: "x", dependsOn: ["ghost"] }],
        },
      ],
    };
    const { deps } = makeDeps(echo);
    await expect(collect(bad, "x", deps)).rejects.toThrow(/unknown step/);
  });

  it("passes {{inputs.*}} values to step prompts", async () => {
    const spec: WorkflowSpec = {
      name: "with-inputs",
      inputs: { repo: { type: "string" } },
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "a", agent: "claude", model: "m", prompt: "work on {{inputs.repo}}" }],
        },
      ],
    };
    const { deps, state } = makeDeps(echo);
    const events: WorkflowEvent[] = [];
    for await (const ev of runWorkflow(
      spec,
      { input: "task", inputs: { repo: "my-repo" } },
      deps,
    )) {
      events.push(ev);
    }
    expect(state.runs[0]?.opts.prompt).toBe("work on my-repo");
    expect(events.at(-1)).toMatchObject({ kind: "workflow_done", ok: true });
  });

  it("passes numeric and boolean inputs to step prompts", async () => {
    const spec: WorkflowSpec = {
      name: "typed-inputs",
      inputs: { count: { type: "number" }, verbose: { type: "boolean" } },
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "a",
              agent: "claude",
              model: "m",
              prompt: "count={{inputs.count}} verbose={{inputs.verbose}}",
            },
          ],
        },
      ],
    };
    const { deps, state } = makeDeps(echo);
    const events: WorkflowEvent[] = [];
    for await (const ev of runWorkflow(
      spec,
      { input: "task", inputs: { count: 5, verbose: true } },
      deps,
    )) {
      events.push(ev);
    }
    expect(state.runs[0]?.opts.prompt).toBe("count=5 verbose=true");
    expect(events.at(-1)).toMatchObject({ kind: "workflow_done", ok: true });
  });
});

function lastIndex(events: WorkflowEvent[], pred: (e: WorkflowEvent) => boolean): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i] && pred(events[i] as WorkflowEvent)) return i;
  }
  return -1;
}
