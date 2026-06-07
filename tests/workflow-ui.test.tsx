import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { WorkflowStepDetails } from "../src/tui/WorkflowStepDetails";
import { WorkflowView } from "../src/tui/WorkflowView";
import { selectVisibleWindow } from "../src/tui/workflow-list-window";
import type { PhaseState, StepState, WorkflowState } from "../src/tui/workflow-state";
import { BUNDLED_WORKFLOWS } from "../src/workflow";

describe("workflow UI helpers", () => {
  it("keeps the selected row visible within a bounded window", () => {
    const window = selectVisibleWindow(["a", "b", "c", "d", "e", "f"], 4, 4);

    expect(window.visible).toContain("e");
    expect(window.hiddenBefore).toBeGreaterThan(0);
    expect(window.hiddenAfter).toBeGreaterThanOrEqual(0);
    expect(
      window.visible.length + (window.hiddenBefore > 0 ? 1 : 0) + (window.hiddenAfter > 0 ? 1 : 0),
    ).toBeLessThanOrEqual(4);
  });

  it("renders a preview step details screen", () => {
    const spec = BUNDLED_WORKFLOWS["target-sweep"]!;
    const entry = {
      phase: spec.phases[1]!,
      phaseIndex: 1,
      step: spec.phases[1]!.steps[0]!,
      stepIndex: 0,
      flatIndex: 1,
    };
    const { lastFrame } = render(
      <WorkflowStepDetails
        kind="preview"
        spec={spec}
        source="bundled"
        input="improve workflow UI"
        entry={entry}
        width={120}
        height={24}
        selectedIndex={1}
        totalSteps={3}
        dispatchOk
      />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("workflow step · target-sweep");
    expect(frame).toContain("sweep-each");
    expect(frame).toContain("forEach: steps.targets.items");
    expect(frame).toContain("prompt:");
  });

  it("windows the live workflow tree around the selected step", () => {
    const state = workflowStateWithSteps(12);
    const { lastFrame } = render(
      <WorkflowView state={state} width={100} height={12} selectedIndex={10} elapsedMs={2500} />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("workflow · big-run");
    expect(frame).toContain("2.5s");
    expect(frame).toContain("earlier row");
    expect(frame).toContain("step-10");
  });
});

function workflowStateWithSteps(count: number): WorkflowState {
  const steps: StepState[] = Array.from({ length: count }, (_, index) => ({
    stepId: `step-${index}`,
    blockKind: "worker",
    agent: "opencode",
    model: "opencode/qwen3.6-plus-free",
    status: index < 3 ? "done" : index === 3 ? "running" : "pending",
    text: index < 3 ? `output ${index}` : "",
    result:
      index < 3
        ? {
            stepId: `step-${index}`,
            ok: true,
            output: `output ${index}`,
            durationMs: 1000,
          }
        : undefined,
    cached: false,
  }));
  const phase: PhaseState = {
    phaseId: "phase",
    title: "Large Phase",
    index: 0,
    stepCount: count,
    steps,
    done: false,
    ok: true,
  };

  return {
    name: "big-run",
    startedAt: 0,
    phases: [phase],
    results: [],
    started: true,
    done: false,
    ok: true,
  };
}
