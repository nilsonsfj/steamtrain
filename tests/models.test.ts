import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  clearCodexVariantCacheForTests,
  setCodexVariantCacheForTests,
} from "../src/agents/codex-variants";
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
import { OPENCODE_MODELS } from "../src/agents/opencode";
import {
  clearOpencodeVariantCacheForTests,
  setOpencodeVariantCacheForTests,
} from "../src/agents/opencode-variants";

describe("amp modes", () => {
  it("exposes the three amp modes with smart as the default", () => {
    expect(modelIdsForAgent("amp")).toEqual(["smart", "deep", "rush"]);
    expect(defaultModelForAgent("amp")).toBe("smart");
    expect(modelNameForAgent("amp", "deep")).toBe("Deep (extended reasoning)");
  });

  it("maps reasoning efforts per mode", () => {
    expect(effortsForModel("amp", "deep")).toEqual(["low", "medium", "xhigh"]);
    expect(effortsForModel("amp", "smart")).toEqual(["high", "xhigh", "max"]);
    expect(effortsForModel("amp", "rush")).toEqual([]);
    expect(supportsEffort("amp", "smart")).toBe(true);
    expect(supportsEffort("amp", "rush")).toBe(false);
  });

  it("drops an effort that the next mode does not support", () => {
    expect(effortForModelChange("amp", "smart", "max")).toBe("max");
    expect(effortForModelChange("amp", "deep", "max")).toBeUndefined();
    expect(effortForModelChange("amp", "rush", "high")).toBeUndefined();
  });
});

describe("kiro models", () => {
  it("exposes kiro models with sonnet as the default", () => {
    expect(modelIdsForAgent("kiro")).toEqual([
      "sonnet",
      "opus",
      "haiku",
      "claude-sonnet-5",
      "claude-opus-4-8",
      "claude-haiku-4-5",
    ]);
    expect(defaultModelForAgent("kiro")).toBe("sonnet");
    expect(modelNameForAgent("kiro", "sonnet")).toBe("Sonnet (latest)");
    expect(modelNameForAgent("kiro", "claude-sonnet-5")).toBe("Claude Sonnet 5");
  });

  it("reuses claude efforts for kiro models", () => {
    expect(effortsForModel("kiro", "sonnet")).toEqual(["low", "medium", "high", "max"]);
    expect(effortsForModel("kiro", "opus")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortsForModel("kiro", "haiku")).toEqual([]);
    expect(supportsEffort("kiro", "sonnet")).toBe(true);
    expect(supportsEffort("kiro", "haiku")).toBe(false);
  });

  it("keeps effort when switching kiro models only if supported", () => {
    expect(effortForModelChange("kiro", "sonnet", "high")).toBe("high");
    expect(effortForModelChange("kiro", "haiku", "high")).toBeUndefined();
  });
});

describe("model names", () => {
  beforeEach(() => {
    clearCodexVariantCacheForTests();
    clearOpencodeVariantCacheForTests();
  });
  afterAll(() => {
    clearCodexVariantCacheForTests();
    clearOpencodeVariantCacheForTests();
  });

  it("returns hardcoded Claude display names", () => {
    expect(modelNameForAgent("claude", "claude-sonnet-4-6")).toBe("Claude Sonnet 4.6");
    expect(modelNameForAgent("claude", "sonnet")).toBe("Sonnet (latest)");
  });

  it("returns static Codex display names when cache is empty", () => {
    expect(modelNameForAgent("codex", "gpt-5.4-mini")).toBe("GPT-5.4 Mini");
  });

  it("prefers live Codex names from the variant cache", () => {
    setCodexVariantCacheForTests(
      new Map([["gpt-5.5", { name: "GPT-5.5 (live)", efforts: ["high"] }]]),
    );
    expect(modelNameForAgent("codex", "gpt-5.5")).toBe("GPT-5.5 (live)");
    clearCodexVariantCacheForTests();
  });

  it("uses only the live Codex catalog when cache is loaded", () => {
    setCodexVariantCacheForTests(
      new Map([
        ["gpt-5.5", { name: "GPT-5.5", efforts: ["high"] }],
        ["gpt-5.4-mini", { name: "GPT-5.4 Mini", efforts: ["low"] }],
      ]),
    );
    expect(modelIdsForAgent("codex")).toEqual(["gpt-5.4-mini", "gpt-5.5"]);
    expect(defaultModelForAgent("codex")).toBe("gpt-5.5");
    clearCodexVariantCacheForTests();
  });

  it("falls back to the first cached Codex model when the static default is absent", () => {
    setCodexVariantCacheForTests(
      new Map([["gpt-5.4-mini", { name: "GPT-5.4 Mini", efforts: ["low"] }]]),
    );
    expect(defaultModelForAgent("codex")).toBe("gpt-5.4-mini");
    clearCodexVariantCacheForTests();
  });

  it("returns static OpenCode display names when cache is empty", () => {
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
        ["opencode/mimo-v2.5-free", { name: "MiMo V2.5 Free", efforts: [] }],
        ["deepseek/deepseek-chat", { name: "DeepSeek Chat", efforts: [] }],
        ["opencode/gpt-5.4-mini", { name: "GPT 5.4 Mini", efforts: ["high"] }],
      ]),
    );
    expect(modelIdsForAgent("opencode")).toEqual([
      "deepseek/deepseek-chat",
      "opencode/gpt-5.4-mini",
      "opencode/mimo-v2.5-free",
    ]);
    expect(modelIdsForAgent("opencode")).not.toContain("opencode/big-pickle");
    expect(defaultModelForAgent("opencode")).toBe("opencode/mimo-v2.5-free");
    clearOpencodeVariantCacheForTests();
  });

  it("returns each adapter's defaultModel via PROVIDER_ADAPTERS", () => {
    expect(defaultModelForAgent("claude")).toBe("claude-sonnet-5");
    expect(defaultModelForAgent("codex")).toBe("gpt-5.5");
    expect(defaultModelForAgent("opencode")).toBe("opencode/mimo-v2.5-free");
    expect(defaultModelForAgent("amp")).toBe("smart");
    expect(defaultModelForAgent("kiro")).toBe("sonnet");
  });

  it("falls back to the static OpenCode catalog when cache is empty", () => {
    expect(modelIdsForAgent("opencode")).toEqual(OPENCODE_MODELS.map((model) => model.id));
  });

  it("exposes id and name on catalog entries", () => {
    const claude = modelsForAgent("claude")[0];
    expect(claude).toEqual({ id: "claude-fable-5", name: "Claude Fable 5" });
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

describe("cursor models", () => {
  it("exposes cursor models with composer-2.5 as the default", () => {
    expect(modelIdsForAgent("cursor")).toContain("composer-2.5");
    expect(modelIdsForAgent("cursor")).toContain("auto");
    expect(defaultModelForAgent("cursor")).toBe("composer-2.5");
  });

  it("supports bracket efforts for cursor when model has no effort=", () => {
    expect(effortsForModel("cursor", "composer-2.5")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(effortsForModel("cursor", "composer-2.5[effort=high]")).toEqual([]);
  });

  it("keeps effort when switching cursor models only if still supported", () => {
    expect(effortForModelChange("cursor", "composer-2.5", "high")).toBe("high");
    expect(effortForModelChange("cursor", "composer-2.5[effort=high]", "high")).toBeUndefined();
  });
});
