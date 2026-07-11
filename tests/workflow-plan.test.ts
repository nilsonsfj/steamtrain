import { describe, expect, it } from "vitest";
import { applyWorkflowSessionOverrides } from "../src/workflow/overrides";
import { planWorkflow } from "../src/workflow/plan";
import type { WorkflowSpec, WorkflowStep } from "../src/workflow/types";

function spec(overrides: Partial<WorkflowSpec> & { phases: WorkflowSpec["phases"] }): WorkflowSpec {
  return { name: "test", ...overrides };
}

function phase(id: string, steps: WorkflowStep[], title?: string): WorkflowSpec["phases"][number] {
  return { id, title: title ?? id, steps };
}

function worker(id: string, extra?: Record<string, unknown>): WorkflowStep {
  return {
    id,
    kind: "worker",
    agent: "claude",
    model: "sonnet",
    prompt: `do ${id}`,
    ...extra,
  } as unknown as WorkflowStep;
}

function command(id: string, cmd: string, extra?: Record<string, unknown>): WorkflowStep {
  return { id, kind: "command", cmd, ...extra } as unknown as WorkflowStep;
}

function distributor(id: string, items: string[], extra?: Record<string, unknown>): WorkflowStep {
  return { id, kind: "distributor", items, ...extra } as unknown as WorkflowStep;
}

function gate(
  id: string,
  condition: Record<string, unknown>,
  extra?: Record<string, unknown>,
): WorkflowStep {
  return { id, kind: "gate", condition, ...extra } as unknown as WorkflowStep;
}

