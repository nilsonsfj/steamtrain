import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { WorkflowPreview, flattenSpecSteps } from "../src/tui/WorkflowPreview";
import { BUNDLED_WORKFLOWS } from "../src/workflow";

describe("WorkflowPreview", () => {
  it("flattens spec phases and steps in order", () => {
    const spec = BUNDLED_WORKFLOWS["multi-plan"]!;
    const flat = flattenSpecSteps(spec);
    expect(flat.length).toBeGreaterThan(0);
    expect(flat[0]?.step.id).toBe("planning-lenses");
    expect(flat.at(-1)?.step.id).toBe("synthesize");
  });

  it("renders workflow metadata and step detail", () => {
    const spec = BUNDLED_WORKFLOWS["multi-plan"]!;
    const { lastFrame } = render(
      <WorkflowPreview
        spec={spec}
        input="add workflow preview screen"
        width={100}
        height={30}
        selectedIndex={0}
        dispatchCheck={{ ok: true }}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("workflow preview · multi-plan");
    expect(frame).toContain("add workflow preview screen");
    expect(frame).toContain("planning-lenses");
    expect(frame).toContain("ready to run");
    expect(frame).toContain("fan-out");
  });

  it("shows dispatch blockers", () => {
    const spec = BUNDLED_WORKFLOWS["bug-hunt"]!;
    const { lastFrame } = render(
      <WorkflowPreview
        spec={spec}
        input="scan auth module"
        width={100}
        height={30}
        selectedIndex={1}
        dispatchCheck={{ ok: false, reason: "opencode is binary_missing — not found" }}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("blocked:");
    expect(frame).toContain("binary_missing");
  });
});
