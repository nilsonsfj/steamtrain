import { describe, expect, it } from "vitest";
import {
  type WorkflowSpec,
  effectiveFallbackModelsForStep,
  fallbackModelsFromInputRefs,
  inputKeysReferencedInTemplate,
  mergeFallbackModelLists,
  resolveInputs,
  validateWorkflow,
} from "../src/workflow";

function makeSpec(inputs: WorkflowSpec["inputs"], extra?: Partial<WorkflowSpec>): WorkflowSpec {
  return {
    name: "test",
    inputs,
    phases: [
      {
        id: "p1",
        title: "P1",
        steps: [{ id: "s1", agent: "claude", model: "m", prompt: "x" }],
      },
    ],
    ...extra,
  };
}

describe("typed workflow inputs", () => {
  it("accepts model / agent / enum types in validateWorkflow", () => {
    const spec = makeSpec({
      coderModel: {
        type: "model",
        default: "opencode/mimo-v2.5-free",
        fallbackModels: ["opencode/deepseek-v4-flash-free"],
      },
      runner: { type: "agent", default: "opencode" },
      timing: { type: "enum", choices: ["live", "end"], default: "end" },
    });
    expect(validateWorkflow(spec)).toEqual({ ok: true });
  });

  it("rejects enum without choices", () => {
    const spec = makeSpec({ mode: { type: "enum", default: "a" } });
    const result = validateWorkflow(spec);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/enum/);
  });

  it("rejects fallbackModels on non-model types", () => {
    const bad = makeSpec({
      repo: { type: "string", description: "x" },
    });
    bad.inputs!.repo = {
      type: "string",
      fallbackModels: ["other"],
    };
    const result = validateWorkflow(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/fallbackModels/);
  });

  it("rejects default outside choices", () => {
    const spec = makeSpec({
      timing: { type: "enum", choices: ["live", "end"], default: "later" },
    });
    const result = validateWorkflow(spec);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/choices/);
  });

  it("resolves model and agent as strings", () => {
    const spec = makeSpec({
      coderModel: { type: "model" },
      runner: { type: "agent" },
    });
    const result = resolveInputs(spec, {
      coderModel: "opus 4.8",
      runner: "claude",
    });
    expect(result.errors).toEqual([]);
    expect(result.values).toEqual({ coderModel: "opus 4.8", runner: "claude" });
  });

  it("resolves enum against choices", () => {
    const spec = makeSpec({
      timing: { type: "enum", choices: ["live", "end"] },
    });
    expect(resolveInputs(spec, { timing: "live" }).values).toEqual({ timing: "live" });
    expect(resolveInputs(spec, { timing: "soon" }).errors[0]).toMatch(/one of/);
  });

  it("enforces optional choices on string/model inputs", () => {
    const spec = makeSpec({
      tier: { type: "model", choices: ["haiku", "sonnet"] },
    });
    expect(resolveInputs(spec, { tier: "sonnet" }).errors).toEqual([]);
    expect(resolveInputs(spec, { tier: "opus" }).errors[0]).toMatch(/one of/);
  });
});

describe("input-level fallbackModels", () => {
  it("extracts input keys from templates", () => {
    expect(inputKeysReferencedInTemplate("{{inputs.coderModel}}")).toEqual(["coderModel"]);
    expect(inputKeysReferencedInTemplate("use {{ inputs.a }} and {{inputs.b}}")).toEqual([
      "a",
      "b",
    ]);
    expect(inputKeysReferencedInTemplate("plain")).toEqual([]);
  });

  it("collects fallbackModels from referenced model inputs", () => {
    const inputs = {
      coderModel: {
        type: "model" as const,
        default: "mimo",
        fallbackModels: ["flash", "north"],
      },
      other: { type: "string" as const, default: "x" },
    };
    expect(fallbackModelsFromInputRefs(inputs, "{{inputs.coderModel}}")).toEqual([
      "flash",
      "north",
    ]);
    expect(fallbackModelsFromInputRefs(inputs, "{{inputs.other}}")).toBeUndefined();
    expect(fallbackModelsFromInputRefs(inputs, "static-model")).toBeUndefined();
  });

  it("merges input → step → workflow precedence", () => {
    expect(mergeFallbackModelLists(["input-a", "shared"], ["step-b", "shared"], ["wf-c"])).toEqual([
      "input-a",
      "shared",
      "step-b",
      "wf-c",
    ]);
  });

  it("builds effective chain for a templated step", () => {
    const spec = makeSpec(
      {
        coderModel: {
          type: "model",
          default: "mimo",
          fallbackModels: ["flash"],
        },
      },
      { fallbackModels: ["workflow-spare"] },
    );
    expect(
      effectiveFallbackModelsForStep(spec, {
        model: "{{inputs.coderModel}}",
        fallbackModels: ["step-spare"],
      }),
    ).toEqual(["flash", "step-spare", "workflow-spare"]);
  });
});
