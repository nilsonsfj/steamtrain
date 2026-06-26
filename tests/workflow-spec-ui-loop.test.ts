import { describe, expect, it } from "vitest";
import { specDetailLines, specStepRowMeta } from "../src/tui/workflow-spec-ui";
import type { GateStep } from "../src/workflow";

const gate: GateStep = {
  id: "check-gate",
  kind: "gate",
  dependsOn: ["fix-step"],
  condition: { step: "fix-step", contains: "DONE" },
  loopTo: "review",
  maxIterations: 5,
  onFalse: "fail",
};

describe("loop gate display", () => {
  it("shows the loop back-edge in detail lines", () => {
    const lines = specDetailLines(gate);
    expect(lines.some((l) => l.includes("loops back to review") && l.includes("max 5"))).toBe(true);
  });

  it("shows the loop in the compact row meta", () => {
    expect(specStepRowMeta(gate)).toContain("↺ phase:review");
  });
});
