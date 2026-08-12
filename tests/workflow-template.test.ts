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

  it("falls back to output lines for a step that declared no items", () => {
    // `forEach` fans out over exactly these lines when the source step has no
    // `items` of its own (a `command` step listing PR numbers, say). Rendering
    // "" here instead is how babysit-all-prs printed "Open PRs considered:"
    // with nothing under it while fanning out over six PRs.
    const out = renderPrompt("{{steps.list.items}}", {
      input: "x",
      outputs: new Map([["list", "460\n457\n\n  436  \n"]]),
      results: new Map([["list", { ok: true }]]),
    });

    expect(out).toBe("460\n457\n436");
  });

  it("substitutes dynamic fan-out item fields", () => {
    const out = renderPrompt("{{item.index}} {{item}} {{item.sourceStepId}}", {
      input: "x",
      outputs: new Map(),
      item: { sourceStepId: "split", index: 2, value: "docs" },
    });

    expect(out).toBe("2 docs split");
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
