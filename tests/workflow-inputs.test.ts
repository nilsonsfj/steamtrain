import { describe, expect, it } from "vitest";
import { renderPrompt } from "../src/workflow";
import { resolveInputs, validateWorkflow } from "../src/workflow/types";
import type { WorkflowSpec } from "../src/workflow/types";

function ctx(
  input: string,
  outputs: Record<string, string> = {},
  inputs?: Record<string, string | number | boolean>,
) {
  return { input, outputs: new Map(Object.entries(outputs)), inputs };
}

describe("renderPrompt with {{inputs.*}}", () => {
  it("substitutes {{inputs.key}} with the resolved value", () => {
    expect(renderPrompt("repo: {{inputs.repo}}", ctx("x", {}, { repo: "my-repo" }))).toBe(
      "repo: my-repo",
    );
  });

  it("substitutes numeric inputs as strings", () => {
    expect(renderPrompt("count: {{inputs.n}}", ctx("x", {}, { n: 42 }))).toBe("count: 42");
  });

  it("substitutes boolean inputs as strings", () => {
    expect(renderPrompt("flag: {{inputs.verbose}}", ctx("x", {}, { verbose: true }))).toBe(
      "flag: true",
    );
  });

  it("renders missing input as empty string", () => {
    expect(renderPrompt("[{{inputs.missing}}]", ctx("x"))).toBe("[]");
  });

  it("renders missing input as empty string when inputs object exists but key absent", () => {
    expect(renderPrompt("[{{inputs.missing}}]", ctx("x", {}, { other: "val" }))).toBe("[]");
  });

  it("handles multiple inputs in one template", () => {
    const out = renderPrompt("{{inputs.a}} and {{inputs.b}}", ctx("x", {}, { a: "foo", b: "bar" }));
    expect(out).toBe("foo and bar");
  });

  it("handles whitespace inside braces", () => {
    expect(renderPrompt("{{ inputs.key }}", ctx("x", {}, { key: "val" }))).toBe("val");
  });

  it("coexists with other template variables", () => {
    const out = renderPrompt(
      "{{input}} {{inputs.repo}} {{steps.a.output}}",
      ctx("task", { a: "out" }, { repo: "r" }),
    );
    expect(out).toBe("task r out");
  });
});

describe("resolveInputs", () => {
  const makeSpec = (inputs: Record<string, unknown>): WorkflowSpec => ({
    name: "test",
    inputs: inputs as WorkflowSpec["inputs"],
    phases: [
      { id: "p1", title: "P1", steps: [{ id: "s1", agent: "claude", model: "m", prompt: "x" }] },
    ],
  });

  it("resolves string input", () => {
    const spec = makeSpec({ repo: { type: "string" } });
    const result = resolveInputs(spec, { repo: "my-repo" });
    expect(result.errors).toEqual([]);
    expect(result.values).toEqual({ repo: "my-repo" });
  });

  it("resolves number input", () => {
    const spec = makeSpec({ count: { type: "number" } });
    const result = resolveInputs(spec, { count: "42" });
    expect(result.errors).toEqual([]);
    expect(result.values).toEqual({ count: 42 });
  });

  it("resolves boolean input (true variants)", () => {
    const spec = makeSpec({ verbose: { type: "boolean" } });
    for (const val of ["true", "1", "yes", "TRUE", "Yes"]) {
      const result = resolveInputs(spec, { verbose: val });
      expect(result.errors).toEqual([]);
      expect(result.values).toEqual({ verbose: true });
    }
  });

  it("resolves boolean input (false variants)", () => {
    const spec = makeSpec({ verbose: { type: "boolean" } });
    for (const val of ["false", "0", "no", "FALSE", "No"]) {
      const result = resolveInputs(spec, { verbose: val });
      expect(result.errors).toEqual([]);
      expect(result.values).toEqual({ verbose: false });
    }
  });

  it("uses default value when param is omitted", () => {
    const spec = makeSpec({ repo: { type: "string", default: "default-repo" } });
    const result = resolveInputs(spec, {});
    expect(result.errors).toEqual([]);
    expect(result.values).toEqual({ repo: "default-repo" });
  });

  it("uses default value when param is empty string", () => {
    const spec = makeSpec({ repo: { type: "string", default: "default-repo" } });
    const result = resolveInputs(spec, { repo: "" });
    expect(result.errors).toEqual([]);
    expect(result.values).toEqual({ repo: "default-repo" });
  });

  it("reports error for missing required input without default", () => {
    const spec = makeSpec({ repo: { type: "string" } });
    const result = resolveInputs(spec, {});
    expect(result.errors).toEqual(["missing required input 'repo'"]);
  });

  it("reports error for invalid number", () => {
    const spec = makeSpec({ count: { type: "number" } });
    const result = resolveInputs(spec, { count: "abc" });
    expect(result.errors).toEqual(["input 'count' expects a number, got 'abc'"]);
  });

  it("reports error for invalid boolean", () => {
    const spec = makeSpec({ verbose: { type: "boolean" } });
    const result = resolveInputs(spec, { verbose: "maybe" });
    expect(result.errors).toEqual(["input 'verbose' expects a boolean (true/false), got 'maybe'"]);
  });

  it("reports error for unknown input param", () => {
    const spec = makeSpec({});
    const result = resolveInputs(spec, { unknown: "val" });
    expect(result.errors).toEqual(["unknown input 'unknown' (not declared in workflow inputs)"]);
  });

  it("allows optional input (required: false, no default) to be omitted", () => {
    const spec = makeSpec({ opt: { type: "string", required: false } });
    const result = resolveInputs(spec, {});
    expect(result.errors).toEqual([]);
    expect(result.values).toEqual({});
  });

  it("resolves multiple inputs of different types", () => {
    const spec = makeSpec({
      name: { type: "string" },
      count: { type: "number" },
      verbose: { type: "boolean" },
    });
    const result = resolveInputs(spec, { name: "test", count: "5", verbose: "true" });
    expect(result.errors).toEqual([]);
    expect(result.values).toEqual({ name: "test", count: 5, verbose: true });
  });
});

