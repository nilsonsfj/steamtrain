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

  it("honors the budget even when rows are hidden on both sides of a tiny window", () => {
    const items = Array.from({ length: 41 }, (_, i) => `row-${i}`);
    for (const budget of [1, 2, 3]) {
      const window = selectVisibleWindow(items, 20, budget);
      const markers = (window.hiddenBefore > 0 ? 1 : 0) + (window.hiddenAfter > 0 ? 1 : 0);
      expect(window.visible.length + markers).toBeLessThanOrEqual(budget);
      expect(window.visible).toContain("row-20");
    }
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
    expect(frame).toContain("10.0s"); // 11_000 - 1_000 on the running step
    expect(frame).not.toContain("⏱"); // double-width glyph would wrap the row
    expect(frame).toContain("⎇ step-3"); // worktree dir on the step row
    expect(frame).toContain("steamtrain/run/step-3"); // branch in the detail panel
  });

  it("collapses long pending fan-out runs and keeps the frame within height", () => {
    const parent: StepState = {
      stepId: "babysit",
      blockKind: "distributor",
      status: "done",
      text: "",
      result: { stepId: "babysit", ok: true, output: "ok", durationMs: 100 },
      cached: false,
    };
    const children: StepState[] = Array.from({ length: 29 }, (_, i) => ({
      stepId: `babysit[${i}]`,
      parentStepId: "babysit",
      blockKind: "worker",
      agent: "claude",
      model: "opus",
      status: i < 5 ? "running" : "pending",
      text: i < 5 ? "streaming…" : "",
      startedAt: i < 5 ? 1_000 : undefined,
      activity: i < 5 ? "bash · working" : undefined,
      cached: false,
    }));
    const steps = [parent, ...children];
    const state: WorkflowState = {
      name: "babysit-all-prs",
      startedAt: 0,
      phases: [
        {
          phaseId: "phase",
          title: "Babysit each PR",
          index: 0,
          stepCount: steps.length,
          steps,
          done: false,
          ok: true,
        },
      ],
      results: [],
      started: true,
      done: false,
      ok: true,
    };
    const height = 36;
    const { lastFrame } = render(
      <WorkflowView
        state={state}
        width={120}
        height={height}
        selectedIndex={1}
        elapsedMs={31_800}
        now={32_800}
      />,
    );
    const frame = lastFrame() ?? "";
    const lines = frame.split("\n");
    expect(lines.length).toBeLessThanOrEqual(height);
    expect(frame).toContain("pending");
    // Individual mid-fan-out pending ids should be collapsed away.
    expect(frame).not.toContain("babysit[20]");
    expect(frame).toMatch(/\d+ pending/);
    // Detail panel stays present (not pushed off-screen by the tree).
    expect(frame).toContain("babysit[0]");
    expect(frame).toMatch(/──/);
  });

  it("keeps long fan-out step rows on a single line so borders do not ghost-wrap", () => {
    const parent: StepState = {
      stepId: "babysit",
      blockKind: "distributor",
      status: "done",
      text: "",
      result: { stepId: "babysit", ok: true, output: "listed", durationMs: 22_100 },
      cached: false,
    };
    const children: StepState[] = Array.from({ length: 5 }, (_, i) => ({
      stepId: `babysit[${i}]`,
      parentStepId: "babysit",
      blockKind: "processor",
      agent: "antigravity",
      model: "gemini-3.6-flash-high",
      effort: "high",
      status: "running",
      text: "streaming",
      startedAt: 1_000,
      activity: "bash · reading files and applying review comments",
      cached: false,
      worktree: {
        originalCwd: "/repo",
        cwd: `/var/folders/47/zydwtfn52c3ffpp4l2xl__zm0000gn/T/steamtrain-wt-babysit-${i}`,
        root: "/tmp/wt",
        branch: "claude/hopeful-shannon-lx8lxp",
      },
      item: {
        sourceStepId: "babysit",
        index: i,
        value: `https://github.com/example/repo/pull/${4200 + i}`,
      },
    }));
    const summary: StepState = {
      stepId: "summary",
      blockKind: "consolidator",
      agent: "antigravity",
      model: "gemini-3.6-flash-high",
      status: "pending",
      text: "",
      cached: false,
    };
    const state: WorkflowState = {
      name: "babysit-all-prs",
      startedAt: 0,
      phases: [
        {
          phaseId: "babysit-phase",
          title: "Babysit each PR",
          index: 0,
          stepCount: 1 + children.length,
          steps: [parent, ...children],
          done: false,
          ok: true,
        },
        {
          phaseId: "summary-phase",
          title: "Summary",
          index: 1,
          stepCount: 1,
          steps: [summary],
          done: false,
          ok: true,
        },
      ],
      results: [],
      started: true,
      done: false,
      ok: true,
    };
    const width = 100;
    const height = 28;
    const { lastFrame } = render(
      <WorkflowView
        state={state}
        width={width}
        height={height}
        selectedIndex={1}
        elapsedMs={68_000}
        now={45_800}
      />,
    );
    const frame = lastFrame() ?? "";
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
    const lines = frame.split("\n").map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
    expect(lines.length).toBeLessThanOrEqual(height);
    // Header stays visible (overflow wraps used to push it off-screen).
    expect(frame).toContain("workflow · babysit-all-prs");
    expect(frame).toContain("babysit[0]");
    expect(frame).toContain("babysit[4]");
    expect(frame).toContain("Summary");
    expect(lines[0]).toMatch(/^╭/);
    expect(lines[lines.length - 1]).toMatch(/╯$/);
    // Each babysit child occupies exactly one content line, with no blank
    // wrap-continuation rows between them (the pre-fix failure mode).
    const babysitIndexes = lines
      .map((line, i) => (/↳\s*babysit\[\d+]/.test(line) ? i : -1))
      .filter((i) => i >= 0);
    expect(babysitIndexes).toHaveLength(5);
    for (let i = 1; i < babysitIndexes.length; i++) {
      expect(babysitIndexes[i]).toBe(babysitIndexes[i - 1]! + 1);
    }
    for (const index of babysitIndexes) {
      // `lines` are ANSI-stripped; content here is ASCII so `.length` matches
      // terminal columns (including the left/right border glyphs).
      expect(lines[index]!.length).toBeLessThanOrEqual(width);
      // Runner kept on the left of the flexible zone (not crushed to "antigravi…").
      expect(lines[index]).toContain("antigravity/gemini-3.6");
    }
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
    for (const height of [6, 8, 12, 16, 24, 30]) {
      const { lastFrame } = render(
        <WorkflowView state={state} width={90} height={height} selectedIndex={3} elapsedMs={500} />,
      );
      const lines = (lastFrame() ?? "").split("\n");
      expect(lines.length).toBeLessThanOrEqual(height);
    }
  });

  it("keeps blocking action hints visible in compact layouts", () => {
    const approvalState = workflowStateWithSteps(4);
    approvalState.phases[0]!.steps[3]!.approval = { pending: true };
    approvalState.pendingApprovals = [
      {
        phaseId: "phase",
        stepId: "step-3",
        iteration: 1,
        message: "review the result",
        onReject: "fail",
      },
    ];
    const approval = render(
      <WorkflowView
        state={approvalState}
        width={40}
        height={6}
        selectedIndex={3}
        elapsedMs={500}
        now={1_000}
      />,
    );
    const approvalFrame = approval.lastFrame() ?? "";
    expect(approvalFrame).toContain("a approve");
    expect(approvalFrame).toContain("r reject");
    expect(approvalFrame.split("\n").length).toBeLessThanOrEqual(6);

    const inputState = workflowStateWithSteps(4);
    inputState.phases[0]!.steps[3]!.humanInput = { pending: true };
    inputState.pendingInputs = [
      {
        phaseId: "phase",
        stepId: "step-3",
        iteration: 1,
        attempt: 1,
        prompt: "which target?",
        origin: "human-step",
      },
    ];
    const input = render(
      <WorkflowView
        state={inputState}
        width={40}
        height={6}
        selectedIndex={3}
        elapsedMs={500}
        now={1_000}
      />,
    );
    const inputFrame = input.lastFrame() ?? "";
    expect(inputFrame).toContain("a answer");
    expect(inputFrame.split("\n").length).toBeLessThanOrEqual(6);
  });

  it("keeps the step tree capped so detail retains space on tall frames", () => {
    const state = workflowStateWithSteps(12);
    for (const step of state.phases[0]!.steps) {
      step.status = "pending";
      step.text = "";
      step.result = undefined;
    }
    const { lastFrame } = render(
      <WorkflowView state={state} width={100} height={22} selectedIndex={0} elapsedMs={500} />,
    );
    const frame = lastFrame() ?? "";
    const lines = frame.split("\n");
    expect(lines.length).toBeLessThanOrEqual(22);
    // Tree is windowed rather than allowed to consume the whole frame.
    expect(frame).toContain("later row");
    expect(frame).toContain("step-0");
    // Detail panel remains visible beneath the windowed tree.
    expect(frame).toMatch(/──/);
  });

  it("compacts simultaneous pause and budget notices without clipping the header", () => {
    const state = workflowStateWithSteps(4);
    state.paused = true;
    state.pausedBy = "human:tui";
    state.budget = { scope: "workflow", limitUsd: 1, spentUsd: 1.25 };
    const { lastFrame } = render(
      <WorkflowView state={state} width={100} height={6} selectedIndex={3} elapsedMs={500} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("workflow · big-run");
    expect(frame).toContain("paused · workflow budget");
    expect(frame.split("\n").length).toBeLessThanOrEqual(6);
  });

  it("presents user-blocked steps as waiting instead of running", () => {
    const state = workflowStateWithSteps(4);
    const blocked = state.phases[0]!.steps[3]!;
    blocked.approval = { pending: true };
    blocked.startedAt = 1_000;
    state.pendingApprovals = [
      { phaseId: "phase", stepId: "step-3", iteration: 1, onReject: "fail" },
    ];
    const { lastFrame } = render(
      <WorkflowView
        state={state}
        width={100}
        height={20}
        selectedIndex={3}
        elapsedMs={500}
        now={11_000}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("1 waiting");
    expect(frame).toContain("waiting for approval");
    expect(frame).not.toContain("1 running");
    expect(frame).not.toContain("⏱ 10.0s");
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
