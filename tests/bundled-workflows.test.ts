import { describe, expect, it } from "vitest";
import { OPENCODE_MODELS } from "../src/agents/opencode";
import { BUNDLED_WORKFLOWS } from "../src/workflow/bundled";
import { validateWorkflow } from "../src/workflow/types";
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

/**
 * `model: "{{inputs.<key>}}"` (building block 5 — templated model/effort)
 * can't be checked against the model literally; instead resolve it to the
 * workflow's own declared default for that input, which is what a keyless
 * `--param`-free run actually launches.
 */
function resolveTemplatedModel(spec: (typeof BUNDLED_WORKFLOWS)[string], model: string): string {
  const match = /^\{\{inputs\.([^}]+)\}\}$/.exec(model);
  if (!match) return model;
  const key = match[1] as string;
  const def = spec.inputs?.[key]?.default;
  return typeof def === "string" ? def : model;
}

describe("bundled workflows", () => {
  // Guards against the failure where bundled workflows referenced OpenCode free
  // models (qwen3.6-plus-free, minimax-m3-free) that OpenCode later removed,
  // so the steps died with "Model not found". A bundled opencode step must name
  // a model in our known catalog (or template to a default that does).
  it("only reference opencode models in the known catalog", () => {
    const known = new Set(OPENCODE_MODELS.map((m) => m.id));
    const unknown = agentTargets()
      .filter((t) => t.agent === "opencode")
      .map((t) => ({
        ...t,
        resolved: resolveTemplatedModel(BUNDLED_WORKFLOWS[t.workflow]!, t.model),
      }))
      .filter((t) => !known.has(t.resolved))
      .map((t) => `${t.workflow}/${t.step} → ${t.model} (resolved: ${t.resolved})`);
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

  // The `mainline`/`mainline-stream` `test`/`final-test` command steps embed
  // `{{inputs.testCmd}}` in `cmd` on purpose — running the user's declared
  // test command IS the step's job (mirrors `init`'s generated test-check
  // steps, which embed the same detected command as a literal; see the doc
  // comment above `mainlineStream` in bundled.ts). Every OTHER bundled
  // workflow, and every other step in these two, must validate with zero
  // warnings.
  const EXPECTED_CMD_WARNING =
    /is a command step whose cmd embeds template data \(\{\{inputs\.testCmd\}\}\)/;

  it("mainline and mainline-stream validate with only the declared testCmd warning", () => {
    for (const name of ["mainline", "mainline-stream"]) {
      const spec = BUNDLED_WORKFLOWS[name]!;
      const result = validateWorkflow(spec);
      expect(result.ok, `${name}: ${result.error ?? ""}`).toBe(true);
      expect(result.warnings, `${name} warnings`).toHaveLength(1);
      expect(result.warnings![0]).toMatch(EXPECTED_CMD_WARNING);
    }
  });

  it("declare model-typed inputs with catalog fallbackModels", () => {
    const known = new Set(OPENCODE_MODELS.map((m) => m.id));
    for (const name of ["mainline", "mainline-stream"]) {
      const spec = BUNDLED_WORKFLOWS[name]!;
      const modelInputs = Object.entries(spec.inputs ?? {}).filter(
        ([, inp]) => inp.type === "model",
      );
      expect(modelInputs.length, `${name} should declare model inputs`).toBeGreaterThan(0);
      for (const [key, inp] of modelInputs) {
        expect(inp.fallbackModels?.length, `${name}.${key} fallbackModels`).toBeGreaterThan(0);
        for (const fb of inp.fallbackModels ?? []) {
          expect(known.has(fb), `${name}.${key} fallback ${fb}`).toBe(true);
        }
        if (typeof inp.default === "string") {
          expect(known.has(inp.default), `${name}.${key} default ${inp.default}`).toBe(true);
        }
      }
    }
  });
});
