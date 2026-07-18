import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults";
import type { WorkflowSpec } from "../src/workflow";
import { applyWorkflowStepOverrides } from "../src/workflow/overrides";
import { formatReroutePlan, planAgentReroute } from "../src/workflow/reroute";

/** Mixed workflow: two opencode steps, one claude step, one llm step, one gate. */
const spec: WorkflowSpec = {
  name: "mixed",
  phases: [
    {
      id: "p1",
      title: "Phase 1",
      steps: [
        {
          id: "scan",
          agent: "opencode",
          model: "opencode/mimo-v2.5-free",
          prompt: "scan",
          effort: "high",
        },
        {
          id: "triage",
          kind: "llm",
          api: "anthropic",
          model: "claude-opus-4-8",
          prompt: "triage",
        } as WorkflowSpec["phases"][number]["steps"][number],
        { id: "gate1", kind: "gate", condition: { step: "scan", ok: true }, target: "p2" },
      ],
    },
    {
      id: "p2",
      title: "Phase 2",
      steps: [
        { id: "fix", agent: "opencode", model: "opencode/deepseek-v4-flash-free", prompt: "fix" },
        { id: "review", agent: "claude", model: "claude-sonnet-5", prompt: "review" },
      ],
    },
  ],
};

const ready = (agents: string[]) => (agent: string) => agents.includes(agent);

describe("planAgentReroute", () => {
  it("re-routes only blocked agent steps, skipping llm and gate steps", () => {
    const result = planAgentReroute(spec, DEFAULT_CONFIG, ready(["claude"]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.target).toBe("claude");
    expect(result.plan.blockedAgents).toEqual(["opencode"]);
    expect(result.plan.stepIds).toEqual(["scan", "fix"]);
    // The healthy claude step and the llm/gate steps carry no overrides.
    expect(Object.keys(result.plan.overrides)).toEqual(["scan", "fix"]);
  });

  it("prefers a ready agent the spec already uses over config order", () => {
    // Both claude and codex are ready; the spec already uses claude.
    const result = planAgentReroute(spec, DEFAULT_CONFIG, ready(["codex", "claude"]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.target).toBe("claude");
  });

  it("applies as step overrides: agent + default model, effort cleared", () => {
    const result = planAgentReroute(spec, DEFAULT_CONFIG, ready(["claude"]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const next = applyWorkflowStepOverrides(spec, result.plan.overrides);
    const scan = next.phases[0]!.steps[0] as { agent: string; model: string; effort?: string };
    expect(scan.agent).toBe("claude");
    expect(scan.model).toBe(result.plan.targetModel);
    expect(scan.effort).toBeUndefined();
    // Untouched: the already-ready claude step keeps its own model.
    expect(next.phases[1]!.steps[1]).toMatchObject({ agent: "claude", model: "claude-sonnet-5" });
  });

  it("returns { ok: false } without error when nothing is blocked", () => {
    const result = planAgentReroute(spec, DEFAULT_CONFIG, ready(["claude", "opencode"]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeUndefined();
  });

  it("errors when steps are blocked but no agent is ready", () => {
    const result = planAgentReroute(spec, DEFAULT_CONFIG, ready([]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no ready agent");
    expect(result.error).toContain("opencode");
  });

  it("validates an explicitly requested target", () => {
    const notReady = planAgentReroute(spec, DEFAULT_CONFIG, ready(["claude"]), {
      target: "codex",
    });
    expect(notReady.ok).toBe(false);
    if (notReady.ok) return;
    expect(notReady.error).toContain("codex");

    const unknown = planAgentReroute(spec, DEFAULT_CONFIG, ready(["claude"]), {
      target: "not-an-agent",
    });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error).toContain("not-an-agent");

    const okTarget = planAgentReroute(spec, DEFAULT_CONFIG, ready(["claude", "codex"]), {
      target: "codex",
    });
    expect(okTarget.ok).toBe(true);
    if (!okTarget.ok) return;
    expect(okTarget.plan.target).toBe("codex");
  });

  it("formats a one-line human summary", () => {
    const result = planAgentReroute(spec, DEFAULT_CONFIG, ready(["claude"]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const line = formatReroutePlan(result.plan);
    expect(line).toContain("2 steps");
    expect(line).toContain("opencode");
    expect(line).toContain("claude");
  });
});
