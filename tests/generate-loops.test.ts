import { describe, expect, it } from "vitest";
import { buildWorkflowGenerationPrompt } from "../src/workflow/generate";

describe("meta-prompt teaches loops", () => {
  it("mentions loop-back gates and stops telling models to unroll", () => {
    const p = buildWorkflowGenerationPrompt("review and fix until clean");
    expect(p).toMatch(/loopTo/);
    expect(p).toMatch(/maxIterations/);
    expect(p).not.toMatch(/Loops are NOT supported/);
  });
});
