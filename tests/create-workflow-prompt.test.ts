import { describe, expect, it } from "vitest";
import { createWorkflowPromptValue } from "../src/tui/create-workflow-prompt";

describe("createWorkflowPromptValue", () => {
  it("returns the bare command for an empty or whitespace seed", () => {
    expect(createWorkflowPromptValue("")).toBe("/create-workflow ");
    expect(createWorkflowPromptValue("   ")).toBe("/create-workflow ");
  });

  it("honors the create intent for a lone slash instead of stranding it", () => {
    expect(createWorkflowPromptValue("/")).toBe("/create-workflow ");
    expect(createWorkflowPromptValue("  /  ")).toBe("/create-workflow ");
  });

  it("wraps plain text as a /create-workflow description", () => {
    expect(createWorkflowPromptValue("build a release pipeline")).toBe(
      "/create-workflow build a release pipeline",
    );
  });

  it("trims surrounding whitespace from plain text", () => {
    expect(createWorkflowPromptValue("  audit deps  ")).toBe("/create-workflow audit deps");
  });

  it("leaves an in-progress /create-workflow command untouched (no double prefix)", () => {
    const seed = "/create-workflow build a release pipeline";
    expect(createWorkflowPromptValue(seed)).toBe(seed);
  });

  it("does not clobber an unrelated slash command", () => {
    const seed = "/model opencode/mimo-v2.6-flash-free";
    expect(createWorkflowPromptValue(seed)).toBe(seed);
  });
});
