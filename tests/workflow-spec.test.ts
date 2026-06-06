import { describe, expect, it } from "vitest";
import {
  MAX_STEPS,
  type WorkflowSpec,
  validateWorkflow,
  workflowSpecSchema,
  workflowStepKind,
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

  it("rejects static dynamic fan-out above the step cap", () => {
    const spec: WorkflowSpec = {
      name: "huge-dynamic",
      phases: [
        {
          id: "split",
          title: "Split",
          steps: [
            {
              id: "split",
              kind: "distributor",
              items: Array.from({ length: MAX_STEPS }, (_, i) => `item-${i}`),
            },
          ],
        },
        {
          id: "work",
          title: "Work",
          steps: [
            {
              id: "work",
              kind: "processor",
              agent: "claude",
              model: "m",
              prompt: "{{item}}",
              dependsOn: ["split"],
              forEach: "steps.split.items",
            },
          ],
        },
      ],
    };

    const res = validateWorkflow(spec);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/expand to/);
  });

  it("accepts explicit workflow building blocks", () => {
    const spec: WorkflowSpec = {
      name: "blocks",
      phases: [
        {
          id: "split",
          title: "Split",
          steps: [{ id: "split", kind: "distributor", items: ["a", "b"] }],
        },
        {
          id: "work",
          title: "Work",
          steps: [
            {
              id: "work",
              kind: "processor",
              agent: "claude",
              model: "m",
              prompt: "{{steps.split.items}}",
              forEach: "steps.split.items",
              dependsOn: ["split"],
            },
          ],
        },
        {
          id: "merge",
          title: "Merge",
          steps: [
            { id: "merge", kind: "consolidator", dependsOn: ["work"] },
            {
              id: "gate",
              kind: "gate",
              dependsOn: ["work"],
              condition: { step: "work", ok: true },
              target: "ready",
            },
          ],
        },
      ],
    };

    expect(workflowSpecSchema.safeParse(spec).success).toBe(true);
    expect(validateWorkflow(spec)).toEqual({ ok: true });
    const firstStep = spec.phases[0]?.steps[0];
    expect(firstStep && workflowStepKind(firstStep)).toBe("distributor");
  });

  it("rejects malformed building blocks", () => {
    expect(
      workflowSpecSchema.safeParse({
        name: "bad",
        phases: [{ id: "p", title: "P", steps: [{ id: "split", kind: "distributor" }] }],
      }).success,
    ).toBe(false);
    expect(
      workflowSpecSchema.safeParse({
        name: "bad",
        phases: [{ id: "p", title: "P", steps: [{ id: "merge", kind: "consolidator" }] }],
      }).success,
    ).toBe(false);
    expect(
      workflowSpecSchema.safeParse({
        name: "bad",
        phases: [{ id: "p", title: "P", steps: [{ id: "gate", kind: "gate", condition: {} }] }],
      }).success,
    ).toBe(false);
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

  it("rejects a gate condition referencing a same-phase step", () => {
    const spec: WorkflowSpec = {
      name: "same-gate",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            { id: "a", agent: "claude", model: "m", prompt: "x" },
            { id: "gate", kind: "gate", condition: { step: "a", ok: true } },
          ],
        },
      ],
    };
    const res = validateWorkflow(spec);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not in an earlier phase/);
  });

  it("rejects forEach references that are malformed, unknown, or same-phase", () => {
    const malformed: WorkflowSpec = {
      name: "malformed",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "work",
              kind: "processor",
              agent: "claude",
              model: "m",
              prompt: "x",
              forEach: "split",
            },
          ],
        },
      ],
    };
    expect(validateWorkflow(malformed).error).toMatch(/invalid forEach/);

    const unknown: WorkflowSpec = {
      name: "unknown",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "work",
              kind: "processor",
              agent: "claude",
              model: "m",
              prompt: "x",
              forEach: "steps.missing.items",
            },
          ],
        },
      ],
    };
    expect(validateWorkflow(unknown).error).toMatch(/unknown step/);

    const samePhase: WorkflowSpec = {
      name: "same",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            { id: "split", kind: "distributor", items: ["a"] },
            {
              id: "work",
              kind: "processor",
              agent: "claude",
              model: "m",
              prompt: "x",
              forEach: "steps.split.items",
            },
          ],
        },
      ],
    };
    expect(validateWorkflow(samePhase).error).toMatch(/not in an earlier phase/);

    const workerSource: WorkflowSpec = {
      name: "worker-source",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "source", agent: "claude", model: "m", prompt: "x" }],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            {
              id: "work",
              kind: "processor",
              agent: "claude",
              model: "m",
              prompt: "{{item}}",
              dependsOn: ["source"],
              forEach: "steps.source.items",
            },
          ],
        },
      ],
    };
    expect(validateWorkflow(workerSource).error).toMatch(/must be a distributor/);
  });
});
