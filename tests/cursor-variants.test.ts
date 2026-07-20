import { describe, expect, it } from "vitest";
import { parseCursorListModels } from "../src/agents/cursor-variants";

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
});
