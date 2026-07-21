import { describe, expect, it } from "vitest";
import {
  AGENT_PREFERENCE_ORDER,
  clearModelFamilyCacheForTests,
  compactModelQuery,
  findModelFamily,
  nativeModelForProvider,
  normalizeModelQuery,
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
    expect(["claude-fable-5", "claude-opus-4.8", "claude-mythos-5"]).toContain(
      result.primary.familyId,
    );
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
});
