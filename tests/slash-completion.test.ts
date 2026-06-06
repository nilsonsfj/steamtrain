import { describe, expect, it } from "vitest";
import {
  shouldApplySuggestionOnSubmit,
  shouldDismissSuggestionMenu,
  shouldSuppressWorkflowNavigation,
} from "../src/tui/slash-completion";

describe("slash-completion helpers", () => {
  const menu = ["version", "verbose"] as const;

  it("detects when Enter should apply a suggestion", () => {
    expect(shouldApplySuggestionOnSubmit(menu, "/ver")).toBe(true);
    expect(shouldApplySuggestionOnSubmit(menu, "hello")).toBe(false);
    expect(shouldApplySuggestionOnSubmit(["version"], "/ver")).toBe(false);
  });

  it("detects when Esc should dismiss the menu", () => {
    expect(shouldDismissSuggestionMenu(menu, "/ver")).toBe(true);
    expect(shouldDismissSuggestionMenu([], "/ver")).toBe(false);
  });

  it("detects when workflow navigation should be suppressed", () => {
    expect(shouldSuppressWorkflowNavigation(menu, "/model ")).toBe(true);
    expect(shouldSuppressWorkflowNavigation([], "/model ")).toBe(false);
  });
});
