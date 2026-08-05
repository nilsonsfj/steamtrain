import { describe, expect, it } from "vitest";
import {
  isLiveOutputContainer,
  liveOutputBody,
  nestedStepsOf,
  resolveLiveOutputStep,
} from "../src/workflow/live-output";
import type { PhaseState, StepState, WorkflowState } from "../src/workflow/reducer";

function step(partial: Partial<StepState> & Pick<StepState, "stepId" | "blockKind">): StepState {
  return {
    status: "pending",
    text: "",
    cached: false,
    ...partial,
  };
}

function state(phases: PhaseState[]): WorkflowState {
  return {
    phases,
    results: [],
    started: true,
    done: false,
    ok: true,
  };
}

describe("isLiveOutputContainer", () => {
  it("is true only for workflow-call steps", () => {
    expect(isLiveOutputContainer(step({ stepId: "babysit", blockKind: "workflow" }))).toBe(true);
    expect(isLiveOutputContainer(step({ stepId: "prepare", blockKind: "processor" }))).toBe(false);
    expect(isLiveOutputContainer(step({ stepId: "rebase", blockKind: "command" }))).toBe(false);
  });
});

describe("resolveLiveOutputStep", () => {
  it("returns the step itself when it is not a workflow container", () => {
    const prepare = step({
      stepId: "prepare",
      blockKind: "processor",
      status: "running",
      text: "hello",
    });
    const wf = state([
      {
        phaseId: "p",
        title: "P",
        index: 0,
        stepCount: 1,
        steps: [prepare],
        done: false,
        ok: true,
      },
    ]);
    expect(resolveLiveOutputStep(wf, prepare)).toBe(prepare);
  });

  it("bubbles a running nested agent leaf under a forEach workflow child", () => {
    // Mirrors babysit-all-prs: babysit[4] stays running while babysit[4]::prepare
    // streams agent text_delta into a namespaced phase.
    const parent = step({
      stepId: "babysit[4]",
      blockKind: "workflow",
      status: "running",
      parentStepId: "babysit",
      workflow: "babysit-pr",
    });
    const rebase = step({
      stepId: "babysit[4]::rebase",
      blockKind: "command",
      status: "done",
      parentStepId: "babysit[4]",
      text: "already rebased",
      result: {
        stepId: "babysit[4]::rebase",
        ok: true,
        output: "already rebased",
        durationMs: 100,
        parentStepId: "babysit[4]",
      },
    });
    const prepare = step({
      stepId: "babysit[4]::prepare",
      blockKind: "processor",
      status: "running",
      parentStepId: "babysit[4]",
      agent: "opencode",
      text: "Inspecting PR #42…\n⚙ bash",
      activity: "⚙ bash",
    });
    const wf = state([
      {
        phaseId: "babysit",
        title: "Babysit each PR",
        index: 0,
        stepCount: 1,
        steps: [parent],
        done: false,
        ok: true,
      },
      {
        phaseId: "babysit[4]::rebase",
        title: "Rebase",
        index: 1,
        stepCount: 1,
        steps: [rebase],
        done: true,
        ok: true,
      },
      {
        phaseId: "babysit[4]::prepare",
        title: "Prepare",
        index: 2,
        stepCount: 1,
        steps: [prepare],
        done: false,
        ok: true,
      },
    ]);

    expect(nestedStepsOf(wf, "babysit[4]").map((s) => s.stepId)).toEqual([
      "babysit[4]::rebase",
      "babysit[4]::prepare",
    ]);
    expect(resolveLiveOutputStep(wf, parent)).toBe(prepare);
    expect(liveOutputBody(resolveLiveOutputStep(wf, parent))).toContain("Inspecting PR #42");
  });

  it("prefers a running leaf with body over an earlier finished nested step", () => {
    const parent = step({ stepId: "call", blockKind: "workflow", status: "running" });
    const first = step({
      stepId: "call::a",
      blockKind: "command",
      status: "done",
      text: "done output",
      parentStepId: "call",
    });
    const second = step({
      stepId: "call::b",
      blockKind: "worker",
      status: "running",
      text: "streaming…",
      parentStepId: "call",
    });
    const wf = state([
      {
        phaseId: "outer",
        title: "Outer",
        index: 0,
        stepCount: 1,
        steps: [parent],
        done: false,
        ok: true,
      },
      {
        phaseId: "call::child",
        title: "Child",
        index: 1,
        stepCount: 2,
        steps: [first, second],
        done: false,
        ok: true,
      },
    ]);
    expect(resolveLiveOutputStep(wf, parent).stepId).toBe("call::b");
  });

  it("falls back to the newest nested body when nothing is running", () => {
    const parent = step({ stepId: "call", blockKind: "workflow", status: "done" });
    const first = step({
      stepId: "call::a",
      blockKind: "command",
      status: "done",
      text: "first",
      parentStepId: "call",
    });
    const second = step({
      stepId: "call::b",
      blockKind: "worker",
      status: "done",
      text: "second",
      parentStepId: "call",
    });
    const wf = state([
      {
        phaseId: "outer",
        title: "Outer",
        index: 0,
        stepCount: 1,
        steps: [parent],
        done: true,
        ok: true,
      },
      {
        phaseId: "call::child",
        title: "Child",
        index: 1,
        stepCount: 2,
        steps: [first, second],
        done: true,
        ok: true,
      },
    ]);
    expect(resolveLiveOutputStep(wf, parent).stepId).toBe("call::b");
    expect(liveOutputBody(second)).toBe("second");
  });

  it("returns the container when no nested steps have started", () => {
    const parent = step({ stepId: "call", blockKind: "workflow", status: "running" });
    const wf = state([
      {
        phaseId: "outer",
        title: "Outer",
        index: 0,
        stepCount: 1,
        steps: [parent],
        done: false,
        ok: true,
      },
    ]);
    expect(resolveLiveOutputStep(wf, parent)).toBe(parent);
    expect(liveOutputBody(parent)).toBe("");
  });

  it("resolves through nested workflow containers to the deepest leaf", () => {
    // outer → outer::inner (workflow) → outer::inner::leaf (processor)
    const outer = step({ stepId: "outer", blockKind: "workflow", status: "running" });
    const inner = step({
      stepId: "outer::inner",
      blockKind: "workflow",
      status: "running",
      parentStepId: "outer",
    });
    const leaf = step({
      stepId: "outer::inner::leaf",
      blockKind: "processor",
      status: "running",
      parentStepId: "outer::inner",
      text: "deep stream",
      activity: "⚙ read",
    });
    const wf = state([
      {
        phaseId: "p0",
        title: "P0",
        index: 0,
        stepCount: 1,
        steps: [outer],
        done: false,
        ok: true,
      },
      {
        phaseId: "outer::inner-phase",
        title: "Inner",
        index: 1,
        stepCount: 1,
        steps: [inner],
        done: false,
        ok: true,
      },
      {
        phaseId: "outer::inner::leaf-phase",
        title: "Leaf",
        index: 2,
        stepCount: 1,
        steps: [leaf],
        done: false,
        ok: true,
      },
    ]);
    expect(resolveLiveOutputStep(wf, outer).stepId).toBe("outer::inner::leaf");
    expect(liveOutputBody(resolveLiveOutputStep(wf, outer))).toBe("deep stream");
  });
});

describe("liveOutputBody", () => {
  it("prefers result.output, then text, then activity", () => {
    expect(
      liveOutputBody(
        step({
          stepId: "s",
          blockKind: "worker",
          text: "stream",
          activity: "⚙ bash",
          result: { stepId: "s", ok: true, output: "final", durationMs: 1 },
        }),
      ),
    ).toBe("final");
    expect(
      liveOutputBody(
        step({ stepId: "s", blockKind: "worker", text: "stream", activity: "⚙ bash" }),
      ),
    ).toBe("stream");
    expect(liveOutputBody(step({ stepId: "s", blockKind: "worker", activity: "⚙ bash" }))).toBe(
      "⚙ bash",
    );
  });
});
