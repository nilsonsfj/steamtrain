import { describe, expect, it } from "vitest";
import { listRetargetableSteps } from "../src/tui/workflow-step-editor";
import {
  type WorkflowCallStep,
  type WorkflowSpec,
  applyWorkflowStepOverrides,
  describeSubWorkflow,
  subWorkflowRollup,
  workflowSpecSchema,
} from "../src/workflow";

const child: WorkflowSpec = {
  name: "child",
  phases: [
    {
      id: "p",
      title: "P",
      steps: [
        { id: "build", agent: "claude", model: "sonnet", prompt: "b" },
        { id: "review", dependsOn: ["build"], agent: "codex", model: "gpt-5", prompt: "r" },
      ],
    },
  ],
};

const grandchild: WorkflowSpec = {
  name: "grandchild",
  phases: [
    { id: "g", title: "G", steps: [{ id: "deep", agent: "claude", model: "sonnet", prompt: "d" }] },
  ],
};

const middle: WorkflowSpec = {
  name: "middle",
  phases: [
    {
      id: "m",
      title: "M",
      steps: [
        { id: "local", agent: "claude", model: "sonnet", prompt: "l" },
        { id: "inner", kind: "workflow", workflow: "grandchild" },
      ],
    },
  ],
};

const catalog: Record<string, WorkflowSpec> = { child, grandchild, middle };
const resolve = (name: string) => catalog[name];

function parentWith(step: Partial<WorkflowCallStep>): WorkflowSpec {
  return {
    name: "parent",
    phases: [
      {
        id: "p1",
        title: "P1",
        steps: [{ id: "call", kind: "workflow", workflow: "child", ...step } as WorkflowCallStep],
      },
    ],
  };
}

describe("applyWorkflowStepOverrides — namespace routing", () => {
  it("routes a namespaced key onto the workflow step's own overrides", () => {
    const spec = parentWith({});
    const out = applyWorkflowStepOverrides(spec, {
      "call::build": { agent: "codex", model: "gpt-5" },
    });
    const call = out.phases[0]!.steps[0] as WorkflowCallStep;
    expect(call.overrides).toEqual({ build: { agent: "codex", model: "gpt-5" } });
    // The original spec is untouched (pure).
    expect((spec.phases[0]!.steps[0] as WorkflowCallStep).overrides).toBeUndefined();
  });

  it("merges with existing overrides rather than replacing them", () => {
    const spec = parentWith({ overrides: { review: { effort: "high" } } });
    const out = applyWorkflowStepOverrides(spec, {
      "call::build": { agent: "codex", model: "gpt-5" },
    });
    const call = out.phases[0]!.steps[0] as WorkflowCallStep;
    expect(call.overrides).toEqual({
      review: { effort: "high" },
      build: { agent: "codex", model: "gpt-5" },
    });
  });

  it("keeps a deep namespaced key intact for the engine to route further down", () => {
    const spec = parentWith({ workflow: "middle" });
    const out = applyWorkflowStepOverrides(spec, {
      "call::inner::deep": { agent: "codex", model: "gpt-5" },
    });
    const call = out.phases[0]!.steps[0] as WorkflowCallStep;
    expect(call.overrides).toEqual({ "inner::deep": { agent: "codex", model: "gpt-5" } });
  });

  it("still applies a plain key to a top-level step", () => {
    const spec: WorkflowSpec = {
      name: "flat",
      phases: [
        {
          id: "p",
          title: "P",
          steps: [{ id: "w", agent: "claude", model: "sonnet", prompt: "x" }],
        },
      ],
    };
    const out = applyWorkflowStepOverrides(spec, { w: { model: "haiku" } });
    expect((out.phases[0]!.steps[0] as { model?: string }).model).toBe("haiku");
  });
});

