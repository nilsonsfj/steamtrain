import { describe, expect, it } from "vitest";
import { flattenSteps, initialWorkflowState, workflowReducer } from "../src/tui/workflow-state";
import type { AgentId } from "../src/types/events";
import type { StepResult, WorkflowEvent } from "../src/workflow";

const AGENT: AgentId = "claude";

function reduceAll(events: WorkflowEvent[]) {
  return events.reduce(
    (s, event) => workflowReducer(s, { type: "event", event }),
    initialWorkflowState,
  );
}

const resultA: StepResult = {
  stepId: "a",
  ok: true,
  output: "final A",
  durationMs: 1200,
  costUsd: 0.01,
};

describe("workflowReducer", () => {
  it("builds the phase/step tree from an event sequence and accumulates text", () => {
    const state = reduceAll([
      { kind: "workflow_start", name: "w", phaseCount: 1, stepCount: 1, ts: 0 },
      { kind: "phase_start", phaseId: "p1", title: "Phase 1", index: 0, stepCount: 1, ts: 0 },
      { kind: "step_start", phaseId: "p1", stepId: "a", agent: AGENT, model: "m", ts: 0 },
      {
        kind: "step_event",
        phaseId: "p1",
        stepId: "a",
        event: { kind: "text_delta", agent: AGENT, ts: 0, text: "hel" },
        ts: 0,
      },
      {
        kind: "step_event",
        phaseId: "p1",
        stepId: "a",
        event: { kind: "text_delta", agent: AGENT, ts: 0, text: "lo" },
        ts: 0,
      },
      {
        kind: "step_event",
        phaseId: "p1",
        stepId: "a",
        event: { kind: "text_delta", agent: AGENT, ts: 0, text: "X", thinking: true },
        ts: 0,
      },
      { kind: "step_done", phaseId: "p1", stepId: "a", result: resultA, cached: false, ts: 0 },
      { kind: "phase_done", phaseId: "p1", ok: true, ts: 0 },
      { kind: "workflow_done", ok: true, results: [resultA], ts: 0 },
    ]);

    expect(state.name).toBe("w");
    expect(state.started).toBe(true);
    expect(state.done).toBe(true);
    expect(state.ok).toBe(true);
    expect(state.results).toEqual([resultA]);

    const flat = flattenSteps(state);
    expect(flat).toHaveLength(1);
    const step = flat[0]?.step;
    expect(step?.status).toBe("done");
    expect(step?.text).toBe("hello"); // thinking delta excluded
    expect(step?.result).toEqual(resultA);
    expect(state.phases[0]?.done).toBe(true);
  });

  it("tracks tool activity and marks failed steps", () => {
    const state = reduceAll([
      { kind: "workflow_start", name: "w", phaseCount: 1, stepCount: 1, ts: 0 },
      { kind: "phase_start", phaseId: "p1", title: "P1", index: 0, stepCount: 1, ts: 0 },
      { kind: "step_start", phaseId: "p1", stepId: "a", agent: AGENT, model: "m", ts: 0 },
      {
        kind: "step_event",
        phaseId: "p1",
        stepId: "a",
        event: { kind: "tool_use", agent: AGENT, ts: 0, name: "Bash" },
        ts: 0,
      },
      {
        kind: "step_done",
        phaseId: "p1",
        stepId: "a",
        result: { stepId: "a", ok: false, output: "nope", error: "boom", durationMs: 5 },
        cached: false,
        ts: 0,
      },
      { kind: "workflow_done", ok: false, results: [], ts: 0 },
    ]);

    const step = flattenSteps(state)[0]?.step;
    expect(step?.activity).toBe("⚙ Bash");
    expect(step?.status).toBe("error");
    expect(state.ok).toBe(false);
  });

  it("resets to the initial state", () => {
    const seeded = reduceAll([
      { kind: "workflow_start", name: "w", phaseCount: 0, stepCount: 0, ts: 0 },
    ]);
    expect(seeded.started).toBe(true);
    expect(workflowReducer(seeded, { type: "reset" })).toEqual(initialWorkflowState);
  });
});
