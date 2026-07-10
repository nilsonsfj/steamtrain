import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunOptions } from "../src/agents";
import type { AgentEvent, AgentId } from "../src/types/events";
import {
  type StepResult,
  type WorkflowDeps,
  type WorkflowEvent,
  type WorkflowSpec,
  runWorkflow,
} from "../src/workflow";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "steamtrain-workflow-step-test-"));
  tempRoots.push(dir);
  return dir;
}

function fakeAdapter(
  id: AgentId,
  textOf: (opts: AgentRunOptions) => string = (o) => `out:${o.prompt}`,
): AgentAdapter {
  return {
    id,
    binary: "fake",
    defaultModel: "test",
    run(opts: AgentRunOptions) {
      return (async function* () {
        yield {
          kind: "result",
          agent: id,
          ts: 0,
          isError: false,
          text: textOf(opts),
          costUsd: 0.01,
        } satisfies AgentEvent;
      })();
    },
  };
}

function deps(cwd: string, over: Partial<WorkflowDeps> = {}): WorkflowDeps {
  return {
    createAdapter: (() => fakeAdapter("claude" as AgentId)) as WorkflowDeps["createAdapter"],
    maxConcurrency: 4,
    cwd,
    ...over,
  };
}

async function runToEvents(
  spec: WorkflowSpec,
  d: WorkflowDeps,
  input = "task",
): Promise<WorkflowEvent[]> {
  const events: WorkflowEvent[] = [];
  for await (const ev of runWorkflow(spec, { input }, d)) events.push(ev);
  return events;
}

function doneResults(events: WorkflowEvent[]): Map<string, StepResult> {
  const map = new Map<string, StepResult>();
  for (const ev of events) if (ev.kind === "step_done") map.set(ev.stepId, ev.result);
  return map;
}

function workflowOk(events: WorkflowEvent[]): boolean {
  const done = events.find((ev) => ev.kind === "workflow_done");
  return done?.kind === "workflow_done" ? done.ok : false;
}

const childSpec: WorkflowSpec = {
  name: "child",
  phases: [
    {
      id: "only",
      title: "Only",
      steps: [{ id: "greet", agent: "claude", model: "m", prompt: "hi {{input}}" }],
    },
  ],
};

const parentSpec: WorkflowSpec = {
  name: "parent",
  phases: [
    {
      id: "p1",
      title: "P1",
      steps: [{ id: "call", kind: "workflow", workflow: "child", input: "{{input}}-sub" }],
    },
  ],
};

