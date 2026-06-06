import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import {
  CommandSuggestionMenu,
  suggestionMenuHeight,
  visibleSuggestionWindow,
} from "../src/tui/CommandSuggestionMenu";

describe("visibleSuggestionWindow", () => {
  it("shows the first page when selection is near the start", () => {
    expect(visibleSuggestionWindow(12, 0)).toEqual({ start: 0, count: 8 });
    expect(visibleSuggestionWindow(12, 3)).toEqual({ start: 0, count: 8 });
  });

  it("scrolls the window when selection moves past the visible page", () => {
    expect(visibleSuggestionWindow(12, 8)).toEqual({ start: 1, count: 8 });
    expect(visibleSuggestionWindow(12, 11)).toEqual({ start: 4, count: 8 });
  });

  it("handles exact page boundaries", () => {
    expect(visibleSuggestionWindow(8, 0)).toEqual({ start: 0, count: 8 });
    expect(visibleSuggestionWindow(9, 8)).toEqual({ start: 1, count: 8 });
  });
});

describe("suggestionMenuHeight", () => {
  it("returns zero for zero or one suggestion", () => {
    expect(suggestionMenuHeight(0)).toBe(0);
    expect(suggestionMenuHeight(1)).toBe(0);
  });

  it("includes border rows and hidden indicator", () => {
    expect(suggestionMenuHeight(3)).toBe(5);
    expect(suggestionMenuHeight(12, 11)).toBe(11);
  });
});

describe("CommandSuggestionMenu", () => {
  it("renders suggestions with the selected row highlighted", () => {
    const descriptions = new Map([
      ["version", "Print version"],
      ["exit", "Quit the TUI"],
    ]);
    const { lastFrame } = render(
      <CommandSuggestionMenu
        suggestions={["version", "exit", "model"]}
        selectedIndex={1}
        width={60}
        descriptions={descriptions}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("▶  exit");
    expect(frame).toContain("Quit the TUI");
    expect(frame).toContain("version");
    expect(frame).toContain("model");
  });

  it("highlights a selected item beyond the first visible page", () => {
    const suggestions = Array.from({ length: 10 }, (_, i) => `cmd-${i}`);
    const { lastFrame } = render(
      <CommandSuggestionMenu suggestions={suggestions} selectedIndex={9} width={40} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("▶  cmd-9");
    expect(frame).not.toContain("▶  cmd-0");
    expect(frame).toContain("… 2 more");
  });

  it("renders nothing for a single suggestion", () => {
    const { lastFrame } = render(
      <CommandSuggestionMenu suggestions={["version"]} selectedIndex={0} width={60} />,
    );
    expect(lastFrame()).toBe("");
  });
});
