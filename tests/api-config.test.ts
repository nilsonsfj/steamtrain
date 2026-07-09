import { afterEach, describe, expect, it } from "vitest";
import {
  buildApiMeta,
  resolveApiInstance,
  resolveApiInstances,
  resolveLlmStepApi,
  workflowLlmApiIssues,
} from "../src/apis";
import type { ApiInstanceConfig, SteamtrainConfig } from "../src/config";
import { mergeInstanceLists, parseApisConfig } from "../src/config";
import { Orchestrator } from "../src/orchestrator";
import { type WorkflowSpec, modelKey, validateWorkflow } from "../src/workflow";

const KEY_ENV = "STEAMTRAIN_TEST_API_KEY";
const touchedEnv: string[] = [];

function setKey(name: string, value = "sk-test"): void {
  process.env[name] = value;
  touchedEnv.push(name);
}

afterEach(() => {
  for (const name of touchedEnv.splice(0)) delete process.env[name];
});

const customConfig: SteamtrainConfig = {
  apis: [
    { id: "openai", provider: "openai", enabled: false },
    {
      id: "groq",
      provider: "openai",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKeyEnv: "GROQ_API_KEY",
      defaultModel: "llama-3.3-70b",
      pricing: { inputPerMTok: 0.5, outputPerMTok: 0.8 },
    },
  ],
};

