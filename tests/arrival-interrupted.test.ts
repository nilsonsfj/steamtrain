/**
 * A step the run's cancel took down did not break on its own. The shared
 * report (TUI arrival, web headline, notices) must say "interrupted", and only
 * name it where the run stopped when nothing actually broke.
 */
import { describe, expect, it } from "vitest";
import {
  type StepResult,
  type WorkflowSpec,
  type WorkflowState,
  arrivalRootCause,
  buildArrivalReport,
  formatArrivalHeadline,
  workflowStateFromSpec,
} from "../src/workflow";

const spec: WorkflowSpec = {
  name: "w",
  phases: [
    {
      id: "p",
      title: "Work",
      steps: [
        { id: "a", kind: "command", cmd: "true" },
        { id: "b", kind: "command", cmd: "true" },
      ],
    },
  ],
};

function ended(results: Record<string, Partial<StepResult>>): WorkflowState {
  const base = workflowStateFromSpec(spec);
  return {
    ...base,
    done: true,
    ok: false,
    phases: base.phases.map((phase) => ({
      ...phase,
      steps: phase.steps.map((step) => {
        const r = results[step.stepId];
        const result = { stepId: step.stepId, ok: true, output: "", durationMs: 1, ...r };
        return { ...step, status: result.ok ? "done" : "error", result };
      }),
    })),
  } as WorkflowState;
}

describe("arrival report: interrupted steps", () => {
  it("counts an interrupted step apart from failures, and says where the run stopped", () => {
    const state = ended({
      b: { ok: false, interrupted: true, error: "'claude' exited with code 143" },
    });
    const report = buildArrivalReport(state);
    expect(report?.receipt).toMatchObject({ okCount: 1, failCount: 0, interruptedCount: 1 });
    expect(formatArrivalHeadline(report!.receipt, "w")).toContain("1 interrupted");
    expect(formatArrivalHeadline(report!.receipt, "w")).not.toContain("failed");
    expect(report?.notices).toEqual([
      expect.objectContaining({ stepId: "b", severity: "high", what: "b was interrupted" }),
    ]);
    expect(arrivalRootCause(state)).toMatchObject({ stepId: "b", interrupted: true });
    // Nor does the hero open with a line blaming it.
    expect(report?.hero).not.toContain("✗ b");
  });

  it("still names a step that broke on its own as the root cause", () => {
    const state = ended({
      a: { ok: false, interrupted: true, error: "cancelled" },
      b: { ok: false, error: "command exited with code 1" },
    });
    expect(arrivalRootCause(state)).toMatchObject({ stepId: "b", interrupted: false });
    const hero = buildArrivalReport(state)?.hero ?? "";
    expect(hero).toContain("✗ b: command exited with code 1");
    expect(hero).not.toContain("✗ a");
    expect(buildArrivalReport(state)?.receipt).toMatchObject({ failCount: 1, interruptedCount: 1 });
  });
});
