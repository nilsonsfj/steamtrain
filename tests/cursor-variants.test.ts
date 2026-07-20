import { afterEach, describe, expect, it } from "vitest";
import {
  clearCursorVariantCacheForTests,
  listCursorCachedAgentModels,
  parseCursorListModels,
  setCursorVariantCacheForTests,
} from "../src/agents/cursor-variants";

describe("parseCursorListModels", () => {
  it("parses id - name lines and skips the header", () => {
    const output = `Available models

auto - Auto (default)
composer-2.5 - Composer 2.5
cursor-grok-4.5-high - Cursor Grok 4.5
`;
    const map = parseCursorListModels(output);
    expect(map.get("auto")).toEqual({ name: "Auto (default)" });
    expect(map.get("composer-2.5")).toEqual({ name: "Composer 2.5" });
    expect(map.get("cursor-grok-4.5-high")).toEqual({ name: "Cursor Grok 4.5" });
  });

  it("returns empty map on garbage", () => {
    expect(parseCursorListModels("nope").size).toBe(0);
  });

  it("skips lines without an id - name separator and ignores pre-header lines", () => {
    const output = `noise before header
Available models
not-a-model-line
auto - Auto (default)

composer-2.5 -
gpt-5.2 - GPT 5.2 - Latest
`;
    const map = parseCursorListModels(output);
    expect(map.has("not-a-model-line")).toBe(false);
    expect(map.get("auto")).toEqual({ name: "Auto (default)" });
    // empty display name after separator is skipped
    expect(map.has("composer-2.5")).toBe(false);
    expect(map.get("gpt-5.2")).toEqual({ name: "GPT 5.2 - Latest" });
  });
});

describe("cursor variant cache helpers", () => {
  afterEach(() => {
    clearCursorVariantCacheForTests();
  });

  it("lists injected models and clears them", () => {
    expect(listCursorCachedAgentModels()).toEqual([]);
    setCursorVariantCacheForTests(
      new Map([
        ["auto", { name: "Auto (default)" }],
        ["composer-2.5", { name: "Composer 2.5" }],
      ]),
    );
    expect(listCursorCachedAgentModels()).toEqual([
      { id: "auto", name: "Auto (default)" },
      { id: "composer-2.5", name: "Composer 2.5" },
    ]);
    clearCursorVariantCacheForTests();
    expect(listCursorCachedAgentModels()).toEqual([]);
  });
});