describe("api instance resolution", () => {
  it("keeps the zero-config built-in apis enabled with conventional key envs", () => {
    const apis = resolveApiInstances();
    expect(apis.map((api) => api.id)).toEqual([
      "anthropic",
      "openai",
      "openrouter",
      "opencode-zen",
    ]);
    expect(apis[0]?.apiKeyEnv).toBe("ANTHROPIC_API_KEY");
    expect(apis[1]?.apiKeyEnv).toBe("OPENAI_API_KEY");
  });

  it("exposes openai-dialect gateways (openrouter, opencode-zen) with their endpoints", () => {
    const apis = resolveApiInstances();
    const openrouter = apis.find((api) => api.id === "openrouter");
    expect(openrouter).toMatchObject({
      provider: "openai",
      apiKeyEnv: "OPENROUTER_API_KEY",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    const zen = apis.find((api) => api.id === "opencode-zen");
    expect(zen).toMatchObject({
      provider: "openai",
      apiKeyEnv: "OPENCODE_API_KEY",
      baseUrl: "https://opencode.ai/zen/v1",
      keyless: true,
    });
  });

  it("enabling a gateway built-in keeps its endpoint and key env (no revert to openai defaults)", () => {
    // Mirrors `/api enable openrouter` writing a minimal id+provider+enabled entry.
    const config: SteamtrainConfig = {
      apis: [{ id: "openrouter", provider: "openai", enabled: true }],
    };
    expect(resolveApiInstance(config, "openrouter")).toMatchObject({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
      configured: true,
    });
  });

  it("hides disabled apis outside all-instance config views", () => {
    expect(resolveApiInstances(customConfig).map((api) => api.id)).not.toContain("openai");
    expect(
      resolveApiInstances(customConfig, { includeDisabled: true }).find(
        (api) => api.id === "openai",
      )?.enabled,
    ).toBe(false);
  });

  it("resolves configured instances with their overrides and marks them configured", () => {
    const groq = resolveApiInstance(customConfig, "groq");
    expect(groq).toMatchObject({
      provider: "openai",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKeyEnv: "GROQ_API_KEY",
      defaultModel: "llama-3.3-70b",
      configured: true,
    });
    expect(groq?.pricing?.inputPerMTok).toBe(0.5);
  });

  it("falls back to the provider's conventional key env when apiKeyEnv is unset", () => {
    const config: SteamtrainConfig = { apis: [{ id: "proxy", provider: "anthropic" }] };
    expect(resolveApiInstance(config, "proxy")?.apiKeyEnv).toBe("ANTHROPIC_API_KEY");
  });

  it("merges instance lists by id, override winning wholesale", () => {
    const base: ApiInstanceConfig[] = [
      { id: "groq", provider: "openai", baseUrl: "https://old" },
      { id: "anthropic", provider: "anthropic" },
    ];
    const merged = mergeInstanceLists<ApiInstanceConfig>(base, [
      { id: "groq", provider: "openai", apiKeyEnv: "NEW_KEY" },
    ]);
    expect(merged).toEqual([
      { id: "anthropic", provider: "anthropic" },
      { id: "groq", provider: "openai", apiKeyEnv: "NEW_KEY" },
    ]);
  });

  it("builds the meta view-model with health and key presence, never the key itself", () => {
    setKey("GROQ_API_KEY");
    const meta = buildApiMeta(customConfig, (id) => id === "groq", {
      includeDisabled: true,
      includeConfig: true,
    });
    const groq = meta.find((m) => m.id === "groq");
    expect(groq).toMatchObject({ healthy: true, keyPresent: true, apiKeyEnv: "GROQ_API_KEY" });
    expect(JSON.stringify(meta)).not.toContain("sk-test");
    expect(meta.find((m) => m.id === "openai")?.enabled).toBe(false);
  });
});

describe("apis config validation", () => {
  it("accepts a valid apis array", () => {
    expect(parseApisConfig([{ id: "groq", provider: "openai" }])).toHaveLength(1);
  });

  it("rejects empty and typo'd pricing objects instead of silently billing $0", () => {
    expect(() => parseApisConfig([{ id: "a", provider: "openai", pricing: {} }])).toThrow(
      /at least one/,
    );
    expect(() =>
      parseApisConfig([{ id: "a", provider: "openai", pricing: { inputPerMtok: 5 } }]),
    ).toThrow();
    expect(
      parseApisConfig([{ id: "a", provider: "openai", pricing: { inputPerMTok: 5 } }]),
    ).toHaveLength(1);
  });

  it("accepts the keyless flag (for local servers / free gateways)", () => {
    const parsed = parseApisConfig([{ id: "ollama", provider: "openai", keyless: true }]);
    expect(parsed).toEqual([{ id: "ollama", provider: "openai", keyless: true }]);
  });

  it("rejects duplicate ids, unknown providers, and unknown fields", () => {
    expect(() =>
      parseApisConfig([
        { id: "a", provider: "openai" },
        { id: "a", provider: "anthropic" },
      ]),
    ).toThrow(/duplicate api id 'a'/);
    expect(() => parseApisConfig([{ id: "a", provider: "gemini" }])).toThrow();
    expect(() => parseApisConfig([{ id: "a", provider: "openai", apiKey: "sk-x" }])).toThrow();
  });
});

function llmSpec(step: Record<string, unknown>): WorkflowSpec {
  return {
    name: "api-test",
    phases: [
      {
        id: "p1",
        title: "P1",
        steps: [{ id: "judge", kind: "llm", prompt: "Judge {{input}}", ...step } as never],
      },
    ],
  };
}

describe("llm step api resolution", () => {
  it("resolves a bare step to the built-in instance for its inferred provider", () => {
    const resolved = resolveLlmStepApi({ model: "claude-opus-4-8" }, undefined);
    expect(resolved).toMatchObject({
      ok: true,
      provider: "anthropic",
      model: "claude-opus-4-8",
      apiKeyEnv: "ANTHROPIC_API_KEY",
    });
  });

  it("inherits endpoint, key env, default model, and pricing from the api instance", () => {
    const resolved = resolveLlmStepApi({ api: "groq" }, customConfig);
    expect(resolved).toMatchObject({
      ok: true,
      provider: "openai",
      model: "llama-3.3-70b",
      apiKeyEnv: "GROQ_API_KEY",
      baseUrl: "https://api.groq.com/openai/v1",
    });
    if (resolved.ok) expect(resolved.pricing?.outputPerMTok).toBe(0.8);
  });

  it("lets step fields override the instance's", () => {
    const resolved = resolveLlmStepApi(
      {
        api: "groq",
        model: "llama-3.1-8b",
        apiKeyEnv: KEY_ENV,
        baseUrl: "https://proxy.local/v1",
        pricing: { inputPerMTok: 1 },
      },
      customConfig,
    );
    expect(resolved).toMatchObject({
      ok: true,
      model: "llama-3.1-8b",
      apiKeyEnv: KEY_ENV,
      baseUrl: "https://proxy.local/v1",
    });
    if (resolved.ok) expect(resolved.pricing).toEqual({ inputPerMTok: 1 });
  });

  it("resolves the keyless opencode-zen gateway with its endpoint and no required key", () => {
    const resolved = resolveLlmStepApi({ api: "opencode-zen", model: "opencode/big-pickle" });
    expect(resolved).toMatchObject({
      ok: true,
      provider: "openai",
      model: "opencode/big-pickle",
      baseUrl: "https://opencode.ai/zen/v1",
      keyless: true,
    });
  });

  it("configuring the built-in id customizes bare steps of that provider", () => {
    const config: SteamtrainConfig = {
      apis: [{ id: "anthropic", provider: "anthropic", baseUrl: "https://gw.local" }],
    };
    const resolved = resolveLlmStepApi({ model: "claude-opus-4-8" }, config);
    expect(resolved).toMatchObject({ ok: true, baseUrl: "https://gw.local" });
  });

  it("fails clearly on unknown, disabled, conflicting, or model-less references", () => {
    expect(resolveLlmStepApi({ api: "nope", model: "m" }, customConfig)).toMatchObject({
      ok: false,
      error: expect.stringContaining("unknown api 'nope'"),
    });
    expect(resolveLlmStepApi({ api: "openai", model: "gpt-4.1" }, customConfig)).toMatchObject({
      ok: false,
      error: expect.stringContaining("disabled"),
    });
    expect(
      resolveLlmStepApi({ api: "groq", provider: "anthropic", model: "m" }, customConfig),
    ).toMatchObject({ ok: false, error: expect.stringContaining("conflicts") });
    expect(resolveLlmStepApi({ api: "anthropic" }, undefined)).toMatchObject({
      ok: false,
      error: expect.stringContaining("no model"),
    });
  });
});

describe("llm step schema with api references", () => {
  it("allows omitting model when api is set", () => {
    expect(validateWorkflow(llmSpec({ api: "groq" })).ok).toBe(true);
  });

  it("still requires model without an api reference", () => {
    const result = validateWorkflow(llmSpec({}));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/requires a model/);
  });
});

describe("workflow llm api preflight", () => {
  it("reports missing keys and unresolvable references, deduplicated", () => {
    const spec: WorkflowSpec = {
      name: "pre",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            { id: "a", kind: "llm", api: "groq", prompt: "a" },
            { id: "b", kind: "llm", api: "missing", prompt: "b", model: "m" },
          ],
        },
      ],
    };
    const issues = workflowLlmApiIssues(spec, customConfig, {});
    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain("GROQ_API_KEY");
    expect(issues[1]).toContain("unknown api 'missing'");
    expect(workflowLlmApiIssues(spec, customConfig, { GROQ_API_KEY: "k" })).toHaveLength(1);
  });

  it("does not flag a keyless gateway (opencode-zen) for a missing key", () => {
    const spec = llmSpec({ api: "opencode-zen", model: "opencode/big-pickle" });
    expect(workflowLlmApiIssues(spec, undefined, {})).toHaveLength(0);
  });

  it("gates workflow dispatch on llm api readiness", () => {
    const orchestrator = new Orchestrator(customConfig, { workspaces: [] }, [], {
      workflows: {},
      sources: {},
    });
    const spec = llmSpec({ api: "groq" });
    const blocked = orchestrator.canDispatchWorkflowSpec(spec);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toContain("GROQ_API_KEY");
    setKey("GROQ_API_KEY");
    expect(orchestrator.canDispatchWorkflowSpec(spec).ok).toBe(true);
  });
});

describe("cost attribution for llm leaves", () => {
  it("keys model rows by api/model like agent/model", () => {
    expect(modelKey({ api: "groq", model: "llama-3.3-70b" })).toBe("groq/llama-3.3-70b");
    expect(modelKey({ agent: "claude", model: "claude-opus-4-8" })).toBe("claude/claude-opus-4-8");
    expect(modelKey({ api: "anthropic" })).toBe("anthropic");
  });
});
