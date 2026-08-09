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

  it("accepts custom agent instance ids at parse time (validated at run time)", () => {
    const custom = {
      ...validSpec,
      phases: [
        {
          id: "p",
          title: "P",
          steps: [{ id: "a", agent: "opencode-fork", model: "m", prompt: "x" }],
        },
      ],
    };
    expect(workflowSpecSchema.safeParse(custom).success).toBe(true);
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

  it("rejects gate conditions with ok but no step", () => {
    const spec: WorkflowSpec = {
      name: "bad-gate",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "gate", kind: "gate", condition: { ok: true } }],
        },
      ],
    };
    expect(workflowSpecSchema.safeParse(spec).success).toBe(false);
    expect(validateWorkflow(spec).ok).toBe(false);
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

describe("workflow (sub-workflow) step", () => {
  function specWith(step: Record<string, unknown>): WorkflowSpec {
    return {
      name: "parent",
      phases: [{ id: "p1", title: "P1", steps: [step as never] }],
    };
  }

  it("accepts a minimal workflow step", () => {
    const result = validateWorkflow(specWith({ id: "call", kind: "workflow", workflow: "child" }));
    expect(result.ok).toBe(true);
  });

  it("accepts input and outputStep fields", () => {
    const result = validateWorkflow(
      specWith({
        id: "call",
        kind: "workflow",
        workflow: "child",
        input: "{{input}} extra",
        outputStep: "final",
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a workflow step with an empty workflow name", () => {
    const result = validateWorkflow(specWith({ id: "call", kind: "workflow", workflow: "" }));
    expect(result.ok).toBe(false);
  });

  it("rejects a workflow step missing the workflow field", () => {
    const result = validateWorkflow(specWith({ id: "call", kind: "workflow" }));
    expect(result.ok).toBe(false);
  });

  it("rejects a later step from inheriting a workflow step's workspace", () => {
    const spec: WorkflowSpec = {
      name: "parent",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "call", kind: "workflow", workflow: "child" } as never],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            {
              id: "next",
              kind: "command",
              cmd: "echo hi",
              workspace: "inherit:call",
            },
          ],
        },
      ],
    };
    const result = validateWorkflow(spec);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("workflow");
  });

  it("accepts forEach/params/worktreeStep fields", () => {
    const spec: WorkflowSpec = {
      name: "parent",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "source", kind: "distributor", items: ["a", "b"] }],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            {
              id: "call",
              kind: "workflow",
              workflow: "child",
              forEach: "steps.source.items",
              params: { coderModel: "{{item}}" },
              worktreeStep: "impl",
              dependsOn: ["source"],
            } as never,
          ],
        },
      ],
    };
    const result = validateWorkflow(spec);
    expect(result.ok).toBe(true);
  });

  it("accepts a forEach referencing a command source", () => {
    const spec: WorkflowSpec = {
      name: "parent",
      phases: [
        { id: "p1", title: "P1", steps: [{ id: "cmd", kind: "command", cmd: "true" }] },
        {
          id: "p2",
          title: "P2",
          steps: [
            {
              id: "call",
              kind: "workflow",
              workflow: "child",
              forEach: "steps.cmd.items",
              dependsOn: ["cmd"],
            } as never,
          ],
        },
      ],
    };
    expect(validateWorkflow(spec).ok).toBe(true);
  });

  it("rejects a forEach referencing a consolidator source", () => {
    const spec: WorkflowSpec = {
      name: "parent",
      phases: [
        {
          id: "p0",
          title: "P0",
          steps: [{ id: "seed", kind: "command", cmd: "true" }],
        },
        {
          id: "p1",
          title: "P1",
          steps: [
            { id: "merge-text", kind: "consolidator", prompt: "x", dependsOn: ["seed"] },
          ],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            {
              id: "call",
              kind: "workflow",
              workflow: "child",
              forEach: "steps.merge-text.items",
              dependsOn: ["merge-text"],
            } as never,
          ],
        },
      ],
    };
    const result = validateWorkflow(spec);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/must be a distributor, command, or llm/);
  });

  it("accepts a non-forEach workflow step with worktreeStep as a workspace source", () => {
    const spec: WorkflowSpec = {
      name: "parent",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "call",
              kind: "workflow",
              workflow: "child",
              worktreeStep: "impl",
            } as never,
          ],
        },
        {
          id: "p2",
          title: "P2",
          steps: [{ id: "next", kind: "command", cmd: "echo hi", workspace: "attach:call" }],
        },
      ],
    };
    const result = validateWorkflow(spec);
    expect(result.ok).toBe(true);
  });

  it("rejects a forEach workflow step with worktreeStep as a workspace source (one worktree per item)", () => {
    const spec: WorkflowSpec = {
      name: "parent",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "source", kind: "distributor", items: ["a", "b"] }],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            {
              id: "call",
              kind: "workflow",
              workflow: "child",
              forEach: "steps.source.items",
              worktreeStep: "impl",
              dependsOn: ["source"],
            } as never,
          ],
        },
        {
          id: "p3",
          title: "P3",
          steps: [{ id: "next", kind: "command", cmd: "echo hi", workspace: "attach:call" }],
        },
      ],
    };
    const result = validateWorkflow(spec);
    expect(result.ok).toBe(false);
  });
});
