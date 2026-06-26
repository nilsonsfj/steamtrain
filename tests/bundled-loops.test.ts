import { describe, expect, it } from "vitest";
import { BUNDLED_WORKFLOWS } from "../src/workflow/bundled";
import { validateWorkflow } from "../src/workflow/types";

describe("bundled loop workflow", () => {
  it("ships a valid review-loop using a loop-back gate", () => {
    const wf = BUNDLED_WORKFLOWS["review-loop"];
    expect(wf).toBeDefined();
    expect(validateWorkflow(wf!)).toEqual({ ok: true });
  });
});
