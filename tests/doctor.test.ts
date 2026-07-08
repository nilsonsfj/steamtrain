import { describe, expect, it } from "vitest";
import {
  checkAgent,
  checkLlmApiKeys,
  checkLlmApiKeysForCatalog,
  collectLlmKeyRequirements,
} from "../src/doctor/doctor";
import type { WorkflowSpec } from "../src/workflow/types";

describe("checkAgent codex", () => {
  it("reports missing binary with an install hint", async () => {
    const result = await checkAgent("codex", "__steamtrain_missing_codex__", { provider: "codex" });
    expect(result).toMatchObject({
      category: "agent",
      agent: "codex",
      status: "binary_missing",
      binary: "__steamtrain_missing_codex__",
    });
    expect(result.detail).toContain("npm i -g @openai/codex");
  });
});

describe("checkAgent amp", () => {
  it("reports missing binary with an install hint", async () => {
    const result = await checkAgent("amp", "__steamtrain_missing_amp__", { provider: "amp" });
    expect(result).toMatchObject({
      category: "agent",
      agent: "amp",
      status: "binary_missing",
      binary: "__steamtrain_missing_amp__",
    });
    expect(result.detail).toContain("npm i -g @sourcegraph/amp");
  });
});

describe("checkAgent kiro", () => {
  it("reports missing binary with an install hint", async () => {
    const result = await checkAgent("kiro", "__steamtrain_missing_kiro__", { provider: "kiro" });
    expect(result).toMatchObject({
      category: "agent",
      agent: "kiro",
      status: "binary_missing",
      binary: "__steamtrain_missing_kiro__",
    });
    expect(result.detail).toContain("npm i -g @anthropic-ai/kiro-cli");
  });
});

describe("checkAgent ok", () => {
  it("reports ok status for a reachable binary", async () => {
    const result = await checkAgent("claude", "node", { provider: "claude" });
    expect(result).toMatchObject({
      category: "agent",
      agent: "claude",
      status: "ok",
      binary: "node",
    });
    expect(result.version).toBeDefined();
    expect(result.message).toBe("ready");
  });
});

const llmSpec: WorkflowSpec = {
  name: "llm-only",
  phases: [
    {
      id: "p1",
      title: "phase 1",
      steps: [
        {
          id: "judge",
          kind: "llm",
          model: "claude-opus-4-8",
          prompt: "Judge {{input}}",
        },
      ],
    },
  ],
};

const customApiKeySpec: WorkflowSpec = {
  name: "custom-key",
  phases: [
    {
      id: "p1",
      title: "phase 1",
      steps: [
        {
          id: "summarize",
          kind: "llm",
          model: "gpt-4",
          prompt: "Summarize {{input}}",
          apiKeyEnv: "MY_CUSTOM_API_KEY",
        },
      ],
    },
  ],
};

const agentOnlySpec: WorkflowSpec = {
  name: "agent-only",
  phases: [
    {
      id: "p1",
      title: "phase 1",
      steps: [{ id: "work", kind: "worker", agent: "opencode", model: "m", prompt: "{{input}}" }],
    },
  ],
};

const multiLlmSpec: WorkflowSpec = {
  name: "multi-llm",
  phases: [
    {
      id: "p1",
      title: "phase 1",
      steps: [
        {
          id: "step1",
          kind: "llm",
          model: "claude-opus-4-8",
          prompt: "first",
        },
        {
          id: "step2",
          kind: "llm",
          model: "claude-haiku",
          prompt: "second",
        },
      ],
    },
  ],
};

const mixedSpec: WorkflowSpec = {
  name: "mixed",
  phases: [
    {
      id: "p1",
      title: "phase 1",
      steps: [
        {
          id: "llm-step",
          kind: "llm",
          model: "claude-opus-4-8",
          prompt: "judge",
        },
        { id: "agent-step", kind: "worker", agent: "opencode", model: "m", prompt: "{{input}}" },
      ],
    },
  ],
};

describe("collectLlmKeyRequirements", () => {
  it("returns empty array for agent-only workflows", () => {
    expect(collectLlmKeyRequirements(agentOnlySpec)).toEqual([]);
  });

  it("collects a single requirement for anthropic models", () => {
    const reqs = collectLlmKeyRequirements(llmSpec);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toEqual({ provider: "anthropic", envVar: "ANTHROPIC_API_KEY" });
  });

  it("collects a single requirement for openai models", () => {
    const reqs = collectLlmKeyRequirements(customApiKeySpec);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toEqual({ provider: "openai", envVar: "MY_CUSTOM_API_KEY" });
  });

  it("deduplicates by env var across multiple llm steps", () => {
    const reqs = collectLlmKeyRequirements(multiLlmSpec);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.envVar).toBe("ANTHROPIC_API_KEY");
  });

  it("collects requirements for mixed agent + llm workflows", () => {
    const reqs = collectLlmKeyRequirements(mixedSpec);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.envVar).toBe("ANTHROPIC_API_KEY");
  });
});

describe("checkLlmApiKeys", () => {
  it("returns ok when the key is present", () => {
    const results = checkLlmApiKeys(llmSpec, { ANTHROPIC_API_KEY: "sk-test" });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      category: "llm-key",
      status: "ok",
      requirement: "ANTHROPIC_API_KEY",
    });
  });

  it("returns api_key_missing when the key is absent", () => {
    const results = checkLlmApiKeys(llmSpec, {});
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      category: "llm-key",
      status: "api_key_missing",
      requirement: "ANTHROPIC_API_KEY",
    });
    expect(results[0]!.detail).toContain("ANTHROPIC_API_KEY");
  });

  it("returns empty array for agent-only workflows", () => {
    expect(checkLlmApiKeys(agentOnlySpec, {})).toEqual([]);
  });

  it("returns multiple results when different env vars are needed", () => {
    const results = checkLlmApiKeys(customApiKeySpec, {});
    expect(results).toHaveLength(1);
    expect(results[0]!.requirement).toBe("MY_CUSTOM_API_KEY");
  });

  it("treats empty-string env var as missing", () => {
    const results = checkLlmApiKeys(llmSpec, { ANTHROPIC_API_KEY: "" });
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("api_key_missing");
  });
});

describe("checkLlmApiKeysForCatalog", () => {
  it("returns empty array for no workflows", () => {
    expect(checkLlmApiKeysForCatalog([])).toEqual([]);
  });

  it("deduplicates by env var across multiple specs", () => {
    const results = checkLlmApiKeysForCatalog([llmSpec, multiLlmSpec], {
      ANTHROPIC_API_KEY: "sk",
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("ok");
  });

  it("includes separate entries for different env vars", () => {
    const results = checkLlmApiKeysForCatalog([llmSpec, customApiKeySpec], {});
    expect(results).toHaveLength(2);
    const envVars = results.map((r) => r.requirement);
    expect(envVars).toContain("ANTHROPIC_API_KEY");
    expect(envVars).toContain("MY_CUSTOM_API_KEY");
  });
});
