import { describe, expect, it } from "vitest";
import {
  AGENT_PREFERENCE_ORDER,
  clearModelFamilyCacheForTests,
  compactModelQuery,
  familyForProviderModel,
  findModelFamily,
  nativeModelForProvider,
  normalizeModelQuery,
  resolveEffortForBinding,
  resolveModelBinding,
} from "../src/agents";
import { DEFAULT_CONFIG } from "../src/config/defaults";
import type { WorkflowSpec } from "../src/workflow";
import { resolveWorkflowBindings, validateWorkflow } from "../src/workflow";

describe("normalizeModelQuery", () => {
  it("collapses spacing, case, and punctuation", () => {
    expect(normalizeModelQuery("  Opus 4.8 ")).toBe("opus 4.8");
    expect(normalizeModelQuery("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(normalizeModelQuery("opencode/claude-opus-4-8")).toBe("opencode-claude-opus-4-8");
    expect(compactModelQuery("Opus 4.8")).toBe("opus48");
  });

  it("handles empty and punctuation-only input without throwing", () => {
    expect(normalizeModelQuery("")).toBe("");
    expect(normalizeModelQuery("   ")).toBe("");
    expect(normalizeModelQuery("!!!")).toBe("!!!");
    expect(compactModelQuery("!!!")).toBe("!!!");
    expect(() => findModelFamily("!!!")).not.toThrow();
  });
});

describe("findModelFamily", () => {
  it("matches friendly aliases to Claude Opus 4.8", () => {
    clearModelFamilyCacheForTests();
    const family = findModelFamily("opus 4.8");
    expect(family?.id).toBe("claude-opus-4.8");
    expect(family?.offerings.some((o) => o.provider === "claude" && o.reference)).toBe(true);
    expect(family?.offerings.some((o) => o.provider === "opencode")).toBe(true);
  });

  it("matches GPT aliases to the codex reference", () => {
    const family = findModelFamily("gpt-5.5");
    expect(family?.id).toBe("gpt-5.5");
    expect(family?.offerings[0]?.provider).toBe("codex");
    expect(family?.offerings[0]?.reference).toBe(true);
  });

  it("maps sonnet to Claude Sonnet 5", () => {
    expect(findModelFamily("sonnet")?.id).toBe("claude-sonnet-5");
  });
});

describe("nativeModelForProvider", () => {
  it("translates a family alias onto each provider's native id", () => {
    expect(nativeModelForProvider("claude", "opus 4.8")).toBe("claude-opus-4-8");
    expect(nativeModelForProvider("opencode", "opus 4.8")).toBe("opencode/claude-opus-4-8");
    expect(nativeModelForProvider("codex", "gpt 5.5")).toBe("gpt-5.5");
  });

  it("maps Claude aliases onto kiro-cli dotted ids (not short aliases)", () => {
    clearModelFamilyCacheForTests();
    expect(nativeModelForProvider("kiro", "haiku")).toBe("claude-haiku-4.5");
    expect(nativeModelForProvider("kiro", "sonnet")).toBe("claude-sonnet-5");
    expect(nativeModelForProvider("kiro", "opus")).toBe("claude-opus-4.8");
    expect(nativeModelForProvider("kiro", "claude-haiku-4-5")).toBe("claude-haiku-4.5");
    expect(nativeModelForProvider("kiro", "claude-opus-4-8")).toBe("claude-opus-4.8");
  });

  it("maps aliases onto mimo's Xiaomi catalog ids", () => {
    clearModelFamilyCacheForTests();
    expect(nativeModelForProvider("mimo", "mimo auto")).toBe("mimo/mimo-auto");
    expect(nativeModelForProvider("mimo", "mimo-v2.5-pro")).toBe("xiaomi/mimo-v2.5-pro");
    expect(nativeModelForProvider("mimo", "mimo-v2.5")).toBe("xiaomi/mimo-v2.5");
    // Claude/GPT aliases are not offered on the mimo agent.
    expect(nativeModelForProvider("mimo", "sonnet")).toBeUndefined();
    expect(nativeModelForProvider("mimo", "gpt-5.5")).toBeUndefined();
  });

  it("resolves the MiMo Auto default model back to its family", () => {
    clearModelFamilyCacheForTests();
    expect(nativeModelForProvider("mimo", "mimo-auto")).toBe("mimo/mimo-auto");
    expect(familyForProviderModel("mimo", "mimo/mimo-auto")?.id).toBe("mimo-auto");
    expect(familyForProviderModel("mimo", "xiaomi/mimo-v2.5-pro")?.id).toBe("mimo-v2.5-pro");
  });

  it("maps aliases onto kimi's Kimi Code catalog ids", () => {
    clearModelFamilyCacheForTests();
    expect(nativeModelForProvider("kimi", "kimi k3")).toBe("kimi-code/k3");
    expect(nativeModelForProvider("kimi", "kimi-k2.7-code")).toBe("kimi-code/kimi-for-coding");
    expect(nativeModelForProvider("kimi", "kimi highspeed")).toBe(
      "kimi-code/kimi-for-coding-highspeed",
    );
    // Claude/GPT aliases are not offered on the kimi agent.
    expect(nativeModelForProvider("kimi", "sonnet")).toBeUndefined();
    expect(nativeModelForProvider("kimi", "gpt-5.5")).toBeUndefined();
  });

  it("resolves the K2.7 Coding default model back to its family", () => {
    clearModelFamilyCacheForTests();
    expect(nativeModelForProvider("kimi", "kimi-for-coding")).toBe("kimi-code/kimi-for-coding");
    expect(familyForProviderModel("kimi", "kimi-code/kimi-for-coding")?.id).toBe("kimi-k2.7-code");
    expect(familyForProviderModel("kimi", "kimi-code/k3")?.id).toBe("kimi-k3");
  });
});

describe("resolveModelBinding", () => {
  const allReady = () => true;

  it("resolves model-only 'opus 4.8' to the claude reference agent", () => {
    const result = resolveModelBinding(
      { model: "opus 4.8" },
      { config: DEFAULT_CONFIG, isReady: allReady },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.primary.agent).toBe("claude");
    expect(result.primary.model).toBe("claude-opus-4-8");
    expect(result.primary.reference).toBe(true);
    expect(result.primary.familyId).toBe("claude-opus-4.8");
    expect(result.candidates.length).toBeGreaterThan(1);
    expect(result.summary).toContain("via claude");
  });

  it("falls back to another agent when the reference is unhealthy", () => {
    const result = resolveModelBinding(
      { model: "opus 4.8" },
      {
        config: DEFAULT_CONFIG,
        isReady: (agent) => agent !== "claude",
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.primary.agent).not.toBe("claude");
    expect(result.primary.familyId).toBe("claude-opus-4.8");
    // Preference order after claude for this family: opencode, kiro, cursor…
    expect(AGENT_PREFERENCE_ORDER).toContain(result.primary.provider);
  });

  it("resolves modelClass 'thinker' to a frontier offering", () => {
    const result = resolveModelBinding(
      { modelClass: "thinker" },
      { config: DEFAULT_CONFIG, isReady: allReady },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.primary.modelClass).toBe("thinker");
    expect(["claude-fable-5", "claude-opus-4.8", "claude-mythos-5", "gpt-5.6-sol"]).toContain(
      result.primary.familyId,
    );
  });

  it("resolves modelClass 'ultrathinker' with high/xhigh effort", () => {
    const result = resolveModelBinding(
      { modelClass: "ultrathinker" },
      { config: DEFAULT_CONFIG, isReady: allReady },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.primary.modelClass).toBe("ultrathinker");
    expect(["claude-fable-5", "gpt-5.6-sol", "kimi-k3", "claude-opus-4.8"]).toContain(
      result.primary.familyId,
    );
    expect(result.primary.effort).toBeTruthy();
    expect(["xhigh", "high"]).toContain(result.primary.effort);
  });

  it("resolves modelClass 'deep-reviewer' preferring Opus / Sol with high effort", () => {
    const result = resolveModelBinding(
      { modelClass: "deep-reviewer" },
      { config: DEFAULT_CONFIG, isReady: allReady },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.primary.modelClass).toBe("deep-reviewer");
    expect(["claude-opus-4.8", "gpt-5.6-sol", "claude-fable-5"]).toContain(result.primary.familyId);
    expect(result.primary.effort).toBe("high");
  });

  it("resolves modelClass 'reviewer' onto a review-oriented family", () => {
    const result = resolveModelBinding(
      { modelClass: "reviewer" },
      { config: DEFAULT_CONFIG, isReady: allReady },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.primary.modelClass).toBe("reviewer");
    expect([
      "claude-opus-4.8",
      "deepseek-v4-pro",
      "qwen-3.7-max",
      "gpt-5.6-sol",
      "codex-auto-review",
    ]).toContain(result.primary.familyId);
  });

  it("honors explicit effort over class preferredEfforts", () => {
    const result = resolveModelBinding(
      { modelClass: "ultrathinker", effort: "low" },
      { config: DEFAULT_CONFIG, isReady: allReady },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.primary.effort).toBe("low");
  });

  it("resolveEffortForBinding walks preferredEfforts against supported levels", () => {
    const effort = resolveEffortForBinding({
      agent: "claude",
      model: "claude-fable-5",
      modelClass: "ultrathinker",
      config: DEFAULT_CONFIG,
    });
    expect(effort).toBe("xhigh");

    const unsupportedExplicit = resolveEffortForBinding({
      agent: "claude",
      model: "claude-haiku-4-5",
      modelClass: "ultrathinker",
      explicitEffort: "xhigh",
      config: DEFAULT_CONFIG,
    });
    // Explicit effort is returned as-authored; support gating happens at remap.
    expect(unsupportedExplicit).toBe("xhigh");
  });

  it("resolves modelClass 'simple' preferring a cheap/fast family", () => {
    const result = resolveModelBinding(
      { modelClass: "simple" },
      { config: DEFAULT_CONFIG, isReady: allReady },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.primary.modelClass).toBe("simple");
  });

  it("matches GPT-5.6 Sol and Kimi K3 family aliases", () => {
    clearModelFamilyCacheForTests();
    expect(findModelFamily("gpt-5.6-sol")?.id).toBe("gpt-5.6-sol");
    expect(findModelFamily("gemini flash")?.id).toBe("gemini-3.6-flash");
    expect(findModelFamily("gemini flash lite")?.id).toBe("gemini-3.5-flash-lite");
    expect(findModelFamily("kimi k3")?.id).toBe("kimi-k3");
    expect(findModelFamily("deepseek pro")?.id).toBe("deepseek-v4-pro");
    expect(findModelFamily("qwen 3.7 max")?.id).toBe("qwen-3.7-max");
  });

  it("honors an explicit agent pin when translating a family alias", () => {
    const result = resolveModelBinding(
      { agent: "opencode", model: "opus 4.8" },
      { config: DEFAULT_CONFIG, isReady: allReady },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.primary.agent).toBe("opencode");
    expect(result.primary.model).toBe("opencode/claude-opus-4-8");
  });

  it("preserves Antigravity effort-suffixed Gemini ids (does not collapse to bare base)", () => {
    clearModelFamilyCacheForTests();
    // Regression: babysit-all-prs with babysitterModel=gemini-3.6-flash-medium
    // previously resolved to bare gemini-3.6-flash and agy exited requiring --effort.
    expect(nativeModelForProvider("antigravity", "gemini-3.6-flash-medium")).toBe(
      "gemini-3.6-flash-medium",
    );
    expect(nativeModelForProvider("antigravity", "gemini-3.6-flash-high")).toBe(
      "gemini-3.6-flash-high",
    );
    expect(nativeModelForProvider("antigravity", "gemini flash")).toBe("gemini-3.6-flash-high");

    for (const model of ["gemini-3.6-flash-medium", "gemini-3.6-flash-high", "gemini-3.6-flash-low"]) {
      const result = resolveModelBinding(
        { model },
        { config: DEFAULT_CONFIG, isReady: allReady },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.primary.agent).toBe("antigravity");
      expect(result.primary.model).toBe(model);
    }
  });

  it("appends fallbackModels to the failover chain", () => {
    const result = resolveModelBinding(
      { model: "opus 4.8", fallbackModels: ["sonnet 5", "haiku"] },
      { config: DEFAULT_CONFIG, isReady: allReady },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const families = new Set(result.candidates.map((c) => c.familyId).filter(Boolean));
    expect(families.has("claude-opus-4.8")).toBe(true);
    expect(families.has("claude-sonnet-5") || families.has("claude-haiku-4.5")).toBe(true);
  });

  it("errors on unknown modelClass", () => {
    const result = resolveModelBinding(
      { modelClass: "wizard" },
      { config: DEFAULT_CONFIG, isReady: allReady },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("unknown modelClass");
  });

  it("errors when no ready agent can provide the model", () => {
    const result = resolveModelBinding(
      { model: "opus 4.8" },
      { config: DEFAULT_CONFIG, isReady: () => false },
    );
    expect(result.ok).toBe(false);
  });
});

describe("workflow schema: model-only and modelClass", () => {
  it("accepts a worker with only model + prompt", () => {
    const spec: WorkflowSpec = {
      name: "model-only",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "w", model: "opus 4.8", prompt: "do the thing" }],
        },
      ],
    };
    const valid = validateWorkflow(spec);
    expect(valid.ok).toBe(true);
  });

  it("accepts a worker with only modelClass + prompt", () => {
    const spec: WorkflowSpec = {
      name: "class-only",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "w", modelClass: "implementer", prompt: "implement it" }],
        },
      ],
    };
    const valid = validateWorkflow(spec);
    expect(valid.ok).toBe(true);
  });

  it("accepts ultrathinker / reviewer / deep-reviewer classes", () => {
    for (const modelClass of ["ultrathinker", "reviewer", "deep-reviewer"] as const) {
      const spec: WorkflowSpec = {
        name: `class-${modelClass}`,
        phases: [
          {
            id: "p1",
            title: "P1",
            steps: [{ id: "w", modelClass, prompt: "review carefully" }],
          },
        ],
      };
      expect(validateWorkflow(spec).ok).toBe(true);
    }
  });

  it("rejects a worker with only agent (no model or class)", () => {
    const spec = {
      name: "agent-only",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "w", agent: "claude", prompt: "hi" }],
        },
      ],
    };
    const valid = validateWorkflow(spec as WorkflowSpec);
    expect(valid.ok).toBe(false);
  });

  it("accepts fallbackModels alongside a model binding", () => {
    const spec: WorkflowSpec = {
      name: "with-fallback",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "w",
              model: "opus 4.8",
              fallbackModels: ["sonnet 5", "composer-2.5"],
              prompt: "review",
            },
          ],
        },
      ],
    };
    expect(validateWorkflow(spec).ok).toBe(true);
  });

  it("accepts modelFailover and workflow-level fallbackModels", () => {
    const spec: WorkflowSpec = {
      name: "with-failover-policy",
      fallbackModels: ["sonnet 5", "haiku"],
      modelFailover: {
        enabled: true,
        on: ["quota", "rate_limit"],
        onCapacityResult: true,
        preferNextModel: true,
        failoverDelayMs: 100,
      },
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "w",
              modelClass: "implementer",
              modelFailover: { allowAfterToolUse: false },
              prompt: "implement",
            },
          ],
        },
      ],
    };
    expect(validateWorkflow(spec).ok).toBe(true);
  });

  it("rejects an empty modelFailover.on list", () => {
    const spec = {
      name: "bad-failover",
      modelFailover: { on: [] },
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "w", model: "opus 4.8", prompt: "hi" }],
        },
      ],
    };
    expect(validateWorkflow(spec as WorkflowSpec).ok).toBe(false);
  });
});

