import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunOptions } from "../src/agents";
import { initialWorkflowState, workflowReducer } from "../src/tui/workflow-state";
import type { AgentEvent, AgentId } from "../src/types/events";
import { runWorkflow } from "../src/workflow/engine";
import type { WorkflowEvent } from "../src/workflow/events";
import { RUN_RECORD_VERSION, RunRecordBuilder } from "../src/workflow/history";
import { createWorkflowHistoryStore } from "../src/workflow/history-store";
import type { StepResult, WorkflowSpec } from "../src/workflow/types";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "steamtrain-history-"));
}

const fanOutSpec: WorkflowSpec = {
  name: "fan-out",
  phases: [
    { id: "p1", title: "Split", steps: [{ id: "split", kind: "distributor", items: ["a", "b"] }] },
    {
      id: "p2",
      title: "Work",
      steps: [
        {
          id: "work",
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

function fakeAdapter(id: AgentId): AgentAdapter {
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
          text: `out:${opts.prompt}`,
          costUsd: 0.01,
        } satisfies AgentEvent;
      })();
    },
  };
}

async function recordRun(spec: WorkflowSpec, input: string, cwd: string) {
  const builder = new RunRecordBuilder({ id: "run-1", workflow: spec.name, input, cwd });
  let ok = true;
  for await (const event of runWorkflow(
    spec,
    { input },
    { createAdapter: fakeAdapter, maxConcurrency: 2, cwd },
  )) {
    builder.handle(event as WorkflowEvent);
    if (event.kind === "workflow_done") ok = event.ok;
  }
  return builder.build({ status: ok ? "done" : "error" });
}