describe("planWorkflow", () => {
  it("returns ok: false for invalid spec", () => {
    const result = planWorkflow(spec({ phases: [] }) as unknown as WorkflowSpec, "hello");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("produces a plan for a simple worker workflow", () => {
    const s = spec({
      phases: [phase("p1", [worker("w1")])],
    });
    const result = planWorkflow(s, "hello");
    expect(result.ok).toBe(true);
    expect(result.phaseCount).toBe(1);
    expect(result.staticStepCount).toBe(1);
    expect(result.agentCallCount).toBe(1);
    expect(result.deterministicCount).toBe(0);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.stepId).toBe("w1");
    expect(result.steps[0]!.kind).toBe("worker");
    expect(result.steps[0]!.isAgentBacked).toBe(true);
    expect(result.steps[0]!.agent).toBe("claude");
    expect(result.steps[0]!.model).toBe("sonnet");
    expect(result.steps[0]!.renderedPrompt).toBe("do w1");
  });

  it("renders {{input}} in prompts", () => {
    const s = spec({
      phases: [phase("p1", [worker("w1", { prompt: "review {{input}}" })])],
    });
    const result = planWorkflow(s, "fix the bug");
    expect(result.ok).toBe(true);
    expect(result.steps[0]!.renderedPrompt).toBe("review fix the bug");
  });

  it("renders {{inputs.*}} in prompts", () => {
    const s = spec({
      inputs: { target: { type: "string" } },
      phases: [phase("p1", [worker("w1", { prompt: "fix {{inputs.target}}" })])],
    });
    const result = planWorkflow(s, "hello", { target: "src/foo.ts" });
    expect(result.ok).toBe(true);
    expect(result.steps[0]!.renderedPrompt).toBe("fix src/foo.ts");
  });

  it("leaves {{steps.*}} as empty when no results exist", () => {
    const s = spec({
      phases: [
        phase("p1", [worker("w1")]),
        phase("p2", [worker("w2", { prompt: "review {{steps.w1.output}}" })]),
      ],
    });
    const result = planWorkflow(s, "hello");
    expect(result.ok).toBe(true);
    expect(result.steps[1]!.renderedPrompt).toBe("review ");
  });

  it("renders command step cmd templates", () => {
    const s = spec({
      phases: [phase("p1", [command("c1", "echo {{input}}")])],
    });
    const result = planWorkflow(s, "world");
    expect(result.ok).toBe(true);
    expect(result.steps[0]!.renderedPrompt).toBe("echo world");
    expect(result.steps[0]!.isDeterministic).toBe(true);
    expect(result.steps[0]!.kind).toBe("command");
  });

  it("analyzes static forEach", () => {
    const s = spec({
      phases: [
        phase("p1", [distributor("dist", ["a", "b", "c"])]),
        phase("p2", [worker("w1", { forEach: "steps.dist.items" })]),
      ],
    });
    const result = planWorkflow(s, "hello");
    expect(result.ok).toBe(true);
    expect(result.forEachSteps).toHaveLength(1);
    expect(result.forEachSteps[0]!.stepId).toBe("w1");
    expect(result.forEachSteps[0]!.count).toBe(3);
    expect(result.steps[1]!.forEachSource).toBe("dist");
    expect(result.steps[1]!.forEachCount).toBe(3);
  });

  it("analyzes agent-backed distributor as dynamic", () => {
    const s = spec({
      phases: [
        phase("p1", [
          {
            id: "dist",
            kind: "distributor",
            agent: "claude",
            model: "sonnet",
            prompt: "split",
          } as unknown as WorkflowStep,
        ]),
        phase("p2", [worker("w1", { forEach: "steps.dist.items" })]),
      ],
    });
    const result = planWorkflow(s, "hello");
    expect(result.ok).toBe(true);
    expect(result.forEachDynamicSteps).toHaveLength(1);
    expect(result.steps[1]!.forEachDynamic).toBe(true);
  });

  it("analyzes loop gates", () => {
    const s = spec({
      phases: [
        phase("p1", [worker("w1")]),
        phase("p2", [
          gate("g1", { step: "w1", contains: "fail" }, { loopTo: "p1", maxIterations: 5 }),
        ]),
      ],
    });
    const result = planWorkflow(s, "hello");
    expect(result.ok).toBe(true);
    expect(result.loopGates).toHaveLength(1);
    expect(result.loopGates[0]!.gateId).toBe("g1");
    expect(result.loopGates[0]!.loopTo).toBe("p1");
    expect(result.loopGates[0]!.maxIterations).toBe(5);
    expect(result.steps[1]!.loopTo).toBe("p1");
    expect(result.steps[1]!.maxIterations).toBe(5);
  });

  it("analyzes sub-workflow steps", () => {
    const s = spec({
      phases: [
        phase("p1", [
          { id: "wf1", kind: "workflow", workflow: "child-wf" } as unknown as WorkflowStep,
        ]),
      ],
    });
    const result = planWorkflow(s, "hello");
    expect(result.ok).toBe(true);
    expect(result.workflowSteps).toHaveLength(1);
    expect(result.workflowSteps[0]!.workflow).toBe("child-wf");
    expect(result.steps[0]!.workflowName).toBe("child-wf");
    // workflow steps invoke child workflows which may contain agent-backed steps,
    // so they are NOT deterministic.
    expect(result.steps[0]!.isDeterministic).toBe(false);
  });

  it("analyzes merge steps", () => {
    const s = spec({
      phases: [
        phase("p1", [worker("w1")]),
        phase("p2", [
          { id: "m1", kind: "merge", from: ["w1"], mode: "pr" } as unknown as WorkflowStep,
        ]),
      ],
    });
    const result = planWorkflow(s, "hello");
    expect(result.ok).toBe(true);
    expect(result.steps[1]!.mergeMode).toBe("pr");
    expect(result.steps[1]!.isDeterministic).toBe(true);
  });

  it("analyzes workspace inheritance", () => {
    const s = spec({
      phases: [
        phase("p1", [worker("w1")]),
        phase("p2", [worker("w2", { workspace: "inherit:w1" })]),
      ],
    });
    const result = planWorkflow(s, "hello");
    expect(result.ok).toBe(true);
    expect(result.steps[1]!.workspaceSource).toBe("w1");
  });

  it("analyzes artifacts", () => {
    const s = spec({
      phases: [phase("p1", [worker("w1", { artifacts: ["report.md", "coverage/"] })])],
    });
    const result = planWorkflow(s, "hello");
    expect(result.ok).toBe(true);
    expect(result.steps[0]!.artifacts).toEqual(["report.md", "coverage/"]);
  });

  it("analyzes gate conditions", () => {
    const s = spec({
      phases: [
        phase("p1", [worker("w1")]),
        phase("p2", [gate("g1", { step: "w1", contains: "pass", not: true })]),
      ],
    });
    const result = planWorkflow(s, "hello");
    expect(result.ok).toBe(true);
    expect(result.steps[1]!.gateCondition).toContain("step 'w1'");
    expect(result.steps[1]!.gateCondition).toContain('contains "pass"');
    expect(result.steps[1]!.gateCondition).toContain("(inverted)");
  });

  it("analyzes when conditions", () => {
    const s = spec({
      phases: [
        phase("p1", [worker("w1")]),
        phase("p2", [worker("w2", { when: { step: "w1", contains: "ok" } })]),
      ],
    });
    const result = planWorkflow(s, "hello");
    expect(result.ok).toBe(true);
    expect(result.steps[1]!.whenCondition).toContain("step 'w1'");
    expect(result.steps[1]!.whenCondition).toContain('contains "ok"');
  });

  it("lists distinct agents", () => {
    const s = spec({
      phases: [
        phase("p1", [
          worker("w1", { agent: "claude", model: "sonnet" }),
          worker("w2", { agent: "opencode", model: "gpt-4" }),
        ]),
      ],
    });
    const result = planWorkflow(s, "hello");
    expect(result.ok).toBe(true);
    expect(result.agents).toContain("claude");
    expect(result.agents).toContain("opencode");
    expect(result.agentCallCount).toBe(2);
  });

  it("respects maxCostUsd", () => {
    const s = spec({
      maxCostUsd: 5.0,
      phases: [phase("p1", [worker("w1")])],
    });
    const result = planWorkflow(s, "hello");
    expect(result.ok).toBe(true);
    expect(result.maxCostUsd).toBe(5.0);
  });

  it("reports template warnings", () => {
    const s = spec({
      phases: [phase("p1", [worker("w1", { prompt: "{{steps.typo.output}}" })])],
    });
    const result = planWorkflow(s, "hello");
    expect(result.ok).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBeGreaterThan(0);
    expect(result.warnings![0]).toContain("typo");
  });

  it("returns warnings for invalid spec", () => {
    const s = spec({
      phases: [phase("p1", [worker("w1", { prompt: "{{steps.missing.output}}" })])],
    });
    const result = planWorkflow(s, "hello");
    expect(result.ok).toBe(true);
    expect(result.warnings).toBeDefined();
  });

  it("handles multi-phase workflow", () => {
    const s = spec({
      phases: [
        phase("p1", [worker("w1")]),
        phase("p2", [command("c1", "npm test")]),
        phase("p3", [worker("w3", { prompt: "summarize {{input}}" })]),
      ],
    });
    const result = planWorkflow(s, "hello");
    expect(result.ok).toBe(true);
    expect(result.phaseCount).toBe(3);
    expect(result.staticStepCount).toBe(3);
    expect(result.agentCallCount).toBe(2);
    expect(result.deterministicCount).toBe(1);
    expect(result.steps[0]!.phaseId).toBe("p1");
    expect(result.steps[1]!.phaseId).toBe("p2");
    expect(result.steps[2]!.phaseId).toBe("p3");
  });

  it("handles consolidator steps", () => {
    const s = spec({
      phases: [
        phase("p1", [worker("w1"), worker("w2")]),
        phase("p2", [
          { id: "merge", kind: "consolidator", dependsOn: ["w1", "w2"] } as unknown as WorkflowStep,
        ]),
      ],
    });
    const result = planWorkflow(s, "hello");
    expect(result.ok).toBe(true);
    expect(result.steps[2]!.kind).toBe("consolidator");
    expect(result.steps[2]!.isDeterministic).toBe(true);
    expect(result.steps[2]!.dependsOn).toEqual(["w1", "w2"]);
  });

  it("handles consolidator with agent", () => {
    const s = spec({
      phases: [
        phase("p1", [worker("w1"), worker("w2")]),
        phase("p2", [
          {
            id: "merge",
            kind: "consolidator",
            dependsOn: ["w1", "w2"],
            agent: "claude",
            model: "sonnet",
            prompt: "merge results",
          } as unknown as WorkflowStep,
        ]),
      ],
    });
    const result = planWorkflow(s, "hello");
    expect(result.ok).toBe(true);
    expect(result.steps[2]!.isDeterministic).toBe(false);
    expect(result.steps[2]!.isAgentBacked).toBe(true);
  });

  it("renders workflow step input template", () => {
    const s = spec({
      phases: [
        phase("p1", [
          {
            id: "wf1",
            kind: "workflow",
            workflow: "child",
            input: "process {{input}}",
          } as unknown as WorkflowStep,
        ]),
      ],
    });
    const result = planWorkflow(s, "hello");
    expect(result.ok).toBe(true);
    expect(result.steps[0]!.renderedPrompt).toBe("process hello");
  });

  it("handles gate with onFalse", () => {
    const s = spec({
      phases: [
        phase("p1", [worker("w1")]),
        phase("p2", [gate("g1", { step: "w1", ok: true }, { onFalse: "fail" })]),
      ],
    });
    const result = planWorkflow(s, "hello");
    expect(result.ok).toBe(true);
    expect(result.steps[1]!.gateOnFalse).toBe("fail");
    expect(result.steps[1]!.gateCondition).toContain("ok = true");
  });

  it("handles empty input", () => {
    const s = spec({
      phases: [phase("p1", [worker("w1", { prompt: "hello" })])],
    });
    const result = planWorkflow(s, "");
    expect(result.ok).toBe(true);
    expect(result.steps[0]!.renderedPrompt).toBe("hello");
  });
});

describe("planWorkflow with session overrides", () => {
  function planWithOverrides(
    base: WorkflowSpec,
    overrides: Parameters<typeof applyWorkflowSessionOverrides>[1],
    input = "hello",
    params?: Record<string, string | number | boolean>,
  ) {
    const effective = applyWorkflowSessionOverrides(base, overrides);
    return planWorkflow(effective, input, params);
  }

  it("reflects overridden agent and model in plan steps and agents list", () => {
    const s = spec({
      phases: [
        phase("p1", [
          worker("w1", { agent: "claude", model: "sonnet" }),
          worker("w2", { agent: "claude", model: "sonnet", prompt: "second" }),
        ]),
      ],
    });
    const result = planWithOverrides(s, {
      steps: {
        w1: { agent: "codex", model: "gpt-5.5" },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.steps[0]!.agent).toBe("codex");
    expect(result.steps[0]!.model).toBe("gpt-5.5");
    expect(result.steps[1]!.agent).toBe("claude");
    expect(result.steps[1]!.model).toBe("sonnet");
    expect(result.agents).toEqual(["codex", "claude"]);
  });

  it("reflects overridden effort in plan steps", () => {
    const s = spec({
      phases: [phase("p1", [worker("w1", { effort: "high" })])],
    });
    const result = planWithOverrides(s, {
      steps: { w1: { effort: "low" } },
    });
    expect(result.ok).toBe(true);
    expect(result.steps[0]!.effort).toBe("low");
  });

  it("reflects overridden prompt in renderedPrompt", () => {
    const s = spec({
      phases: [phase("p1", [worker("w1", { prompt: "original {{input}}" })])],
    });
    const result = planWithOverrides(
      s,
      { steps: { w1: { prompt: "overridden {{input}}" } } },
      "world",
    );
    expect(result.ok).toBe(true);
    expect(result.steps[0]!.renderedPrompt).toBe("overridden world");
  });

  it("clears effort when override sets null", () => {
    const s = spec({
      phases: [phase("p1", [worker("w1", { effort: "high" })])],
    });
    const result = planWithOverrides(s, {
      steps: { w1: { effort: null as unknown as string | undefined } },
    });
    expect(result.ok).toBe(true);
    expect(result.steps[0]!.effort).toBeUndefined();
  });

  it("accepts legacy flat step maps (TUI / web staged overrides)", () => {
    const s = spec({
      phases: [phase("p1", [worker("w1", { agent: "claude", model: "sonnet" })])],
    });
    const result = planWithOverrides(s, {
      w1: { agent: "opencode", model: "gpt-4" },
    });
    expect(result.ok).toBe(true);
    expect(result.steps[0]!.agent).toBe("opencode");
    expect(result.steps[0]!.model).toBe("gpt-4");
    expect(result.agents).toEqual(["opencode"]);
  });

  it("reflects llm step model/prompt/effort overrides without agent leakage", () => {
    const s = spec({
      phases: [
        phase("p1", [
          {
            id: "judge",
            kind: "llm",
            model: "claude-opus-4-8",
            prompt: "old {{input}}",
            effort: "high",
          } as unknown as WorkflowStep,
        ]),
      ],
    });
    const result = planWithOverrides(
      s,
      {
        steps: {
          judge: {
            model: "claude-haiku-4-5",
            prompt: "new {{input}}",
            effort: "low",
            agent: "claude",
          },
        },
      },
      "case",
    );
    expect(result.ok).toBe(true);
    expect(result.llmCallCount).toBe(1);
    expect(result.agentCallCount).toBe(0);
    const judge = result.steps[0]!;
    expect(judge.kind).toBe("llm");
    expect(judge.model).toBe("claude-haiku-4-5");
    expect(judge.effort).toBe("low");
    expect(judge.renderedPrompt).toBe("new case");
    expect(judge.isAgentBacked).toBe(false);
  });

  it("ignores overrides for non-agent-backed steps", () => {
    const s = spec({
      phases: [
        phase("p1", [command("c1", "echo hi")]),
      ],
    });
    const result = planWithOverrides(s, {
      steps: { c1: { agent: "codex", model: "gpt-5.5", prompt: "ignored" } },
    });
    expect(result.ok).toBe(true);
    expect(result.steps[0]!.kind).toBe("command");
    expect(result.steps[0]!.agent).toBeUndefined();
    expect(result.agentCallCount).toBe(0);
    expect(result.deterministicCount).toBe(1);
  });
});
