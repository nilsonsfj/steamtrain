import { describe, expect, it } from "vitest";
import { renderPrompt } from "../src/workflow";

function ctx(input: string, outputs: Record<string, string> = {}) {
  return { input, outputs: new Map(Object.entries(outputs)) };
}

describe("renderPrompt", () => {
  it("substitutes {{input}} and {{args}} with the workflow input", () => {
    expect(renderPrompt("do {{input}} now", ctx("the task"))).toBe("do the task now");
    expect(renderPrompt("re: {{args}}", ctx("the task"))).toBe("re: the task");
  });

  it("substitutes {{steps.<id>.output}} with that step's output", () => {
    const out = renderPrompt("use {{steps.draft-a.output}}!", ctx("x", { "draft-a": "PLAN A" }));
    expect(out).toBe("use PLAN A!");
  });

  it("tolerates whitespace inside the braces", () => {
    expect(renderPrompt("{{  input  }}", ctx("hi"))).toBe("hi");
    expect(renderPrompt("{{ steps.a.output }}", ctx("x", { a: "OUT" }))).toBe("OUT");
  });

  it("renders a missing step output as an empty string", () => {
    expect(renderPrompt("[{{steps.unknown.output}}]", ctx("x"))).toBe("[]");
  });

  it("substitutes structured step fields", () => {
    const out = renderPrompt("{{steps.split.items}} {{steps.gate.ok}} {{steps.gate.target}}", {
      input: "x",
      outputs: new Map([["split", "a\nb"]]),
      results: new Map([
        ["split", { ok: true, items: ["a", "b"] }],
        ["gate", { ok: true, target: "ready" }],
      ]),
    });

    expect(out).toBe("a\nb true ready");
  });

  it("leaves unknown placeholders and stray braces untouched", () => {
    expect(renderPrompt("keep {{unknown}} and { single }", ctx("x"))).toBe(
      "keep {{unknown}} and { single }",
    );
  });

  it("substitutes every occurrence", () => {
    expect(renderPrompt("{{input}}-{{input}}", ctx("z"))).toBe("z-z");
  });
});
