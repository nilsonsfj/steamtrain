import { describe, expect, it } from "vitest";
import type { WorkflowSpec } from "../src/workflow";
import {
  applyWorkflowSessionOverrides,
  applyWorkflowStepOverrides,
  normalizeSessionOverrides,
  parseSessionOverrides,
  sessionOverridesEmpty,
} from "../src/workflow/overrides";

const spec: WorkflowSpec = {
  name: "test",
  stepTimeoutSec: 600,
  workflowTimeoutSec: 3600,
  phases: [
    {
      id: "p1",
      title: "Phase 1",
      steps: [
        {
          id: "plan",
          agent: "claude",
          model: "claude-sonnet-4-6",
          prompt: "plan",
          effort: "high",
        },
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

  it("clears optional fields when patch value is null", () => {
    const next = applyWorkflowStepOverrides(spec, {
      plan: { effort: null as unknown as string | undefined },
    });
    expect(next.phases[0]!.steps[0]).toMatchObject({ id: "plan", agent: "claude" });
    expect("effort" in (next.phases[0]!.steps[0] as object)).toBe(false);
  });
});

describe("applyWorkflowSessionOverrides", () => {
  it("applies workflow-level timeouts from structured overrides", () => {
    const next = applyWorkflowSessionOverrides(spec, {
      steps: { plan: { model: "claude-opus-4-8" } },
      stepTimeoutSec: 1200,
      workflowTimeoutSec: 7200,
    });
    expect(next.stepTimeoutSec).toBe(1200);
    expect(next.workflowTimeoutSec).toBe(7200);
    expect(next.phases[0]!.steps[0]).toMatchObject({ model: "claude-opus-4-8" });
  });

  it("clears workflow-level timeouts when null", () => {
    const next = applyWorkflowSessionOverrides(spec, {
      stepTimeoutSec: null,
      workflowTimeoutSec: null,
    });
    expect("stepTimeoutSec" in next).toBe(false);
    expect("workflowTimeoutSec" in next).toBe(false);
  });

  it("accepts legacy flat step maps", () => {
    const next = applyWorkflowSessionOverrides(spec, {
      plan: { model: "claude-opus-4-8" },
    });
    expect(next.phases[0]!.steps[0]).toMatchObject({ model: "claude-opus-4-8" });
    expect(next.stepTimeoutSec).toBe(600);
  });
});

describe("parseSessionOverrides", () => {
  it("parses structured overrides", () => {
    const parsed = parseSessionOverrides({
      steps: { s1: { agent: "codex" } },
      stepTimeoutSec: 300,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.overrides.steps).toEqual({ s1: { agent: "codex" } });
      expect(parsed.overrides.stepTimeoutSec).toBe(300);
    }
  });

  it("parses legacy flat step maps", () => {
    const parsed = parseSessionOverrides({ s1: { agent: "codex" } });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.overrides.steps).toEqual({ s1: { agent: "codex" } });
  });

  it("rejects legacy __wf_* keys", () => {
    const parsed = parseSessionOverrides({ __wf_stepTimeoutSec__: 300 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("legacy override key");
  });

  it("rejects unknown step patch field names", () => {
    const structured = parseSessionOverrides({
      steps: { s1: { agent: "codex", typoField: "x" } },
    });
    expect(structured.ok).toBe(false);
    if (!structured.ok) {
      expect(structured.error).toBe("overrides.steps.s1.typoField is not a recognized agent field");
    }

    const flat = parseSessionOverrides({ s1: { agent: "codex", typoField: "x" } });
    expect(flat.ok).toBe(false);
    if (!flat.ok) {
      expect(flat.error).toBe("overrides.s1.typoField is not a recognized agent field");
    }
  });
});

describe("sessionOverridesEmpty", () => {
  it("treats workflow timeout fields as staged content", () => {
    expect(sessionOverridesEmpty({ stepTimeoutSec: null })).toBe(false);
    expect(sessionOverridesEmpty({ steps: {} })).toBe(true);
  });
});

describe("normalizeSessionOverrides", () => {
  it("rejects legacy __wf_* keys", () => {
    expect(() =>
      normalizeSessionOverrides({ __wf_stepTimeoutSec__: 1 } as Record<string, unknown>),
    ).toThrow(/legacy override key/);
  });

  it("treats flat maps with a step id named steps as legacy step overrides", () => {
    const normalized = normalizeSessionOverrides({
      steps: { agent: "codex", model: "gpt-5" },
    });
    expect(normalized?.steps?.steps).toEqual({ agent: "codex", model: "gpt-5" });
  });

  it("treats flat maps with a step id named stepTimeoutSec as legacy step overrides", () => {
    const normalized = normalizeSessionOverrides({
      stepTimeoutSec: { agent: "codex" },
    });
    expect(normalized?.steps?.stepTimeoutSec).toEqual({ agent: "codex" });
  });
});
