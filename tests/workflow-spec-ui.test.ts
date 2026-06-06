import { describe, expect, it } from "vitest";
import {
  blockSummary,
  flattenSpecSteps,
  formatGateCondition,
  phaseStepOffsets,
} from "../src/tui/workflow-spec-ui";
import { BUNDLED_WORKFLOWS } from "../src/workflow";

describe("workflow-spec-ui", () => {
  it("computes phase step offsets", () => {
    const spec = BUNDLED_WORKFLOWS["multi-plan"]!;
    const offsets = phaseStepOffsets(spec.phases);
    expect(offsets[0]).toBe(0);
    expect(offsets.at(-1)).toBe(spec.phases.slice(0, -1).reduce((n, p) => n + p.steps.length, 0));
  });

  it("assigns stable flat indices while flattening", () => {
    const spec = BUNDLED_WORKFLOWS["multi-plan"]!;
    const flat = flattenSpecSteps(spec);
    flat.forEach((entry, i) => expect(entry.flatIndex).toBe(i));
  });

  it("summarizes block kinds", () => {
    const spec = BUNDLED_WORKFLOWS["multi-plan"]!;
    expect(blockSummary(spec)).toContain("distributor:1");
    expect(blockSummary(spec)).toContain("worker:2");
  });

  it("formats gate conditions", () => {
    expect(formatGateCondition({ step: "gate", ok: true })).toBe("step=gate ok=true");
    expect(formatGateCondition({ contains: "error", not: true })).toBe('contains="error" not');
  });

  it("handles empty phases", () => {
    const spec = { name: "empty", phases: [] };
    expect(flattenSpecSteps(spec)).toEqual([]);
    expect(phaseStepOffsets(spec.phases)).toEqual([]);
    expect(blockSummary(spec)).toBe("");
  });
});
