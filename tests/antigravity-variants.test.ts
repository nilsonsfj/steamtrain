import { describe, expect, it } from "vitest";
import {
  clearAntigravityVariantCacheForTests,
  listAntigravityCachedAgentModels,
  parseAntigravityModelsOutput,
  setAntigravityVariantCacheForTests,
} from "../src/agents/antigravity-variants";

describe("parseAntigravityModelsOutput", () => {
  it("keeps slug model lines and drops glog / noise", () => {
    const output = `
I0721 02:26:55.884685 31951 server.go:538] Language server listening
Fetching available models...
gemini-3.6-flash-high
gemini-3.6-flash-medium
gemini-3.6-flash-low
gemini-3.5-flash-high
gemini-3.1-pro-high
claude-sonnet-4-6
claude-opus-4-6-thinking
gpt-oss-120b-medium
I0721 02:26:57.718252 31951 input_loop.go:516] Auth done received
`;
    const models = parseAntigravityModelsOutput(output);
    expect([...models.keys()]).toEqual([
      "gemini-3.6-flash-high",
      "gemini-3.6-flash-medium",
      "gemini-3.6-flash-low",
      "gemini-3.5-flash-high",
      "gemini-3.1-pro-high",
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
    ]);
    expect(models.get("gemini-3.6-flash-high")).toEqual({
      name: "Gemini 3.6 Flash (High)",
    });
  });

  it("still accepts legacy display-label catalogs", () => {
    const output = `
Gemini 3.5 Flash (Medium)
Gemini 3.1 Pro (High)
Claude Sonnet 4.6 (Thinking)
`;
    const models = parseAntigravityModelsOutput(output);
    expect([...models.keys()]).toEqual([
      "Gemini 3.5 Flash (Medium)",
      "Gemini 3.1 Pro (High)",
      "Claude Sonnet 4.6 (Thinking)",
    ]);
  });
});

describe("antigravity variant cache", () => {
  it("lists cached models when fresh", () => {
    clearAntigravityVariantCacheForTests();
    expect(listAntigravityCachedAgentModels()).toEqual([]);

    setAntigravityVariantCacheForTests(
      new Map([
        ["gemini-3.6-flash-high", { name: "Gemini 3.6 Flash (High)" }],
        ["gemini-3.5-flash-low", { name: "Gemini 3.5 Flash (Low)" }],
      ]),
    );

    expect(listAntigravityCachedAgentModels()).toEqual([
      { id: "gemini-3.5-flash-low", name: "Gemini 3.5 Flash (Low)" },
      { id: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)" },
    ]);

    clearAntigravityVariantCacheForTests();
  });
});