describe("listRetargetableSteps — sub-workflow recursion", () => {
  it("lists only own steps without a resolver (backward compatible)", () => {
    const spec = parentWith({});
    expect(listRetargetableSteps(spec)).toEqual([]);
  });

  it("descends into the sub-workflow with namespaced ids", () => {
    const spec = parentWith({});
    const steps = listRetargetableSteps(spec, resolve);
    expect(steps.map((s) => s.stepId)).toEqual(["call::build", "call::review"]);
    expect(steps.every((s) => s.depth === 1)).toBe(true);
    expect(steps[0]).toMatchObject({ agent: "claude", model: "sonnet", viaWorkflowStep: "call" });
  });

  it("reflects a staged override in the listed target", () => {
    const spec = parentWith({ overrides: { build: { agent: "codex", model: "gpt-5" } } });
    const steps = listRetargetableSteps(spec, resolve);
    expect(steps.find((s) => s.stepId === "call::build")).toMatchObject({
      agent: "codex",
      model: "gpt-5",
    });
  });

  it("recurses two levels deep", () => {
    const spec: WorkflowSpec = {
      name: "top",
      phases: [
        {
          id: "t",
          title: "T",
          steps: [{ id: "call", kind: "workflow", workflow: "middle" }],
        },
      ],
    };
    const steps = listRetargetableSteps(spec, resolve).map((s) => s.stepId);
    expect(steps).toEqual(["call::local", "call::inner::deep"]);
  });

  it("guards cyclic references", () => {
    const cyclic: Record<string, WorkflowSpec> = {
      a: {
        name: "a",
        phases: [{ id: "p", title: "P", steps: [{ id: "toB", kind: "workflow", workflow: "b" }] }],
      },
      b: {
        name: "b",
        phases: [{ id: "p", title: "P", steps: [{ id: "toA", kind: "workflow", workflow: "a" }] }],
      },
    };
    const steps = listRetargetableSteps(cyclic.a!, (n) => cyclic[n]);
    // No agent-backed steps, and the cycle terminates without throwing.
    expect(steps).toEqual([]);
  });
});

describe("describeSubWorkflow", () => {
  it("returns an unresolved shell without a resolver", () => {
    const step = parentWith({}).phases[0]!.steps[0] as WorkflowCallStep;
    const view = describeSubWorkflow(step);
    expect(view.resolved).toBe(false);
    expect(view.workflow).toBe("child");
  });

  it("resolves structure, agents, targets and autonomy", () => {
    const step = parentWith({}).phases[0]!.steps[0] as WorkflowCallStep;
    const view = describeSubWorkflow(step, resolve);
    expect(view.resolved).toBe(true);
    expect(view.stepCount).toBe(2);
    expect(view.agents.sort()).toEqual(["claude", "codex"]);
    expect(view.targets.sort()).toEqual(["claude/sonnet", "codex/gpt-5"]);
    expect(view.steps.map((s) => s.path)).toEqual(["build", "review"]);
    expect(view.overrideCount).toBe(0);
  });

  it("marks overridden steps and counts them", () => {
    const step = parentWith({
      overrides: { build: { agent: "codex", model: "gpt-5" } },
    }).phases[0]!.steps[0] as WorkflowCallStep;
    const view = describeSubWorkflow(step, resolve);
    expect(view.overrideCount).toBe(1);
    const build = view.steps.find((s) => s.id === "build");
    expect(build).toMatchObject({ overridden: true, agent: "codex", model: "gpt-5" });
    expect(view.steps.find((s) => s.id === "review")?.overridden).toBe(false);
  });

  it("flattens nested sub-workflows into the step view", () => {
    const step = {
      id: "call",
      kind: "workflow",
      workflow: "middle",
    } as WorkflowCallStep;
    const view = describeSubWorkflow(step, resolve);
    expect(view.steps.map((s) => s.path)).toEqual(["local", "inner", "inner::deep"]);
    expect(view.steps.find((s) => s.path === "inner::deep")?.depth).toBe(2);
  });

  it("produces a compact rollup string", () => {
    const step = parentWith({}).phases[0]!.steps[0] as WorkflowCallStep;
    const rollup = subWorkflowRollup(describeSubWorkflow(step, resolve));
    expect(rollup).toContain("child");
    expect(rollup).toContain("2 steps");
    expect(rollup).toContain("claude/sonnet");
  });
});

describe("workflow-call schema — overrides", () => {
  it("accepts an overrides map of partial agent patches", () => {
    const spec = {
      name: "w",
      phases: [
        {
          id: "p",
          title: "P",
          steps: [
            {
              id: "call",
              kind: "workflow",
              workflow: "child",
              overrides: { build: { agent: "codex", model: "gpt-5", effort: "high" } },
            },
          ],
        },
      ],
    };
    expect(workflowSpecSchema.safeParse(spec).success).toBe(true);
  });

  it("accepts null to remove a field", () => {
    const spec = {
      name: "w",
      phases: [
        {
          id: "p",
          title: "P",
          steps: [
            {
              id: "call",
              kind: "workflow",
              workflow: "child",
              overrides: { build: { effort: null } },
            },
          ],
        },
      ],
    };
    expect(workflowSpecSchema.safeParse(spec).success).toBe(true);
  });

  it("rejects an unknown field in an override patch", () => {
    const spec = {
      name: "w",
      phases: [
        {
          id: "p",
          title: "P",
          steps: [
            { id: "call", kind: "workflow", workflow: "child", overrides: { build: { bogus: 1 } } },
          ],
        },
      ],
    };
    expect(workflowSpecSchema.safeParse(spec).success).toBe(false);
  });
});
