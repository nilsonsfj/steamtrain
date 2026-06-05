import { describe, expect, it } from "vitest";
import {
  MAX_STEPS,
  type WorkflowSpec,
  validateWorkflow,
  workflowSpecSchema,
} from "../src/workflow";

const validSpec: WorkflowSpec = {
  name: "demo",
  phases: [
    {
      id: "draft",
      title: "Draft",
      steps: [
        { id: "a", agent: "claude", model: "claude-sonnet-4-6", prompt: "{{input}}" },
        { id: "b", agent: "opencode", model: "openai/gpt-5.4-mini", prompt: "{{input}}" },
      ],
    },
    {
      id: "merge",
      title: "Merge",
      steps: [
        {
          id: "c",
          agent: "claude",
          model: "claude-opus-4-8",
          prompt: "{{steps.a.output}} {{steps.b.output}}",
          dependsOn: ["a", "b"],
        },
      ],
    },
  ],
};

describe("workflowSpecSchema", () => {
  it("accepts a valid spec", () => {
    expect(workflowSpecSchema.safeParse(validSpec).success).toBe(true);
    expect(validateWorkflow(validSpec)).toEqual({ ok: true });
  });

  it("rejects an unknown agent", () => {
    const bad = {
      ...validSpec,
      phases: [
        { id: "p", title: "P", steps: [{ id: "a", agent: "gpt", model: "m", prompt: "x" }] },
      ],
    };
    expect(workflowSpecSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects empty phases and empty steps", () => {
    expect(workflowSpecSchema.safeParse({ name: "n", phases: [] }).success).toBe(false);
    expect(
      workflowSpecSchema.safeParse({ name: "n", phases: [{ id: "p", title: "P", steps: [] }] })
        .success,
    ).toBe(false);
  });

  it("rejects duplicate step ids", () => {
    const dup: WorkflowSpec = {
      name: "dup",
      phases: [
        { id: "p1", title: "P1", steps: [{ id: "a", agent: "claude", model: "m", prompt: "x" }] },
        { id: "p2", title: "P2", steps: [{ id: "a", agent: "claude", model: "m", prompt: "x" }] },
      ],
    };
    const res = validateWorkflow(dup);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/duplicate step id/);
  });

  it("rejects a workflow over the step cap", () => {
    const steps = Array.from({ length: MAX_STEPS + 1 }, (_, i) => ({
      id: `s${i}`,
      agent: "claude" as const,
      model: "m",
      prompt: "x",
    }));
    const huge: WorkflowSpec = { name: "huge", phases: [{ id: "p", title: "P", steps }] };
    const res = validateWorkflow(huge);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/max/);
  });
});

describe("validateWorkflow dependency rules", () => {
  it("rejects a dependsOn on a step in the same phase", () => {
    const spec: WorkflowSpec = {
      name: "same",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            { id: "a", agent: "claude", model: "m", prompt: "x" },
            {
              id: "b",
              agent: "claude",
              model: "m",
              prompt: "{{steps.a.output}}",
              dependsOn: ["a"],
            },
          ],
        },
      ],
    };
    const res = validateWorkflow(spec);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/earlier phase/);
  });

  it("rejects a dependsOn on an unknown step", () => {
    const spec: WorkflowSpec = {
      name: "unknown",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "a", agent: "claude", model: "m", prompt: "x", dependsOn: ["ghost"] }],
        },
      ],
    };
    const res = validateWorkflow(spec);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unknown step/);
  });

  it("accepts a dependsOn on a step in an earlier phase", () => {
    expect(validateWorkflow(validSpec)).toEqual({ ok: true });
  });
});
