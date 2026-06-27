import { beforeEach, describe, expect, it } from "vitest";
import { fallbackCodexEfforts } from "../src/agents/codex-efforts-fallback";
import {
  clearCodexVariantCacheForTests,
  setCodexVariantCacheForTests,
} from "../src/agents/codex-variants";
import { effortsForModel } from "../src/agents/models";

describe("fallbackCodexEfforts", () => {
  it("returns gpt-5.4 reasoning levels", () => {
    expect(fallbackCodexEfforts("gpt-5.4-mini")).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"]);
  });

  it("returns broader openai reasoning levels for unknown gpt slugs", () => {
    expect(fallbackCodexEfforts("gpt-5")).toContain("minimal");
    expect(fallbackCodexEfforts("gpt-5")).toContain("none");
  });

  it("returns no levels for unknown slugs", () => {
    expect(fallbackCodexEfforts("unknown-model")).toEqual([]);
  });
});

describe("effortsForModel codex cache", () => {
  beforeEach(() => {
    clearCodexVariantCacheForTests();
  });

  it("uses live variant cache when the model is present", () => {
    setCodexVariantCacheForTests(
      new Map([["gpt-5.4-mini", { name: "GPT-5.4 Mini", efforts: ["low", "max"] }]]),
    );
    expect(effortsForModel("codex", "gpt-5.4-mini")).toEqual(["low", "max"]);
  });

  it("falls back to heuristics when the model is absent from cache", () => {
    setCodexVariantCacheForTests(
      new Map([["gpt-5.4-mini", { name: "GPT-5.4 Mini", efforts: ["low", "max"] }]]),
    );
    expect(effortsForModel("codex", "gpt-5.3-codex")).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"]);
  });
});