describe("validateWorkflow with inputs", () => {
  const baseSpec: WorkflowSpec = {
    name: "test",
    phases: [
      { id: "p1", title: "P1", steps: [{ id: "s1", agent: "claude", model: "m", prompt: "x" }] },
    ],
  };

  it("accepts valid inputs", () => {
    const spec: WorkflowSpec = {
      ...baseSpec,
      inputs: { repo: { type: "string", description: "repo name" } },
    };
    expect(validateWorkflow(spec).ok).toBe(true);
  });

  it("rejects input name with invalid identifier characters", () => {
    const spec: WorkflowSpec = {
      ...baseSpec,
      inputs: { "bad name!": { type: "string" } },
    };
    const result = validateWorkflow(spec);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not a valid identifier");
  });

  it("rejects number default that is not a number", () => {
    const spec: WorkflowSpec = {
      ...baseSpec,
      inputs: { count: { type: "number", default: "abc" as unknown as number } },
    };
    const result = validateWorkflow(spec);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('declares type "number" but default is not a number');
  });

  it("rejects boolean default that is not a boolean", () => {
    const spec: WorkflowSpec = {
      ...baseSpec,
      inputs: { flag: { type: "boolean", default: "yes" as unknown as boolean } },
    };
    const result = validateWorkflow(spec);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('declares type "boolean" but default is not a boolean');
  });

  it("rejects string default that is not a string", () => {
    const spec: WorkflowSpec = {
      ...baseSpec,
      inputs: { name: { type: "string", default: 42 as unknown as string } },
    };
    const result = validateWorkflow(spec);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('declares type "string" but default is not a string');
  });

  it("accepts valid defaults for each type", () => {
    const spec: WorkflowSpec = {
      ...baseSpec,
      inputs: {
        s: { type: "string", default: "hello" },
        n: { type: "number", default: 42 },
        b: { type: "boolean", default: true },
      },
    };
    expect(validateWorkflow(spec).ok).toBe(true);
  });

  it("accepts inputs with hyphens in names", () => {
    const spec: WorkflowSpec = {
      ...baseSpec,
      inputs: { "my-input": { type: "string" } },
    };
    expect(validateWorkflow(spec).ok).toBe(true);
  });

  it("accepts inputs with underscores in names", () => {
    const spec: WorkflowSpec = {
      ...baseSpec,
      inputs: { my_input: { type: "string" } },
    };
    expect(validateWorkflow(spec).ok).toBe(true);
  });
});