describe("RunRecordBuilder", () => {
  it("folds a run into a phase -> step tree with totals", async () => {
    const cwd = tempDir();
    const record = await recordRun(fanOutSpec, "go", cwd);

    expect(record.version).toBe(RUN_RECORD_VERSION);
    expect(record.workflow).toBe("fan-out");
    expect(record.status).toBe("done");
    expect(record.ok).toBe(true);
    expect(record.phases).toHaveLength(2);

    const work = record.phases[1]!;
    // distributor parent's two children are recorded as their own steps.
    const childIds = work.steps.map((s) => s.stepId);
    expect(childIds).toContain("work[0]");
    expect(childIds).toContain("work[1]");

    // The fan-out parent is excluded from totals (children counted instead).
    expect(record.totals.steps).toBe(3); // split + work[0] + work[1]
    expect(record.totals.ok).toBe(3);
    expect(record.totals.failed).toBe(0);
    expect(record.totals.costUsd).toBeCloseTo(0.02);
  });

  it("flattens a sub-workflow step's child run under a namespaced id without double-counting cost", async () => {
    const cwd = tempDir();
    const childSpec: WorkflowSpec = {
      name: "child",
      phases: [
        { id: "only", title: "Only", steps: [{ id: "greet", agent: "claude", model: "m", prompt: "hi" }] },
      ],
    };
    const parentSpec: WorkflowSpec = {
      name: "parent",
      phases: [
        { id: "p1", title: "P1", steps: [{ id: "call", kind: "workflow", workflow: "child" } as never] },
      ],
    };
    const builder = new RunRecordBuilder({ id: "run-2", workflow: parentSpec.name, input: "go", cwd });
    let ok = true;
    for await (const event of runWorkflow(
      parentSpec,
      { input: "go" },
      { createAdapter: fakeAdapter, maxConcurrency: 2, cwd, resolveWorkflow: () => childSpec },
    )) {
      builder.handle(event as WorkflowEvent);
      if (event.kind === "workflow_done") ok = event.ok;
    }
    const record = builder.build({ status: ok ? "done" : "error" });

    expect(record.ok).toBe(true);
    // The child's phase is its own HistoryPhase, namespaced.
    const childPhase = record.phases.find((p) => p.phaseId === "call::only");
    expect(childPhase).toBeDefined();
    expect(childPhase?.steps.map((s) => s.stepId)).toContain("call::greet");
    // The workflow step itself is excluded from totals (its childResults are
    // counted instead) — same rule that already applies to forEach parents.
    expect(record.totals.steps).toBe(1); // only call::greet
    expect(record.totals.costUsd).toBeCloseTo(0.01);
  });

  it("captures step output and error status on failure", async () => {
    const cwd = tempDir();
    const failingAdapter = (id: AgentId): AgentAdapter => ({
      id,
      binary: "fake",
      run() {
        return (async function* () {
          yield { kind: "error", agent: id, ts: 0, message: "boom" } satisfies AgentEvent;
        })();
      },
    });
    const spec: WorkflowSpec = {
      name: "single",
      // This test asserts failure capture, not retry; keep "a" to one attempt.
      retry: { maxAttempts: 1 },
      phases: [
        { id: "p1", title: "One", steps: [{ id: "a", agent: "claude", model: "m", prompt: "x" }] },
      ],
    };
    const builder = new RunRecordBuilder({ id: "r", workflow: "single", input: "i", cwd });
    let ok = true;
    for await (const event of runWorkflow(
      spec,
      { input: "i" },
      { createAdapter: failingAdapter, maxConcurrency: 1, cwd },
    )) {
      builder.handle(event as WorkflowEvent);
      if (event.kind === "workflow_done") ok = event.ok;
    }
    const record = builder.build({ status: ok ? "done" : "error" });

    expect(record.status).toBe("error");
    expect(record.ok).toBe(false);
    const step = record.phases[0]!.steps[0]!;
    expect(step.status).toBe("error");
    expect(step.text).toContain("boom");
  });

  it("reconciles an in-flight step and finalizes the phase when canceled mid-flight", () => {
    const builder = new RunRecordBuilder({ id: "r", workflow: "wf", input: "i", cwd: tmpdir() });
    builder.handle({ kind: "workflow_start", name: "wf", phaseCount: 1, stepCount: 1, ts: 1 });
    builder.handle({
      kind: "phase_start",
      phaseId: "p1",
      title: "One",
      index: 0,
      stepCount: 1,
      ts: 2,
    });
    builder.handle({
      kind: "step_start",
      phaseId: "p1",
      stepId: "a",
      blockKind: "worker",
      ts: 3,
    });
    const record = builder.build({ status: "canceled" });
    expect(record.status).toBe("canceled");
    expect(record.ok).toBe(false);
    // The in-flight step is recorded as a (failed) terminal state, never left
    // "running", so the history viewer can't render a spinning step in a
    // finished run.
    const phase = record.phases[0]!;
    expect(phase.steps[0]!.status).toBe("error");
    expect(phase.done).toBe(true);
    expect(phase.ok).toBe(false);
  });

  it("records scheduled-but-unstarted steps as not-run placeholders", () => {
    const builder = new RunRecordBuilder({ id: "r", workflow: "wf", input: "i", cwd: tmpdir() });
    builder.handle({ kind: "workflow_start", name: "wf", phaseCount: 1, stepCount: 3, ts: 1 });
    builder.handle({
      kind: "phase_start",
      phaseId: "p1",
      title: "One",
      index: 0,
      stepCount: 3,
      ts: 2,
    });
    builder.handle({ kind: "step_start", phaseId: "p1", stepId: "a", blockKind: "worker", ts: 3 });
    builder.handle({
      kind: "step_done",
      phaseId: "p1",
      stepId: "a",
      result: { stepId: "a", ok: true, output: "done a", durationMs: 1 },
      cached: false,
      ts: 4,
    });
    const record = builder.build({ status: "canceled" });
    const phase = record.phases[0]!;
    // The phase claimed 3 static steps; only one dispatched, so the other two
    // appear as pending placeholders rather than silently vanishing. (Fan-out
    // children are covered too — see the next test.)
    expect(phase.steps).toHaveLength(3);
    expect(phase.steps.filter((s) => s.status === "pending")).toHaveLength(2);
    // Placeholders never executed, so they don't inflate the executed totals.
    expect(record.totals.steps).toBe(1);
    expect(record.totals.ok).toBe(1);
  });

  it("records unstarted fan-out children as not-run placeholders", () => {
    const builder = new RunRecordBuilder({ id: "r", workflow: "wf", input: "i", cwd: tmpdir() });
    builder.handle({ kind: "workflow_start", name: "wf", phaseCount: 1, stepCount: 1, ts: 1 });
    builder.handle({
      kind: "phase_start",
      phaseId: "p1",
      title: "Work",
      index: 0,
      stepCount: 1,
      ts: 2,
    });
    // The fan-out parent starts, resolves to 3 items, but only one child runs
    // before the run is canceled.
    builder.handle({
      kind: "step_start",
      phaseId: "p1",
      stepId: "work",
      blockKind: "worker",
      ts: 3,
    });
    builder.handle({ kind: "fan_out", phaseId: "p1", parentStepId: "work", count: 3, ts: 4 });
    builder.handle({
      kind: "step_start",
      phaseId: "p1",
      stepId: "work[0]",
      blockKind: "worker",
      parentStepId: "work",
      item: { sourceStepId: "split", index: 0, value: "a" },
      ts: 5,
    });
    const child: StepResult = {
      stepId: "work[0]",
      parentStepId: "work",
      ok: true,
      output: "did a",
      durationMs: 1,
    };
    builder.handle({
      kind: "step_done",
      phaseId: "p1",
      stepId: "work[0]",
      result: child,
      cached: false,
      ts: 6,
    });
    builder.handle({
      kind: "step_done",
      phaseId: "p1",
      stepId: "work",
      result: { stepId: "work", ok: false, output: "", durationMs: 1, childResults: [child] },
      cached: false,
      ts: 7,
    });
    const record = builder.build({ status: "canceled" });

    const phase = record.phases[0]!;
    // parent + 1 started child + 2 placeholders for the children that never ran.
    expect(phase.steps).toHaveLength(4);
    expect(phase.steps.filter((s) => s.status === "pending")).toHaveLength(2);
    // Only the one child that actually executed counts toward totals (the parent
    // is summarized by its children; placeholders never ran).
    expect(record.totals.steps).toBe(1);
    expect(record.totals.ok).toBe(1);
  });

  it("builds a tree that matches the live reducer for the same events", async () => {
    const cwd = tempDir();
    const events: WorkflowEvent[] = [];
    const builder = new RunRecordBuilder({ id: "r", workflow: fanOutSpec.name, input: "go", cwd });
    for await (const event of runWorkflow(
      fanOutSpec,
      { input: "go" },
      { createAdapter: fakeAdapter, maxConcurrency: 2, cwd },
    )) {
      events.push(event as WorkflowEvent);
      builder.handle(event as WorkflowEvent);
    }
    const record = builder.build({ status: "done" });
    const state = events.reduce(
      (s, event) => workflowReducer(s, { type: "event", event }),
      initialWorkflowState,
    );

    // The recorded tree and the live render tree must stay in lockstep: a future
    // change to one fold that isn't mirrored in the other fails here.
    const project = (
      phases: {
        phaseId: string;
        title: string;
        stepCount: number;
        steps: { stepId: string; blockKind: string; status: string; text: string }[];
      }[],
    ) =>
      phases.map((p) => ({
        phaseId: p.phaseId,
        title: p.title,
        stepCount: p.stepCount,
        steps: p.steps.map((s) => ({
          stepId: s.stepId,
          blockKind: s.blockKind,
          status: s.status,
          text: s.text,
        })),
      }));
    expect(project(record.phases)).toEqual(project(state.phases));
  });
});

