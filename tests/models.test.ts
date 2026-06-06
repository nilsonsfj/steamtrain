import { describe, expect, it } from "vitest";
import {
  effortForModelChange,
  effortsForModel,
  supportsEffort,
} from "../src/agents/models";

describe("effortsForModel claude", () => {
  it("returns opus 4.8 levels for claude-opus-4-8", () => {
    expect(effortsForModel("claude", "claude-opus-4-8")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("returns sonnet 4.6 levels without xhigh", () => {
    expect(effortsForModel("claude", "claude-sonnet-4-6")).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
  });

  it("returns no levels for haiku", () => {
    expect(effortsForModel("claude", "claude-haiku-4-5")).toEqual([]);
    expect(supportsEffort("claude", "claude-haiku-4-5")).toBe(false);
  });
});

describe("effortForModelChange", () => {
  it("keeps effort when still valid for the new model", () => {
    expect(
      effortForModelChange("claude", "claude-opus-4-7", "high"),
    ).toBe("high");
  });

  it("drops effort when unsupported on the new model", () => {
    expect(
      effortForModelChange("claude", "claude-sonnet-4-6", "xhigh"),
    ).toBeUndefined();
    expect(
      effortForModelChange("claude", "claude-haiku-4-5", "high"),
    ).toBeUndefined();
  });
});
