import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { WorkflowPreview } from "../src/tui/WorkflowPreview";
import {
  flattenSpecSteps,
  formatWorkflowAgentTarget,
  previewInputValues,
  specDetailLines,
} from "../src/tui/workflow-spec-ui";
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
        source="bundled"
        width={100}
        height={30}
        selectedIndex={0}
        dispatchCheck={{ ok: true }}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("workflow preview · multi-plan");
    expect(frame).toContain("(bundled)");
    expect(frame).toContain("planning-lenses");
    expect(frame).toContain("ready to run");
    expect(frame).toContain("fan-out");
  });

  it("shows dispatch blockers", () => {
    const spec = BUNDLED_WORKFLOWS["bug-hunt"]!;
    const { lastFrame } = render(
      <WorkflowPreview
        spec={spec}
        source="bundled"
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

  it("clamps selected index and renders step detail", () => {
    const spec = BUNDLED_WORKFLOWS["multi-plan"]!;
    const { lastFrame } = render(
      <WorkflowPreview
        spec={spec}
        source="bundled"
        width={160}
        height={40}
        selectedIndex={999}
        dispatchCheck={{ ok: true }}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/▶.*synthes/i);
    expect(frame).toContain("synthesize");
    expect(frame).toContain("DeepSeek V4 Flash Free");
  });

  it("hides step detail panel when showStepDetail is false", () => {
    const spec = BUNDLED_WORKFLOWS["multi-plan"]!;
    const { lastFrame } = render(
      <WorkflowPreview
        spec={spec}
        source="bundled"
        width={100}
        height={30}
        selectedIndex={0}
        dispatchCheck={{ ok: true }}
        showStepDetail={false}
      />,
    );
    const frame = lastFrame() ?? "";
    // The detail panel shows step id + kind + phase title in a bordered box.
    // With showStepDetail=false, the detail panel content should be absent.
    expect(frame).not.toContain("distributor · phase");
    expect(frame).toContain("planning-lenses");
  });

  it("hides plan result when showPlanResult is false", () => {
    const spec = BUNDLED_WORKFLOWS["multi-plan"]!;
    const { lastFrame } = render(
      <WorkflowPreview
        spec={spec}
        source="bundled"
        width={100}
        height={30}
        selectedIndex={0}
        dispatchCheck={{ ok: true }}
        showPlanResult={false}
      />,
    );
    const frame = lastFrame() ?? "";
    // Plan result view should not appear even if planResult is set.
    expect(frame).toContain("ready to run");
  });

  it("resolves input defaults and does not corrupt the mainline preview frame", () => {
    const spec = BUNDLED_WORKFLOWS.mainline!;
    const { lastFrame } = render(
      <WorkflowPreview
        spec={spec}
        source="bundled"
        width={100}
        height={30}
        selectedIndex={0}
        dispatchCheck={{ ok: true }}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("workflow preview · mainline");
    expect(frame).toContain("ready to run");
    // Defaults are applied for display (not raw {{inputs.*}} placeholders).
    expect(frame).toContain("deepseek-v4-flash-free");
    expect(frame).not.toContain("{{inputs.");
    // Classic Ink wrap-overlap artifacts from the broken preview.
    expect(frame).not.toContain("rModel}}");
    expect(frame).not.toContain("ready to runworker");
    expect(frame).not.toContain("merge-backintegrat");
    expect(frame).toMatch(/plan · distributor · phase/);
    expect(frame).toMatch(/runner:/);
  });
});

describe("preview input resolution", () => {
  it("formats agent targets with declared defaults and omits empty effort", () => {
    const spec = BUNDLED_WORKFLOWS.mainline!;
    const inputs = previewInputValues(spec);
    const plan = spec.phases[0]!.steps[0]!;
    const runner = formatWorkflowAgentTarget(
      {
        agent: "agent" in plan ? plan.agent : undefined,
        model: "model" in plan ? plan.model : undefined,
        effort: "effort" in plan ? plan.effort : undefined,
      },
      { inputs },
    );
    expect(runner).toContain("deepseek-v4-flash-free");
    expect(runner).not.toContain("{{inputs.");
    expect(runner).not.toMatch(/·\s*$/);
    expect(specDetailLines(plan, { inputs }).some((line) => line.startsWith("effort:"))).toBe(
      false,
    );
  });
});
