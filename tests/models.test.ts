import { describe, expect, it } from "vitest";
import { OPENCODE_MODELS } from "../src/agents/opencode";
import {
  defaultModelForAgent,
  effortForModelChange,
  effortsForModel,
  formatAgentTarget,
  formatModelDisplay,
  modelIdsForAgent,
  modelNameForAgent,
  modelsForAgent,
  supportsEffort,
} from "../src/agents/models";
import {
  clearOpencodeVariantCacheForTests,
  setOpencodeVariantCacheForTests,
} from "../src/agents/opencode-variants";

describe("model names", () => {
  it("returns hardcoded Claude display names", () => {
    expect(modelNameForAgent("claude", "claude-sonnet-4-6")).toBe("Claude Sonnet 4.6");
    expect(modelNameForAgent("claude", "sonnet")).toBe("Sonnet (latest)");
  });

  it("returns static OpenCode display names when cache is empty", () => {
    clearOpencodeVariantCacheForTests();
    expect(modelNameForAgent("opencode", "opencode/gpt-5.4-mini")).toBe("GPT 5.4 Mini");
  });

  it("prefers live OpenCode names from the variant cache", () => {
    setOpencodeVariantCacheForTests(
      new Map([["opencode-go/glm-5", { name: "GLM-5 (live)", efforts: [] }]]),
    );
    expect(modelNameForAgent("opencode", "opencode-go/glm-5")).toBe("GLM-5 (live)");
    clearOpencodeVariantCacheForTests();
  });

  it("uses only the live OpenCode catalog when cache is loaded", () => {
    setOpencodeVariantCacheForTests(
      new Map([
        ["deepseek/deepseek-chat", { name: "DeepSeek Chat", efforts: [] }],
        ["opencode/gpt-5.4-mini", { name: "GPT 5.4 Mini", efforts: ["high"] }],
      ]),
    );
    expect(modelIdsForAgent("opencode")).toEqual([
      "deepseek/deepseek-chat",
      "opencode/gpt-5.4-mini",
    ]);
    expect(modelIdsForAgent("opencode")).not.toContain("opencode/big-pickle");
    expect(defaultModelForAgent("opencode")).toBe("opencode/gpt-5.4-mini");
    clearOpencodeVariantCacheForTests();
  });

  it("falls back to the static OpenCode catalog when cache is empty", () => {
    clearOpencodeVariantCacheForTests();
    expect(modelIdsForAgent("opencode")).toEqual(OPENCODE_MODELS.map((model) => model.id));
  });

  it("exposes id and name on catalog entries", () => {
    const claude = modelsForAgent("claude")[0];
    expect(claude).toEqual({ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" });
  });

  it("includes display names in formatAgentTarget", () => {
    expect(formatAgentTarget({ agent: "claude", model: "claude-sonnet-4-6", effort: "high" })).toBe(
      "claude/Claude Sonnet 4.6 (claude-sonnet-4-6) · high",
    );
  });

  it("formats model display without agent prefix", () => {
    expect(
      formatModelDisplay({
        agent: "opencode",
        model: "opencode/deepseek-v4-flash",
      }),
    ).toBe("DeepSeek V4 Flash (opencode/deepseek-v4-flash)");
  });
});

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
    expect(effortForModelChange("claude", "claude-opus-4-7", "high")).toBe("high");
  });

  it("drops effort when unsupported on the new model", () => {
    expect(effortForModelChange("claude", "claude-sonnet-4-6", "xhigh")).toBeUndefined();
    expect(effortForModelChange("claude", "claude-haiku-4-5", "high")).toBeUndefined();
  });
});
