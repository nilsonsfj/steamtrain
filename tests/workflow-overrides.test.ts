import { describe, expect, it } from "vitest";
import { applyWorkflowStepOverrides } from "../src/workflow/overrides";
import type { WorkflowSpec } from "../src/workflow";

const spec: WorkflowSpec = {
  name: "test",
  phases: [
    {
      id: "p1",
      title: "Phase 1",
      steps: [
        { id: "plan", agent: "claude", model: "claude-sonnet-4-6", prompt: "plan" },
        { id: "gate1", kind: "gate", condition: { step: "plan", ok: true }, target: "p2" },
      ],
    },
    {
      id: "p2",
      title: "Phase 2",
      steps: [{ id: "implement", agent: "codex", model: "gpt-5.5", prompt: "build" }],
    },
  ],
};

describe("applyWorkflowStepOverrides", () => {
  it("returns the same spec when overrides are empty", () => {
    expect(applyWorkflowStepOverrides(spec, undefined)).toBe(spec);
    expect(applyWorkflowStepOverrides(spec, {})).toBe(spec);
  });

  it("patches agent-backed steps only", () => {
    const next = applyWorkflowStepOverrides(spec, {
      plan: { model: "claude-opus-4-8" },
      gate1: { agent: "codex", model: "gpt-5.5" },
    });
    expect(next.phases[0]!.steps[0]).toMatchObject({
      id: "plan",
      model: "claude-opus-4-8",
    });
    expect(next.phases[0]!.steps[1]).toEqual(spec.phases[0]!.steps[1]);
    expect(next.phases[1]!.steps[0]).toMatchObject({
      id: "implement",
      agent: "codex",
      model: "gpt-5.5",
    });
  });
});
