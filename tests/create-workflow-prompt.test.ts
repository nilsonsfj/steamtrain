import { describe, expect, it } from "vitest";
import { createWorkflowPromptValue } from "../src/tui/create-workflow-prompt";

describe("createWorkflowPromptValue", () => {
  it("returns the bare command for an empty or whitespace seed", () => {
    expect(createWorkflowPromptValue("")).toBe("/createworkflow ");
    expect(createWorkflowPromptValue("   ")).toBe("/createworkflow ");
  });

  it("wraps plain text as a /createworkflow description", () => {
    expect(createWorkflowPromptValue("build a release pipeline")).toBe(
      "/createworkflow build a release pipeline",
    );
  });

  it("trims surrounding whitespace from plain text", () => {
    expect(createWorkflowPromptValue("  audit deps  ")).toBe("/createworkflow audit deps");
  });

  it("leaves an in-progress /createworkflow command untouched (no double prefix)", () => {
    const seed = "/createworkflow build a release pipeline";
    expect(createWorkflowPromptValue(seed)).toBe(seed);
  });

  it("does not clobber an unrelated slash command", () => {
    const seed = "/model opencode/mimo-v2.5-free";
    expect(createWorkflowPromptValue(seed)).toBe(seed);
  });
});
