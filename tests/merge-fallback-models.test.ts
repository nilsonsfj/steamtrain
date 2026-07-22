import { describe, expect, it } from "vitest";
import { mergeFallbackModels } from "../src/workflow/resolve-bindings";

describe("mergeFallbackModels", () => {
  it("returns step list unchanged when workflow has none", () => {
    expect(mergeFallbackModels(["sonnet 5"], undefined)).toEqual(["sonnet 5"]);
    expect(mergeFallbackModels(["sonnet 5"], [])).toEqual(["sonnet 5"]);
  });

  it("returns workflow list when step has none", () => {
    expect(mergeFallbackModels(undefined, ["haiku", "composer-2.5"])).toEqual([
      "haiku",
      "composer-2.5",
    ]);
    expect(mergeFallbackModels([], ["haiku"])).toEqual(["haiku"]);
  });

  it("appends workflow entries after step entries", () => {
    expect(mergeFallbackModels(["sonnet 5"], ["haiku", "composer-2.5"])).toEqual([
      "sonnet 5",
      "haiku",
      "composer-2.5",
    ]);
  });

  it("prefers the step spelling on case-insensitive collision", () => {
    expect(mergeFallbackModels(["Sonnet 5"], ["sonnet 5", "haiku"])).toEqual(["Sonnet 5", "haiku"]);
  });

  it("drops empty / whitespace-only entries", () => {
    expect(mergeFallbackModels(["sonnet 5", "  "], ["", "haiku"])).toEqual(["sonnet 5", "haiku"]);
  });

  it("returns undefined when both sides are empty after filtering", () => {
    expect(mergeFallbackModels(undefined, undefined)).toBeUndefined();
    expect(mergeFallbackModels(["  "], ["", "   "])).toBeUndefined();
  });
});