describe("resolveWorkflowBindings", () => {
  it("materializes model-only steps onto concrete agent+model", () => {
    const spec: WorkflowSpec = {
      name: "bind",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            { id: "a", model: "opus 4.8", prompt: "a" },
            { id: "b", modelClass: "simple", prompt: "b" },
            { id: "c", agent: "claude", model: "claude-sonnet-5", prompt: "c" },
          ],
        },
      ],
    };
    const result = resolveWorkflowBindings(spec, {
      config: DEFAULT_CONFIG,
      isReady: () => true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const a = result.spec.phases[0]!.steps[0] as { agent: string; model: string };
    const b = result.spec.phases[0]!.steps[1] as { agent: string; model: string };
    const c = result.spec.phases[0]!.steps[2] as { agent: string; model: string };
    expect(a.agent).toBe("claude");
    expect(a.model).toBe("claude-opus-4-8");
    expect(b.agent).toBeTruthy();
    expect(b.model).toBeTruthy();
    expect(c).toEqual({ agent: "claude", model: "claude-sonnet-5", prompt: "c", id: "c" });
    expect(result.resolutions.map((r) => r.stepId).sort()).toEqual(["a", "b"]);
  });

  it("applies ultrathinker preferred effort onto the materialized step", () => {
    const spec: WorkflowSpec = {
      name: "ultra",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "w", modelClass: "ultrathinker", prompt: "think hard" }],
        },
      ],
    };
    const result = resolveWorkflowBindings(spec, {
      config: DEFAULT_CONFIG,
      isReady: () => true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const step = result.spec.phases[0]!.steps[0] as {
      agent: string;
      model: string;
      effort?: string;
    };
    expect(step.agent).toBeTruthy();
    expect(step.model).toBeTruthy();
    expect(["xhigh", "high"]).toContain(step.effort);
  });

  it("remaps an unhealthy pinned agent onto a same-family offering", () => {
    const spec: WorkflowSpec = {
      name: "remap",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "w", agent: "claude", model: "claude-opus-4-8", prompt: "go" }],
        },
      ],
    };
    const result = resolveWorkflowBindings(spec, {
      config: DEFAULT_CONFIG,
      isReady: (agent) => agent !== "claude",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const step = result.spec.phases[0]!.steps[0] as { agent: string; model: string };
    expect(step.agent).not.toBe("claude");
    expect(result.resolutions[0]?.primary.familyId).toBe("claude-opus-4.8");
  });

  it("keeps session-continue pairs on the same resolved agent", () => {
    const spec: WorkflowSpec = {
      name: "session-sticky",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "design", model: "opus 4.8", prompt: "design" }],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            {
              id: "refine",
              model: "opus 4.8",
              session: "continue:design",
              prompt: "refine",
            },
          ],
        },
      ],
    };
    const result = resolveWorkflowBindings(spec, {
      config: DEFAULT_CONFIG,
      isReady: () => true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const a = result.spec.phases[0]!.steps[0] as { agent: string };
    const b = result.spec.phases[1]!.steps[0] as { agent: string };
    expect(a.agent).toBe(b.agent);
  });
});
