import { describe, expect, it } from "vitest";
import { initialWorkflowState, workflowReducer } from "../src/tui/workflow-state";
import { workflowStateFromSpec } from "../src/workflow";
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

  it("verifies render classification and loop markers in seeded loop state", () => {
    const spec = {
      name: "w",
      phases: [
        {
          id: "fix",
          title: "fix",
          steps: [
            { id: "fix-step", agent: "claude" as const, model: "m", prompt: "p" },
            {
              id: "g",
              kind: "gate" as const,
              loopTo: "fix",
              maxIterations: 5,
              condition: { step: "fix-step", contains: "x" },
            },
          ],
        },
      ],
    };

    // Seed the state from the spec (mimicking web UI workflow selection)
    let state = workflowStateFromSpec(spec);

    // The seeded state should have 1 phase with iteration 1, containing the 2 steps in pending status
    expect(state.phases.length).toBe(1);
    expect(state.phases[0]?.iteration).toBe(1);
    expect(state.phases[0]?.steps[0]?.status).toBe("pending");
    expect(state.phases[0]?.steps[1]?.status).toBe("pending");

    // Process the loop event stream
    for (const e of events) {
      state = workflowReducer(state, { type: "event", event: e });
    }

    // After running the events, we should have two instances of the 'fix' phase (iter 1 and iter 2)
    const fixPhases = state.phases.filter((p) => p.phaseId === "fix");
    expect(fixPhases.length).toBe(2);

    // The agent/model from the seeded spec should not have been clobbered by step_start events that omit them
    expect(fixPhases[0]?.steps[0]?.agent).toBe("claude");

    // The first iteration is superseded, the second is latest
    const maxIter = 2;
    const isLatest1 = (fixPhases[0]?.iteration ?? 1) === maxIter;
    const isLatest2 = (fixPhases[1]?.iteration ?? 1) === maxIter;
    expect(isLatest1).toBe(false);
    expect(isLatest2).toBe(true);

    // Loop markers should capture the gatePhaseIteration as 1
    expect(state.loopMarkers?.length).toBe(1);
    expect(state.loopMarkers?.[0]?.gatePhaseIteration).toBe(1);
    expect(state.loopMarkers?.[0]?.gatePhaseId).toBe("fix");
  });
});