describe("workflow (sub-workflow) step", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("invokes the child workflow, flattens its steps under a namespaced id, and surfaces the last step's output", async () => {
    const cwd = await tempDir();
    const events = await runToEvents(
      parentSpec,
      deps(cwd, { resolveWorkflow: (name) => (name === "child" ? childSpec : undefined) }),
      "go",
    );
    const results = doneResults(events);
    expect(results.has("call::greet")).toBe(true);
    expect(results.get("call::greet")?.output).toBe("out:hi go-sub");
    expect(results.get("call")?.output).toBe("out:hi go-sub");
    expect(results.get("call")?.ok).toBe(true);
    expect(workflowOk(events)).toBe(true);
  });

  it("namespaces the child's step_workspace events like other step events", async () => {
    const cwd = await tempDir();
    const events = await runToEvents(
      parentSpec,
      deps(cwd, {
        resolveWorkflow: (name) => (name === "child" ? childSpec : undefined),
        agentWorkspace: {
          async allocate(request) {
            return {
              cwd: `/isolated/${request.stepId}`,
              root: `/isolated/${request.stepId}`,
              branch: `steamtrain/test/${request.stepId}`,
              dispose: () => {},
            };
          },
        },
      }),
    );
    const ws = events.filter((ev) => ev.kind === "step_workspace");
    // Exactly one workspace announcement bubbles up for the child's agent
    // step, carrying namespaced ids so it matches the surfaced tree.
    expect(ws).toHaveLength(1);
    expect(ws[0]?.kind === "step_workspace" && ws[0].stepId).toBe("call::greet");
    expect(ws[0]?.kind === "step_workspace" && ws[0].phaseId).toBe("call::only");
    expect(ws[0]?.kind === "step_workspace" && ws[0].worktree?.branch).toBe(
      "steamtrain/test/greet",
    );
  });

  it("rolls up the child's leaf cost onto the parent run without double-counting the workflow step itself", async () => {
    const cwd = await tempDir();
    const events = await runToEvents(
      parentSpec,
      deps(cwd, { resolveWorkflow: (name) => (name === "child" ? childSpec : undefined) }),
    );
    const results = doneResults(events);
    expect(results.get("call")?.costUsd).toBeUndefined();
    expect(results.get("call::greet")?.costUsd).toBeCloseTo(0.01);
    expect(results.get("call")?.childResults?.length).toBe(1);
  });

  it("uses an explicit outputStep instead of the child's last step", async () => {
    const cwd = await tempDir();
    const twoStepChild: WorkflowSpec = {
      name: "child2",
      phases: [
        {
          id: "one",
          title: "One",
          steps: [{ id: "first", agent: "claude", model: "m", prompt: "first" }],
        },
        {
          id: "two",
          title: "Two",
          steps: [
            { id: "second", dependsOn: ["first"], agent: "claude", model: "m", prompt: "second" },
          ],
        },
      ],
    };
    const spec: WorkflowSpec = {
      name: "parent2",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "call", kind: "workflow", workflow: "child2", outputStep: "first" }],
        },
      ],
    };
    const events = await runToEvents(spec, deps(cwd, { resolveWorkflow: () => twoStepChild }));
    const results = doneResults(events);
    expect(results.get("call")?.output).toBe("out:first");
  });

  it("fails clearly when resolveWorkflow is not configured", async () => {
    const cwd = await tempDir();
    const events = await runToEvents(parentSpec, deps(cwd));
    const results = doneResults(events);
    expect(results.get("call")?.ok).toBe(false);
    expect(results.get("call")?.error).toContain("not supported in this context");
    expect(workflowOk(events)).toBe(false);
  });

  it("fails clearly on an unknown workflow name", async () => {
    const cwd = await tempDir();
    const events = await runToEvents(parentSpec, deps(cwd, { resolveWorkflow: () => undefined }));
    const results = doneResults(events);
    expect(results.get("call")?.ok).toBe(false);
    expect(results.get("call")?.error).toContain("unknown workflow 'child'");
  });

  it("rejects a direct self-cycle", async () => {
    const cwd = await tempDir();
    const selfSpec: WorkflowSpec = {
      name: "loopy",
      phases: [
        { id: "p1", title: "P1", steps: [{ id: "call", kind: "workflow", workflow: "loopy" }] },
      ],
    };
    const events = await runToEvents(selfSpec, deps(cwd, { resolveWorkflow: () => selfSpec }));
    const results = doneResults(events);
    expect(results.get("call")?.ok).toBe(false);
    expect(results.get("call")?.error).toContain("cycle");
  });

  it("rejects an indirect A->B->A cycle", async () => {
    const cwd = await tempDir();
    const specA: WorkflowSpec = {
      name: "a",
      phases: [
        { id: "p1", title: "P1", steps: [{ id: "callB", kind: "workflow", workflow: "b" }] },
      ],
    };
    const specB: WorkflowSpec = {
      name: "b",
      phases: [
        { id: "p1", title: "P1", steps: [{ id: "callA", kind: "workflow", workflow: "a" }] },
      ],
    };
    const catalog: Record<string, WorkflowSpec> = { a: specA, b: specB };
    const events = await runToEvents(
      specA,
      deps(cwd, { resolveWorkflow: (name) => catalog[name] }),
    );
    const results = doneResults(events);
    expect(results.get("callB")?.ok).toBe(false);
    // callB's own child run (b) fails at its "callA" step; that failure
    // bubbles up as callB's own not-ok result.
    expect(results.get("callB")?.error).toBeDefined();
    expect(workflowOk(events)).toBe(false);
  });

  it("enforces the nesting depth cap", async () => {
    const cwd = await tempDir();
    // Six levels deep (0..5), one more than MAX_WORKFLOW_NESTING_DEPTH (5).
    const catalog: Record<string, WorkflowSpec> = {};
    for (let i = 0; i < 6; i++) {
      catalog[`level${i}`] = {
        name: `level${i}`,
        phases: [
          {
            id: "p1",
            title: "P1",
            steps:
              i < 5
                ? [{ id: "next", kind: "workflow", workflow: `level${i + 1}` }]
                : [{ id: "leaf", agent: "claude", model: "m", prompt: "leaf" }],
          },
        ],
      };
    }
    const events = await runToEvents(
      catalog.level0 as WorkflowSpec,
      deps(cwd, { resolveWorkflow: (name) => catalog[name] }),
    );
    expect(workflowOk(events)).toBe(false);
  });

  it("supports >=2-level nesting: doubly-namespaced ids, output propagation, and cost rollup with no double-counting", async () => {
    const cwd = await tempDir();
    const childSpec3: WorkflowSpec = {
      name: "child",
      phases: [
        {
          id: "only",
          title: "Only",
          steps: [{ id: "leaf", agent: "claude", model: "m", prompt: "leaf {{input}}" }],
        },
      ],
    };
    const parentSpec3: WorkflowSpec = {
      name: "parent",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "inner", kind: "workflow", workflow: "child" }],
        },
      ],
    };
    const grandparentSpec: WorkflowSpec = {
      name: "grandparent",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "outer", kind: "workflow", workflow: "parent" }],
        },
      ],
    };
    const catalog: Record<string, WorkflowSpec> = { parent: parentSpec3, child: childSpec3 };
    const events = await runToEvents(
      grandparentSpec,
      deps(cwd, { resolveWorkflow: (name) => catalog[name] }),
      "go",
    );
    const results = doneResults(events);

    // Doubly-namespaced leaf id, reached through both levels of nesting.
    expect(results.has("outer::inner::leaf")).toBe(true);
    expect(results.get("outer::inner::leaf")?.output).toBe("out:leaf go");

    // Default outputStep propagates through both levels: outer's output is
    // inner's output, which is inner's own leaf's output. Note "inner" alone
    // (unnamespaced) never appears as a top-level key — every event bubbling
    // through "outer" is namespaced by outer's own namespace fn first.
    expect(results.get("outer")?.output).toBe("out:leaf go");
    expect(results.has("inner")).toBe(false);
    expect(results.has("outer::inner")).toBe(true);
    expect(workflowOk(events)).toBe(true);

    // Cost rollup: the leaf's cost should surface exactly once at the
    // top-level flattened view, on "outer::inner::leaf", while both wrapping
    // "workflow" steps ("outer" and "outer::inner") are left costUsd-
    // undefined so summation never double-counts. This directly exercises
    // the same childResults-flattening invariant `computeRunTotals`
    // (tests/workflow-history.test.ts) relies on — it sums costUsd across
    // the flat step_done event stream and only the true leaf carries a cost
    // — without needing to import history.ts. This is consistent with how
    // this file's other cost-rollup test ("rolls up the child's leaf
    // cost...") already asserts directly on StepResult/childResults from
    // runWorkflow's own event stream, so we follow the same convention here.
    expect(results.get("outer")?.costUsd).toBeUndefined();
    expect(results.get("outer::inner")?.costUsd).toBeUndefined();
    expect(results.get("outer::inner::leaf")?.costUsd).toBeCloseTo(0.01);

    // outer's own childResults carries both the flattened leaf view AND the
    // nested "outer::inner" wrapper (which itself still carries a further-
    // nested, once-namespaced-relative-to-itself "inner::leaf" child) — this
    // is the intentional raw/nested-id shape documented at the `step_done`
    // spread site in engine.ts; only the flat top-level events (asserted
    // above) matter for cost summation.
    const outerResult = results.get("outer");
    expect(outerResult?.childResults?.length).toBe(2);
    const nestedInner = outerResult?.childResults?.find((r) => r.stepId === "outer::inner");
    expect(nestedInner?.costUsd).toBeUndefined();
    expect(nestedInner?.childResults?.[0]?.stepId).toBe("inner::leaf");
    expect(nestedInner?.childResults?.[0]?.costUsd).toBeCloseTo(0.01);
  });

  it("schedules a step referencing a namespaced child output strictly after the workflow step settles", async () => {
    const cwd = await tempDir();
    const spec: WorkflowSpec = {
      name: "parent3",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "call", kind: "workflow", workflow: "child" }],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            {
              id: "downstream",
              kind: "command",
              // Explicit (empty) dependsOn suppresses the barrier-default
              // "depend on every earlier-phase step" rule, which would
              // otherwise mask the bug this test targets (call is in an
              // earlier phase either way). With dependsOn: [] the ONLY way
              // "call" can end up a recognized dependency is via the
              // template-ref scan resolving the "call::greet" ref down to
              // its owning "call" step.
              dependsOn: [],
              cmd: "echo got:{{steps.call::greet.output}}",
            },
          ],
        },
      ],
    };
    const events = await runToEvents(spec, deps(cwd, { resolveWorkflow: () => childSpec }));
    const callDoneIndex = events.findIndex((ev) => ev.kind === "step_done" && ev.stepId === "call");
    const downstreamStartIndex = events.findIndex(
      (ev) => ev.kind === "step_start" && ev.stepId === "downstream",
    );
    expect(callDoneIndex).toBeGreaterThanOrEqual(0);
    expect(downstreamStartIndex).toBeGreaterThan(callDoneIndex);
    const results = doneResults(events);
    expect(results.get("downstream")?.output).toContain("got:out:hi task");
    expect(workflowOk(events)).toBe(true);
  });

  it("derives an implicit dependency from a {{steps.*}} ref in the workflow step's input template", async () => {
    const cwd = await tempDir();
    const spec: WorkflowSpec = {
      name: "parent4",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "up", agent: "claude", model: "m", prompt: "seed" }],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            {
              id: "call",
              kind: "workflow",
              workflow: "child",
              // dependsOn: [] suppresses the barrier-default rule, so the only
              // way "up" becomes a recognized dependency is via the template
              // scan of the workflow step's `input`.
              dependsOn: [],
              input: "{{steps.up.output}}-extra",
            },
          ],
        },
      ],
    };
    const events = await runToEvents(spec, deps(cwd, { resolveWorkflow: () => childSpec }));
    const upDoneIndex = events.findIndex((ev) => ev.kind === "step_done" && ev.stepId === "up");
    const callStartIndex = events.findIndex(
      (ev) => ev.kind === "step_start" && ev.stepId === "call",
    );
    expect(upDoneIndex).toBeGreaterThanOrEqual(0);
    expect(callStartIndex).toBeGreaterThan(upDoneIndex);
    expect(workflowOk(events)).toBe(true);
  });
});
