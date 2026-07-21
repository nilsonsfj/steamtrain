import { describe, expect, it } from "vitest";
import {
  clearAntigravityVariantCacheForTests,
  listAntigravityCachedAgentModels,
  parseAntigravityModelsOutput,
  setAntigravityVariantCacheForTests,
} from "../src/agents/antigravity-variants";

describe("parseAntigravityModelsOutput", () => {
  it("keeps model display lines and drops glog / noise", () => {
    const output = `
I0721 02:26:55.884685 31951 server.go:538] Language server listening
Fetching available models...
Gemini 3.5 Flash (Medium)
Gemini 3.5 Flash (High)
Gemini 3.5 Flash (Low)
Gemini 3.1 Pro (Low)
Gemini 3.1 Pro (High)
Claude Sonnet 4.6 (Thinking)
Claude Opus 4.6 (Thinking)
GPT-OSS 120B (Medium)
I0721 02:26:57.718252 31951 input_loop.go:516] Auth done received
`;
    const models = parseAntigravityModelsOutput(output);
    expect([...models.keys()]).toEqual([
      "Gemini 3.5 Flash (Medium)",
      "Gemini 3.5 Flash (High)",
      "Gemini 3.5 Flash (Low)",
      "Gemini 3.1 Pro (Low)",
      "Gemini 3.1 Pro (High)",
      "Claude Sonnet 4.6 (Thinking)",
      "Claude Opus 4.6 (Thinking)",
      "GPT-OSS 120B (Medium)",
    ]);
    expect(models.get("Gemini 3.1 Pro (High)")).toEqual({ name: "Gemini 3.1 Pro (High)" });
  });
});

describe("antigravity variant cache", () => {
  it("lists cached models when fresh", () => {
    clearAntigravityVariantCacheForTests();
    expect(listAntigravityCachedAgentModels()).toEqual([]);

    setAntigravityVariantCacheForTests(
      new Map([
        ["Gemini 3.1 Pro (High)", { name: "Gemini 3.1 Pro (High)" }],
        ["Gemini 3.5 Flash (Low)", { name: "Gemini 3.5 Flash (Low)" }],
      ]),
    );

    expect(listAntigravityCachedAgentModels()).toEqual([
      { id: "Gemini 3.1 Pro (High)", name: "Gemini 3.1 Pro (High)" },
      { id: "Gemini 3.5 Flash (Low)", name: "Gemini 3.5 Flash (Low)" },
    ]);

    clearAntigravityVariantCacheForTests();
  });
});
