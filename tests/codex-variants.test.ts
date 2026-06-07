import { describe, expect, it } from "vitest";
import { parseCodexDebugModels } from "../src/agents/codex-variants";

const SAMPLE = `{
  "models": [
    {
      "slug": "gpt-5.4-mini",
      "display_name": "GPT-5.4 Mini",
      "supported_reasoning_levels": [
        { "effort": "low", "description": "Fast responses with lighter reasoning" },
        { "effort": "high", "description": "Greater reasoning depth for complex problems" },
        { "effort": "xhigh", "description": "Extra high reasoning depth for complex problems" }
      ]
    },
    {
      "slug": "codex-auto-review",
      "display_name": "Codex Auto Review",
      "supported_reasoning_levels": []
    }
  ]
}`;

describe("parseCodexDebugModels", () => {
  it("extracts display names and sorted effort levels per slug", () => {
    const parsed = parseCodexDebugModels(SAMPLE);
    expect(parsed.get("gpt-5.4-mini")).toEqual({
      name: "GPT-5.4 Mini",
      efforts: ["high", "low", "xhigh"],
    });
    expect(parsed.get("codex-auto-review")).toEqual({
      name: "Codex Auto Review",
      efforts: [],
    });
  });

  it("accepts string reasoning levels", () => {
    const parsed = parseCodexDebugModels(`{
      "models": [{
        "slug": "gpt-5.2",
        "display_name": "GPT-5.2",
        "supported_reasoning_levels": ["low", "medium", "high"]
      }]
    }`);
    expect(parsed.get("gpt-5.2")).toEqual({
      name: "GPT-5.2",
      efforts: ["high", "low", "medium"],
    });
  });
});