describe("workflow history store", () => {
  it("round-trips records and lists newest first", async () => {
    const root = tempDir();
    const store = createWorkflowHistoryStore(root);
    const cwd = tempDir();

    const first = await recordRun(fanOutSpec, "first", cwd);
    first.id = "a";
    first.startedAt = 1000;
    const second = await recordRun(fanOutSpec, "second", cwd);
    second.id = "b";
    second.startedAt = 2000;

    await store.save(first);
    await store.save(second);

    const list = await store.list();
    expect(list.map((s) => s.id)).toEqual(["b", "a"]);
    expect(list[0]).not.toHaveProperty("phases");

    const full = await store.get("a");
    expect(full?.phases).toHaveLength(2);
    expect(await store.get("missing")).toBeUndefined();
  });

  it("records and round-trips per-step retry attempts", async () => {
    const root = tempDir();
    const store = createWorkflowHistoryStore(root);
    const builder = new RunRecordBuilder({ id: "ret", workflow: "wf", input: "i", cwd: tmpdir() });
    const ts = Date.now();
    builder.handle({ kind: "workflow_start", name: "wf", phaseCount: 1, stepCount: 1, ts });
    builder.handle({ kind: "phase_start", phaseId: "p1", title: "P1", index: 0, stepCount: 1, ts });
    builder.handle({
      kind: "step_start",
      phaseId: "p1",
      stepId: "a",
      blockKind: "worker",
      ts,
    });
    builder.handle({
      kind: "step_retry",
      phaseId: "p1",
      stepId: "a",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1,
      reason: "transient",
      ts,
    });
    builder.handle({
      kind: "step_done",
      phaseId: "p1",
      stepId: "a",
      cached: false,
      result: { stepId: "a", ok: true, output: "ok", durationMs: 1, attempts: 3 },
      ts,
    });
    builder.handle({ kind: "phase_done", phaseId: "p1", ok: true, ts });
    builder.handle({ kind: "workflow_done", ok: true, results: [], ts });

    await store.save(builder.build({ status: "done" }));
    const full = await store.get("ret");
    expect(full?.phases[0]?.steps[0]?.attempts).toBe(3);
  });

  it("prunes to the retention limit", async () => {
    const root = tempDir();
    const store = createWorkflowHistoryStore(root, 2);
    const cwd = tempDir();
    for (let i = 0; i < 5; i++) {
      const record = await recordRun(fanOutSpec, `run-${i}`, cwd);
      record.id = `id-${i}`;
      record.startedAt = i;
      await store.save(record);
    }
    const list = await store.list();
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.id)).toEqual(["id-4", "id-3"]);
  });

  it("ignores corrupt and wrong-version files", async () => {
    const root = tempDir();
    const store = createWorkflowHistoryStore(root);
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "bad.json"), "{ not json", "utf8");
    await writeFile(join(root, "old.json"), JSON.stringify({ version: 0, id: "old" }), "utf8");
    expect(await store.list()).toEqual([]);
  });

  it("removes one record and clears all", async () => {
    const root = tempDir();
    const store = createWorkflowHistoryStore(root);
    const cwd = tempDir();
    const a = await recordRun(fanOutSpec, "a", cwd);
    a.id = "a";
    const b = await recordRun(fanOutSpec, "b", cwd);
    b.id = "b";
    await store.save(a);
    await store.save(b);

    await store.remove("a");
    expect((await store.list()).map((s) => s.id)).toEqual(["b"]);

    await store.clearAll();
    expect(await store.list()).toEqual([]);
  });

  it("records and round-trips an optional specHash", async () => {
    const builder = new RunRecordBuilder({
      id: "r-spec",
      workflow: "demo",
      input: "hi",
      cwd: tmpdir(),
      specHash: "abc123",
    });
    builder.handle({ kind: "workflow_start", name: "demo", phaseCount: 0, stepCount: 0, ts: 1 });
    builder.handle({ kind: "workflow_done", ok: true, results: [], ts: 2 });
    const record = builder.build({ status: "done" });
    expect(record.specHash).toBe("abc123");

    const store = createWorkflowHistoryStore(tempDir());
    await store.save(record);
    const loaded = await store.get("r-spec");
    expect(loaded?.specHash).toBe("abc123");
  });
});
