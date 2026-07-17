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

  it("shows a live per-step timer and worktree in the tree view", () => {
    const state = workflowStateWithSteps(5);
    const running = state.phases[0]!.steps[3]!;
    running.startedAt = 1_000;
    running.worktree = {
      originalCwd: "/repo",
      cwd: "/wt/steamtrain/step-3",
      root: "/wt/steamtrain/step-3",
      branch: "steamtrain/run/step-3",
    };
    const { lastFrame } = render(
      <WorkflowView
        state={state}
        width={110}
        height={24}
        selectedIndex={3}
        elapsedMs={9_500}
        now={11_000}
      />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("⏱ 10.0s"); // 11_000 - 1_000 on the running step
    expect(frame).toContain("⎇ step-3"); // worktree dir on the step row
    expect(frame).toContain("steamtrain/run/step-3"); // branch in the detail panel
  });

  it("scrolls the live drill-in output and reports the window position", () => {
    const state = workflowStateWithSteps(1);
    const step = state.phases[0]!.steps[0]!;
    step.status = "running";
    step.startedAt = 0;
    step.result = undefined; // still streaming — no final result yet
    step.text = Array.from({ length: 200 }, (_, i) => `line-${i}`).join("\n");

    const following = render(
      <WorkflowStepDetails
        kind="live"
        state={state}
        entry={{ phase: state.phases[0]!, step }}
        width={100}
        height={24}
        selectedIndex={0}
        totalSteps={1}
        elapsedMs={5_000}
        now={10_000}
        scroll={{ offset: 0, follow: true }}
      />,
    );
    const followFrame = following.lastFrame() ?? "";
    expect(followFrame).toContain("following");
    expect(followFrame).toContain("line-199"); // pinned to the newest output
    expect(followFrame).toContain("/200"); // total line count in the header

    const paused = render(
      <WorkflowStepDetails
        kind="live"
        state={state}
        entry={{ phase: state.phases[0]!, step }}
        width={100}
        height={24}
        selectedIndex={0}
        totalSteps={1}
        elapsedMs={5_000}
        now={10_000}
        scroll={{ offset: 0, follow: false }}
      />,
    );
    const pausedFrame = paused.lastFrame() ?? "";
    expect(pausedFrame).toContain("lines 1–"); // anchored at the top
    expect(pausedFrame).toContain("line-0");
    expect(pausedFrame).not.toContain("line-199");
    expect(pausedFrame).toContain("paused");
  });
  it("shows a segmented progress bar with step tallies", () => {
    const state = workflowStateWithSteps(10);
    const { lastFrame } = render(
      <WorkflowView state={state} width={100} height={20} selectedIndex={0} elapsedMs={2500} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("█"); // done cells
    expect(frame).toContain("░"); // pending cells
    expect(frame).toContain("3/10 steps");
    expect(frame).toContain("1 running");
  });

  it("does not duplicate the block label for non-agent steps", () => {
    const state = workflowStateWithSteps(2);
    const gateStep = state.phases[0]!.steps[1]!;
    gateStep.blockKind = "gate";
    gateStep.agent = undefined;
    gateStep.model = undefined;
    gateStep.status = "done";
    gateStep.gate = { passed: true };
    const { lastFrame } = render(
      <WorkflowView state={state} width={100} height={20} selectedIndex={0} elapsedMs={1000} />,
    );
    expect(lastFrame() ?? "").not.toMatch(/gate\s+gate/);
  });

  it("never overflows its fixed height, even with an approval card open", () => {
    const state = workflowStateWithSteps(12);
    state.pendingApprovals = [
      {
        phaseId: "phase",
        stepId: "step-3",
        iteration: 1,
        message: "review this output carefully ".repeat(20),
        output: Array.from({ length: 40 }, (_, i) => `reviewed line ${i}`).join("\n"),
        onReject: "fail",
      },
    ];
    for (const height of [12, 16, 24, 30]) {
      const { lastFrame } = render(
        <WorkflowView state={state} width={90} height={height} selectedIndex={3} elapsedMs={500} />,
      );
      const lines = (lastFrame() ?? "").split("\n");
      expect(lines.length).toBeLessThanOrEqual(height);
    }
  });

  it("marks earlier iterations of a looped phase as superseded", () => {
    const first = workflowStateWithSteps(2);
    const secondPass = {
      ...first.phases[0]!,
      iteration: 2,
      steps: first.phases[0]!.steps.map((s) => ({ ...s })),
    };
    first.phases[0]!.iteration = 1;
    first.phases = [first.phases[0]!, secondPass];
    const { lastFrame } = render(
      <WorkflowView state={first} width={100} height={24} selectedIndex={0} elapsedMs={1000} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("superseded");
    expect(frame).toContain("iter 1/2");
    expect(frame).toContain("iter 2/2");
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
