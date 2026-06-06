import { describe, expect, it } from "vitest";
import { parseOpencodeModelsVerbose } from "../src/agents/opencode-variants";

const SAMPLE = `opencode-go/deepseek-v4-flash
{
  "id": "deepseek-v4-flash",
  "providerID": "opencode-go",
  "name": "DeepSeek V4 Flash",
  "variants": {
    "low": { "reasoningEffort": "low" },
    "high": { "reasoningEffort": "high" },
    "max": { "reasoningEffort": "max" }
  }
}
opencode-go/glm-5
{
  "id": "glm-5",
  "providerID": "opencode-go",
  "name": "GLM-5",
  "variants": {}
}
opencode/gpt-5.4-mini
{
  "id": "gpt-5.4-mini",
  "providerID": "opencode",
  "name": "GPT 5.4 Mini",
  "variants": {
    "none": { "reasoningEffort": "none" },
    "high": { "reasoningEffort": "high" },
    "xhigh": { "reasoningEffort": "xhigh" }
  }
}
`;

describe("parseOpencodeModelsVerbose", () => {
  it("extracts name and sorted variant keys per provider/model id", () => {
    const parsed = parseOpencodeModelsVerbose(SAMPLE);
    expect(parsed.get("opencode-go/deepseek-v4-flash")).toEqual({
      name: "DeepSeek V4 Flash",
      efforts: ["high", "low", "max"],
    });
    expect(parsed.get("opencode-go/glm-5")).toEqual({
      name: "GLM-5",
      efforts: [],
    });
    expect(parsed.get("opencode/gpt-5.4-mini")).toEqual({
      name: "GPT 5.4 Mini",
      efforts: ["high", "none", "xhigh"],
    });
  });
});
