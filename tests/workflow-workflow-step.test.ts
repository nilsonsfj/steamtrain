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

function fakeAdapter(id: AgentId, textOf: (opts: AgentRunOptions) => string = (o) => `out:${o.prompt}`): AgentAdapter {
  return {
    id,
    binary: "fake",
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

async function runToEvents(spec: WorkflowSpec, d: WorkflowDeps, input = "task"): Promise<WorkflowEvent[]> {
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
          steps: [{ id: "second", dependsOn: ["first"], agent: "claude", model: "m", prompt: "second" }],
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
    const events = await runToEvents(
      spec,
      deps(cwd, { resolveWorkflow: () => twoStepChild }),
    );
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
      phases: [{ id: "p1", title: "P1", steps: [{ id: "call", kind: "workflow", workflow: "loopy" }] }],
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
      phases: [{ id: "p1", title: "P1", steps: [{ id: "callB", kind: "workflow", workflow: "b" }] }],
    };
    const specB: WorkflowSpec = {
      name: "b",
      phases: [{ id: "p1", title: "P1", steps: [{ id: "callA", kind: "workflow", workflow: "a" }] }],
    };
    const catalog: Record<string, WorkflowSpec> = { a: specA, b: specB };
    const events = await runToEvents(specA, deps(cwd, { resolveWorkflow: (name) => catalog[name] }));
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
});
