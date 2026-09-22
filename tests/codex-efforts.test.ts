import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { fallbackCodexEfforts } from "../src/agents/codex-efforts-fallback";
import {
  clearCodexVariantCacheForTests,
  setCodexVariantCacheForTests,
} from "../src/agents/codex-variants";
import { effortsForModel } from "../src/agents/models";

describe("fallbackCodexEfforts", () => {
  it("returns live gpt-5.4 reasoning levels", () => {
    expect(fallbackCodexEfforts("gpt-5.4-mini")).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("returns sol/terra max+ultra and luna max from live agy-style catalogs", () => {
    expect(fallbackCodexEfforts("gpt-5.6-sol")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(fallbackCodexEfforts("gpt-5.6-terra")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(fallbackCodexEfforts("gpt-5.6-luna")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("returns broader openai reasoning levels for unknown gpt slugs", () => {
    expect(fallbackCodexEfforts("gpt-5")).toContain("minimal");
    expect(fallbackCodexEfforts("gpt-5")).toContain("none");
  });

  it("returns reasoning levels for retired gpt-5.1/5-codex slugs", () => {
    expect(fallbackCodexEfforts("gpt-5.1-codex")).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(fallbackCodexEfforts("gpt-5-codex")).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("returns no levels for unknown slugs", () => {
    expect(fallbackCodexEfforts("unknown-model")).toEqual([]);
  });
});

describe("effortsForModel codex cache", () => {
  beforeEach(() => {
    clearCodexVariantCacheForTests();
  });
  afterAll(() => {
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
    expect(effortsForModel("codex", "gpt-5.3-codex")).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });
});

describe("GPT-6 effort fallback", () => {
  it("mirrors codex debug models: astra/sol reach ultra, luna stops at max", () => {
    expect(fallbackCodexEfforts("gpt-6-astra")).toContain("ultra");
    expect(fallbackCodexEfforts("gpt-6-sol")).toContain("ultra");
    expect(fallbackCodexEfforts("gpt-6-luna")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});
