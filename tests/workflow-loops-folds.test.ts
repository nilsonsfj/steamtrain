import { describe, expect, it } from "vitest";
import { initialWorkflowState, workflowReducer } from "../src/tui/workflow-state";
import type { WorkflowEvent } from "../src/workflow/events";
import { RunRecordBuilder } from "../src/workflow/history";

/** Two iterations of a single phase "fix" with step "fix-step". */
const events: WorkflowEvent[] = [
  { kind: "workflow_start", name: "w", phaseCount: 1, stepCount: 1, ts: 0 },
  {
    kind: "phase_start",
    phaseId: "fix",
    title: "fix",
    index: 0,
    stepCount: 1,
    iteration: 1,
    ts: 0,
  },
  { kind: "step_start", phaseId: "fix", stepId: "fix-step", iteration: 1, ts: 0 },
  {
    kind: "step_done",
    phaseId: "fix",
    stepId: "fix-step",
    iteration: 1,
    cached: false,
    result: { stepId: "fix-step", ok: true, output: "v1", durationMs: 1 },
    ts: 0,
  },
  { kind: "phase_done", phaseId: "fix", ok: true, iteration: 1, ts: 0 },
  { kind: "loop_iteration", gateStepId: "g", loopTo: "fix", iteration: 2, maxIterations: 5, ts: 0 },
  {
    kind: "phase_start",
    phaseId: "fix",
    title: "fix",
    index: 0,
    stepCount: 1,
    iteration: 2,
    ts: 0,
  },
  { kind: "step_start", phaseId: "fix", stepId: "fix-step", iteration: 2, ts: 0 },
  {
    kind: "step_done",
    phaseId: "fix",
    stepId: "fix-step",
    iteration: 2,
    cached: false,
    result: { stepId: "fix-step", ok: true, output: "v2", durationMs: 1 },
    ts: 0,
  },
  { kind: "phase_done", phaseId: "fix", ok: true, iteration: 2, ts: 0 },
  { kind: "workflow_done", ok: true, results: [], ts: 0 },
];

describe("loop folds", () => {
  it("reducer creates one phase instance per iteration", () => {
    let state = initialWorkflowState;
    for (const e of events) state = workflowReducer(state, { type: "event", event: e });
    const fixPhases = state.phases.filter((p) => p.phaseId === "fix");
    expect(fixPhases.length).toBe(2);
    expect(fixPhases[0]?.steps[0]?.result?.output).toBe("v1");
    expect(fixPhases[1]?.steps[0]?.result?.output).toBe("v2");
  });

  it("history builder creates one phase instance per iteration", () => {
    const b = new RunRecordBuilder({ id: "r", workflow: "w", input: "", cwd: "/tmp" });
    for (const e of events) b.handle(e);
    const rec = b.build({ status: "done" });
    const fixPhases = rec.phases.filter((p) => p.phaseId === "fix");
    expect(fixPhases.length).toBe(2);
    expect(fixPhases[1]?.steps[0]?.result?.output).toBe("v2");
  });
});
