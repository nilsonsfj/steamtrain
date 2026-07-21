import { describe, expect, it } from "vitest";
import type { PhaseState, StepState } from "../src/tui/workflow-state";
import {
  FANOUT_COLLAPSE_THRESHOLD,
  buildWorkflowTreeRows,
  findTreeRowIndex,
} from "../src/tui/workflow-tree-rows";

function child(id: string, status: StepState["status"], parent = "babysit"): StepState {
  return {
    stepId: id,
    parentStepId: parent,
    blockKind: "worker",
    status,
    text: "",
    cached: false,
  };
}

function phaseWithFanOut(pendingCount: number, runningCount = 0): PhaseState {
  const parent: StepState = {
    stepId: "babysit",
    blockKind: "distributor",
    status: "done",
    text: "",
    cached: false,
  };
  const running = Array.from({ length: runningCount }, (_, i) => child(`babysit[${i}]`, "running"));
  const pending = Array.from({ length: pendingCount }, (_, i) =>
    child(`babysit[${runningCount + i}]`, "pending"),
  );
  const steps = [parent, ...running, ...pending];
  return {
    phaseId: "p",
    title: "Babysit",
    index: 0,
    stepCount: steps.length,
    steps,
    done: false,
    ok: true,
  };
}

describe("buildWorkflowTreeRows", () => {
  it("collapses long pending fan-out runs into one summary row", () => {
    const phase = phaseWithFanOut(20, 3);
    // flat: parent(0), run 1-3 (flat 1-3), pending 4-23 (flat 4-23)
    const rows = buildWorkflowTreeRows([phase], 1);
    const collapsed = rows.filter((r) => r.kind === "collapsed");
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toMatchObject({
      kind: "collapsed",
      count: 20,
      firstStepId: "babysit[3]",
      lastStepId: "babysit[22]",
    });
    expect(rows.filter((r) => r.kind === "step")).toHaveLength(4); // parent + 3 running
  });

  it("keeps short pending runs expanded", () => {
    const phase = phaseWithFanOut(FANOUT_COLLAPSE_THRESHOLD - 1, 0);
    const rows = buildWorkflowTreeRows([phase], 0);
    expect(rows.every((r) => r.kind !== "collapsed")).toBe(true);
    expect(rows.filter((r) => r.kind === "step")).toHaveLength(1 + FANOUT_COLLAPSE_THRESHOLD - 1);
  });

  it("expands the selected pending step inside a collapsed run", () => {
    const phase = phaseWithFanOut(20, 0);
    // parent flat 0, pending flat 1..20; select flat 10
    const rows = buildWorkflowTreeRows([phase], 10);
    const selected = rows.find((r) => r.kind === "step" && r.flatIndex === 10);
    expect(selected).toBeDefined();
    expect(selected).toMatchObject({ kind: "step", step: { stepId: "babysit[9]" } });
    const collapsed = rows.filter((r) => r.kind === "collapsed");
    expect(collapsed.length).toBe(2); // before + after
    expect(collapsed[0]!.count + collapsed[1]!.count + 1).toBe(20);
  });

  it("does not collapse top-level pending steps without a parent", () => {
    const steps: StepState[] = Array.from({ length: 10 }, (_, i) => ({
      stepId: `step-${i}`,
      blockKind: "worker",
      status: "pending",
      text: "",
      cached: false,
    }));
    const phase: PhaseState = {
      phaseId: "p",
      title: "Flat",
      index: 0,
      stepCount: 10,
      steps,
      done: false,
      ok: true,
    };
    const rows = buildWorkflowTreeRows([phase], 0);
    expect(rows.every((r) => r.kind !== "collapsed")).toBe(true);
  });
});

describe("findTreeRowIndex", () => {
  it("finds an expanded step and a collapsed coverage range", () => {
    const phase = phaseWithFanOut(10, 1);
    const rows = buildWorkflowTreeRows([phase], 1); // select first running
    expect(findTreeRowIndex(rows, 1)).toBeGreaterThan(0);
    const collapsed = rows.find((r) => r.kind === "collapsed");
    expect(collapsed?.kind).toBe("collapsed");
    if (collapsed?.kind === "collapsed") {
      expect(findTreeRowIndex(rows, collapsed.fromFlatIndex)).toBe(
        rows.findIndex((r) => r.kind === "collapsed"),
      );
    }
  });
});
