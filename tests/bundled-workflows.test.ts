import { describe, expect, it } from "vitest";
import { OPENCODE_MODELS } from "../src/agents/opencode";
import { BUNDLED_WORKFLOWS } from "../src/workflow/bundled";
import type { WorkflowStep } from "../src/workflow/types";

/** Every (agent, model) pair an agent-backed step in a bundled workflow uses. */
function agentTargets(): { workflow: string; step: string; agent: string; model: string }[] {
  const targets: { workflow: string; step: string; agent: string; model: string }[] = [];
  for (const [workflow, spec] of Object.entries(BUNDLED_WORKFLOWS)) {
    for (const phase of spec.phases) {
      for (const step of phase.steps as WorkflowStep[]) {
        const agent = "agent" in step ? step.agent : undefined;
        const model = "model" in step ? step.model : undefined;
        if (agent && model) targets.push({ workflow, step: step.id, agent, model });
      }
    }
  }
  return targets;
}

describe("bundled workflows", () => {
  // Guards against the failure where bundled workflows referenced OpenCode free
  // models (qwen3.6-plus-free, minimax-m3-free) that OpenCode later removed,
  // so the steps died with "Model not found". A bundled opencode step must name
  // a model in our known catalog.
  it("only reference opencode models in the known catalog", () => {
    const known = new Set(OPENCODE_MODELS.map((m) => m.id));
    const unknown = agentTargets()
      .filter((t) => t.agent === "opencode" && !known.has(t.model))
      .map((t) => `${t.workflow}/${t.step} → ${t.model}`);
    expect(unknown).toEqual([]);
  });

  it("give each parallel agent step in a phase a distinct model", () => {
    for (const [workflow, spec] of Object.entries(BUNDLED_WORKFLOWS)) {
      for (const phase of spec.phases) {
        const models = (phase.steps as WorkflowStep[])
          .filter((s): s is WorkflowStep & { model: string } => "model" in s && !!s.model)
          .map((s) => s.model);
        if (models.length < 2) continue;
        expect(new Set(models).size, `${workflow}/${phase.id} reuses a model in parallel`).toBe(
          models.length,
        );
      }
    }
  });
});
