import { describe, expect, it } from "vitest";
import { renderPrompt } from "../src/workflow/template";

describe("iteration templating", () => {
  it("renders {{iteration}} from context, default 1", () => {
    expect(
      renderPrompt("pass {{iteration}}", { input: "", outputs: new Map(), iteration: 3 }),
    ).toBe("pass 3");
    expect(renderPrompt("pass {{iteration}}", { input: "", outputs: new Map() })).toBe("pass 1");
  });

  it("renders {{steps.<id>.iteration}} from a result", () => {
    const results = new Map([["g", { ok: true, iteration: 4 }]]);
    expect(
      renderPrompt("loop {{steps.g.iteration}}", { input: "", outputs: new Map(), results }),
    ).toBe("loop 4");
  });
});
