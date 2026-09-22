import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  clearCodexVariantCacheForTests,
  setCodexVariantCacheForTests,
} from "../src/agents/codex-variants";
import {
  clearKimiVariantCacheForTests,
  setKimiVariantCacheForTests,
} from "../src/agents/kimi-variants";
import {
  clearMimoVariantCacheForTests,
  setMimoVariantCacheForTests,
} from "../src/agents/mimo-variants";
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
  it("exposes kiro-cli native model ids with claude-sonnet-5 as the default", () => {
    expect(modelIdsForAgent("kiro")).toEqual([
      "auto",
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-opus-4.8",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "claude-opus-4.7",
      "claude-opus-4.6",
      "claude-sonnet-4.6",
      "claude-opus-4.5",
      "claude-sonnet-4.5",
      "claude-sonnet-4",
      "claude-haiku-4.5",
      "deepseek-3.2",
      "minimax-m2.5",
      "minimax-m2.1",
      "glm-5",
      "qwen3-coder-next",
    ]);
    expect(defaultModelForAgent("kiro")).toBe("claude-sonnet-5");
    expect(modelNameForAgent("kiro", "claude-sonnet-5")).toBe("Claude Sonnet 5");
    expect(modelNameForAgent("kiro", "claude-haiku-4.5")).toBe("Claude Haiku 4.5");
    expect(modelNameForAgent("kiro", "auto")).toBe("Auto");
    // Claude short aliases are not valid kiro-cli model ids.
    expect(modelIdsForAgent("kiro")).not.toContain("haiku");
    expect(modelIdsForAgent("kiro")).not.toContain("sonnet");
    expect(modelIdsForAgent("kiro")).not.toContain("opus");
    expect(modelIdsForAgent("kiro")).not.toContain("claude-haiku-4-5");
  });

  it("reuses claude efforts for dotted kiro model ids", () => {
    expect(effortsForModel("kiro", "claude-sonnet-5")).toEqual(["low", "medium", "high", "max"]);
    expect(effortsForModel("kiro", "claude-opus-4.8")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(effortsForModel("kiro", "claude-opus-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(effortsForModel("kiro", "claude-haiku-4.5")).toEqual([]);
    expect(effortsForModel("kiro", "claude-sonnet-4")).toEqual([]);
    // Non-Claude Kiro models must not pick up Claude effort tables.
    expect(effortsForModel("kiro", "gpt-5.6-sol")).toEqual([]);
    expect(effortsForModel("kiro", "auto")).toEqual([]);
    expect(supportsEffort("kiro", "claude-sonnet-5")).toBe(true);
    expect(supportsEffort("kiro", "claude-haiku-4.5")).toBe(false);
  });

  it("keeps effort when switching kiro models only if supported", () => {
    expect(effortForModelChange("kiro", "claude-sonnet-5", "high")).toBe("high");
    expect(effortForModelChange("kiro", "claude-haiku-4.5", "high")).toBeUndefined();
  });
});

describe("mimo models", () => {
  it("exposes the Xiaomi MiMo Code catalog with MiMo Auto as the free default", () => {
    expect(modelIdsForAgent("mimo")).toEqual([
      "mimo/mimo-auto",
      "xiaomi/mimo-v2.5",
      "xiaomi/mimo-v2.5-pro",
      "xiaomi/mimo-v2.5-pro-ultraspeed",
    ]);
    expect(defaultModelForAgent("mimo")).toBe("mimo/mimo-auto");
    expect(modelNameForAgent("mimo", "mimo/mimo-auto")).toBe("MiMo Auto");
    expect(modelNameForAgent("mimo", "xiaomi/mimo-v2.5-pro")).toBe("MiMo-V2.5-Pro");
  });

  it("exposes low/medium/high efforts for built-in MiMo models", () => {
    expect(effortsForModel("mimo", "mimo/mimo-auto")).toEqual(["low", "medium", "high"]);
    expect(effortsForModel("mimo", "xiaomi/mimo-v2.5")).toEqual(["low", "medium", "high"]);
    expect(supportsEffort("mimo", "mimo/mimo-auto")).toBe(true);
  });
});

describe("kimi models", () => {
  it("exposes the Kimi Code catalog with K2.7 Coding as the default", () => {
    expect(modelIdsForAgent("kimi")).toEqual([
      "kimi-code/kimi-for-coding",
      "kimi-code/kimi-for-coding-highspeed",
      "kimi-code/k3",
      "kimi-code/k3-256k",
    ]);
    expect(defaultModelForAgent("kimi")).toBe("kimi-code/kimi-for-coding");
    expect(modelNameForAgent("kimi", "kimi-code/kimi-for-coding")).toBe("K2.7 Coding");
    expect(modelNameForAgent("kimi", "kimi-code/k3")).toBe("K3");
    expect(modelNameForAgent("kimi", "kimi-code/k3-256k")).toBe("K3-256k");
  });

  it("exposes low/high/max efforts for k3 aliases", () => {
    expect(effortsForModel("kimi", "kimi-code/k3")).toEqual(["low", "high", "max"]);
    expect(effortsForModel("kimi", "kimi-code/k3-256k")).toEqual(["low", "high", "max"]);
    expect(effortsForModel("kimi", "kimi-code/kimi-for-coding")).toEqual([]);
    expect(supportsEffort("kimi", "kimi-code/k3")).toBe(true);
    expect(supportsEffort("kimi", "kimi-code/k3-256k")).toBe(true);
    expect(supportsEffort("kimi", "kimi-code/kimi-for-coding")).toBe(false);
  });
});

describe("model names", () => {
  beforeEach(() => {
    clearCodexVariantCacheForTests();
    clearOpencodeVariantCacheForTests();
    clearMimoVariantCacheForTests();
    clearKimiVariantCacheForTests();
  });
  afterAll(() => {
    clearCodexVariantCacheForTests();
    clearOpencodeVariantCacheForTests();
    clearMimoVariantCacheForTests();
    clearKimiVariantCacheForTests();
  });

  it("returns hardcoded Claude display names", () => {
    expect(modelNameForAgent("claude", "claude-sonnet-4-6")).toBe("Claude Sonnet 4.6");
    expect(modelNameForAgent("claude", "sonnet")).toBe("Sonnet (latest)");
  });

  it("returns static Codex display names when cache is empty", () => {
    expect(modelNameForAgent("codex", "gpt-6-sol")).toBe("GPT-6 Sol");
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
        ["opencode/mimo-v2.6-flash-free", { name: "MiMo V2.6 Flash Free", efforts: [] }],
        ["deepseek/deepseek-chat", { name: "DeepSeek Chat", efforts: [] }],
        ["opencode/gpt-5.4-mini", { name: "GPT 5.4 Mini", efforts: ["high"] }],
      ]),
    );
    expect(modelIdsForAgent("opencode")).toEqual([
      "deepseek/deepseek-chat",
      "opencode/gpt-5.4-mini",
      "opencode/mimo-v2.6-flash-free",
    ]);
    expect(modelIdsForAgent("opencode")).not.toContain("opencode/big-pickle");
    expect(defaultModelForAgent("opencode")).toBe("opencode/mimo-v2.6-flash-free");
    clearOpencodeVariantCacheForTests();
  });

  it("prefers a free OpenCode model when the adapter default is absent from the live catalog", () => {
    setOpencodeVariantCacheForTests(
      new Map([
        [
          "opencode/nemotron-3.5-lightning-free",
          { name: "Nemotron 3.5 Lightning Free", efforts: [] },
        ],
        ["opencode/gpt-5.4-mini", { name: "GPT 5.4 Mini", efforts: ["high"] }],
      ]),
    );
    expect(defaultModelForAgent("opencode")).toBe("opencode/nemotron-3.5-lightning-free");
    clearOpencodeVariantCacheForTests();
  });

  it("ignores a configured defaultModel that is not in the live catalog", () => {
    setOpencodeVariantCacheForTests(
      new Map([
        ["opencode/ling-3.0-flash-fin-free", { name: "Ling 3.0 Flash Fin Free", efforts: [] }],
      ]),
    );
    expect(
      defaultModelForAgent("opencode", {
        agents: [{ id: "opencode", provider: "opencode", defaultModel: "opencode/ghost-model" }],
      }),
    ).toBe("opencode/ling-3.0-flash-fin-free");
    clearOpencodeVariantCacheForTests();
  });

  it("returns each adapter's defaultModel via PROVIDER_ADAPTERS", () => {
    expect(defaultModelForAgent("claude")).toBe("claude-sonnet-5");
    expect(defaultModelForAgent("codex")).toBe("gpt-5.5");
    expect(defaultModelForAgent("opencode")).toBe("opencode/mimo-v2.6-flash-free");
    expect(defaultModelForAgent("amp")).toBe("smart");
    expect(defaultModelForAgent("kiro")).toBe("claude-sonnet-5");
    expect(defaultModelForAgent("mimo")).toBe("mimo/mimo-auto");
    expect(defaultModelForAgent("kimi")).toBe("kimi-code/kimi-for-coding");
  });

  it("uses only the live MiMo catalog when cache is loaded", () => {
    setMimoVariantCacheForTests(
      new Map([
        ["mimo/mimo-auto", { name: "MiMo Auto", efforts: ["low", "medium", "high"] }],
        ["xiaomi/mimo-v2.5-pro", { name: "MiMo-V2.5-Pro (live)", efforts: ["high"] }],
      ]),
    );
    expect(modelIdsForAgent("mimo")).toEqual(["mimo/mimo-auto", "xiaomi/mimo-v2.5-pro"]);
    expect(modelNameForAgent("mimo", "xiaomi/mimo-v2.5-pro")).toBe("MiMo-V2.5-Pro (live)");
    expect(effortsForModel("mimo", "xiaomi/mimo-v2.5-pro")).toEqual(["high"]);
    expect(defaultModelForAgent("mimo")).toBe("mimo/mimo-auto");
    clearMimoVariantCacheForTests();
  });

  it("uses only the live Kimi catalog when cache is loaded", () => {
    setKimiVariantCacheForTests(
      new Map([
        ["kimi-code/kimi-for-coding", { name: "K2.7 Coding", efforts: [] }],
        ["kimi-code/k3", { name: "K3 (live)", efforts: ["low", "high", "max"] }],
      ]),
    );
    expect(modelIdsForAgent("kimi")).toEqual(["kimi-code/k3", "kimi-code/kimi-for-coding"]);
    expect(modelNameForAgent("kimi", "kimi-code/k3")).toBe("K3 (live)");
    expect(effortsForModel("kimi", "kimi-code/k3")).toEqual(["low", "high", "max"]);
    expect(defaultModelForAgent("kimi")).toBe("kimi-code/kimi-for-coding");
    clearKimiVariantCacheForTests();
  });

  it("falls back to the static OpenCode catalog when cache is empty", () => {
    expect(modelIdsForAgent("opencode")).toEqual(OPENCODE_MODELS.map((model) => model.id));
  });

  it("exposes id and name on catalog entries", () => {
    const claude = modelsForAgent("claude")[0];
    expect(claude).toEqual({ id: "claude-fable-5", name: "Claude Fable 5", group: "Current" });
  });

  it("includes display names in formatAgentTarget", () => {
    expect(formatAgentTarget({ agent: "claude", model: "claude-sonnet-4-6", effort: "high" })).toBe(
      "claude/Claude Sonnet 4.6 (claude-sonnet-4-6) · high",
    );
  });

  it("shortens antigravity to agy in formatAgentTarget", () => {
    expect(formatAgentTarget({ agent: "antigravity", model: "gemini-3.6-flash-high" })).toBe(
      "agy/Gemini 3.6 Flash (High) (gemini-3.6-flash-high)",
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
  it("returns opus 5 levels for claude-opus-5", () => {
    expect(effortsForModel("claude", "claude-opus-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(effortsForModel("claude", "opus")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

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

describe("antigravity models", () => {
  it("exposes antigravity models with Gemini 3.6 Flash (High) as the default", () => {
    expect(modelIdsForAgent("antigravity")).toContain("gemini-3.6-flash-high");
    expect(modelIdsForAgent("antigravity")).toContain("gemini-3.6-flash");
    expect(defaultModelForAgent("antigravity")).toBe("gemini-3.6-flash-high");
  });

  it("supports effort remapping only for models that accept slug efforts", () => {
    expect(effortsForModel("antigravity", "gemini-3.6-flash")).toEqual(["low", "medium", "high"]);
    expect(effortsForModel("antigravity", "gemini-3.1-pro")).toEqual(["low", "high"]);
    expect(effortsForModel("antigravity", "gemini-3.6-flash-high")).toEqual([]);
    expect(effortsForModel("antigravity", "Gemini 3.1 Pro (High)")).toEqual([]);
    expect(effortsForModel("antigravity", "claude-sonnet-4-6")).toEqual([]);
    expect(effortsForModel("antigravity", "claude-opus-4-6")).toEqual(["thinking"]);
    expect(effortsForModel("antigravity", "gpt-oss-120b")).toEqual(["medium"]);
  });

  it("keeps effort when switching antigravity models only if still supported", () => {
    expect(effortForModelChange("antigravity", "gemini-3.6-flash", "high")).toBe("high");
    expect(effortForModelChange("antigravity", "gemini-3.6-flash-high", "high")).toBeUndefined();
    expect(effortForModelChange("antigravity", "claude-sonnet-4-6", "medium")).toBeUndefined();
  });
});
