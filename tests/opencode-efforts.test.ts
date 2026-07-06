import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { effortsForModel } from "../src/agents/models";
import { fallbackOpencodeEfforts } from "../src/agents/opencode-efforts-fallback";
import {
  clearOpencodeVariantCacheForTests,
  setOpencodeVariantCacheForTests,
} from "../src/agents/opencode-variants";

describe("fallbackOpencodeEfforts", () => {
  it("returns openai reasoning levels for opencode gpt models", () => {
    expect(fallbackOpencodeEfforts("opencode/gpt-5.4-mini")).toContain("xhigh");
    expect(fallbackOpencodeEfforts("opencode/gpt-5.4-mini")).not.toContain("max");
  });

  it("returns anthropic variants for opencode claude models", () => {
    expect(fallbackOpencodeEfforts("opencode/claude-sonnet-4-6")).toEqual(["high", "max"]);
  });

  it("returns gemini levels for opencode gemini models", () => {
    expect(fallbackOpencodeEfforts("opencode/gemini-3.5-flash")).toEqual(["low", "high"]);
  });

  it("returns deepseek v4 levels including max", () => {
    expect(fallbackOpencodeEfforts("opencode-go/deepseek-v4-pro")).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
  });

  it("returns standard reasoning levels for openai-compatible go models", () => {
    expect(fallbackOpencodeEfforts("opencode-go/kimi-k2.6")).toEqual(["low", "medium", "high"]);
  });

  it("returns standard reasoning levels for qwen on opencode provider (M4)", () => {
    expect(fallbackOpencodeEfforts("opencode/qwen3.6-plus-free")).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(fallbackOpencodeEfforts("opencode/qwen-turbo")).toEqual(["low", "medium", "high"]);
  });

  it("returns standard reasoning levels for qwen on non-openai/anthropic/google providers", () => {
    expect(fallbackOpencodeEfforts("opencode/qwen-72b")).toEqual(["low", "medium", "high"]);
  });
});

describe("effortsForModel opencode cache", () => {
  beforeEach(() => {
    clearOpencodeVariantCacheForTests();
  });
  afterAll(() => {
    clearOpencodeVariantCacheForTests();
  });

  it("uses live variant cache when the model is present", () => {
    setOpencodeVariantCacheForTests(
      new Map([
        ["opencode-go/deepseek-v4-pro", { name: "DeepSeek V4 Pro", efforts: ["low", "max"] }],
      ]),
    );
    expect(effortsForModel("opencode", "opencode-go/deepseek-v4-pro")).toEqual(["low", "max"]);
  });

  it("returns empty when the cache explicitly lists no variants", () => {
    setOpencodeVariantCacheForTests(
      new Map([["opencode-go/glm-5", { name: "GLM-5", efforts: [] }]]),
    );
    expect(effortsForModel("opencode", "opencode-go/glm-5")).toEqual([]);
  });

  it("falls back to heuristics when the model is absent from cache", () => {
    setOpencodeVariantCacheForTests(
      new Map([
        ["opencode-go/deepseek-v4-pro", { name: "DeepSeek V4 Pro", efforts: ["low", "max"] }],
      ]),
    );
    expect(effortsForModel("opencode", "opencode-go/kimi-k2.6")).toEqual(["low", "medium", "high"]);
  });
});
