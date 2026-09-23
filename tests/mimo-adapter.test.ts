import { describe, expect, it } from "vitest";
import { MIMO_MODELS, MimoAdapter, createMimoMapper } from "../src/agents/mimo";
import { fallbackMimoEfforts } from "../src/agents/mimo-efforts-fallback";
import { parseOpencodeModelsVerbose } from "../src/agents/opencode-variants";

/**
 * Mimo is an OpenCode fork for protocol only (`run --format json`). Its model
 * catalog is Xiaomi's, not a renamed OpenCode Zen/Go list.
 */

describe("MIMO_MODELS", () => {
  it("ships the Xiaomi MiMo Code catalog with MiMo Auto as the free default", () => {
    expect(MIMO_MODELS.map((m) => m.id)).toEqual([
      "mimo/mimo-auto",
      "xiaomi/mimo-v2.6-flash",
      "xiaomi/mimo-v2.6-pro",
      "xiaomi/mimo-v2.6-pro-ultraspeed",
      "xiaomi/mimo-v2.5",
      "xiaomi/mimo-v2.5-pro",
      "xiaomi/mimo-v2.5-pro-ultraspeed",
    ]);
    expect(MIMO_MODELS.find((m) => m.id === "mimo/mimo-auto")).toMatchObject({
      name: "MiMo Auto",
    });
    expect(MIMO_MODELS.some((m) => m.id.startsWith("mimo-go/"))).toBe(false);
    expect(MIMO_MODELS.some((m) => m.id.startsWith("opencode"))).toBe(false);
    expect(MIMO_MODELS.some((m) => m.id.includes("claude") || m.id.includes("gpt"))).toBe(false);
  });
});

describe("fallbackMimoEfforts", () => {
  it("exposes low/medium/high for built-in MiMo models", () => {
    expect(fallbackMimoEfforts("mimo/mimo-auto")).toEqual(["low", "medium", "high"]);
    expect(fallbackMimoEfforts("xiaomi/mimo-v2.5-pro")).toEqual(["low", "medium", "high"]);
    expect(fallbackMimoEfforts("openai/gpt-5")).toEqual([]);
  });
});

describe("parseOpencodeModelsVerbose (mimo-compatible)", () => {
  it("parses mimo models --verbose blocks", () => {
    const output = [
      "mimo/mimo-auto",
      "{",
      '  "name": "MiMo Auto",',
      '  "variants": { "low": {}, "medium": {}, "high": {} }',
      "}",
      "xiaomi/mimo-v2.5-pro",
      "{",
      '  "name": "MiMo-V2.5-Pro",',
      '  "variants": { "high": {} }',
      "}",
    ].join("\n");
    const parsed = parseOpencodeModelsVerbose(output);
    expect(parsed.get("mimo/mimo-auto")).toEqual({
      name: "MiMo Auto",
      efforts: ["high", "low", "medium"],
    });
    expect(parsed.get("xiaomi/mimo-v2.5-pro")?.name).toBe("MiMo-V2.5-Pro");
  });
});

describe("createMimoMapper", () => {
  it("tags emitted events with the mimo agent id", () => {
    const m = createMimoMapper();
    const events = m(JSON.parse('{"type":"step_start","sessionID":"ses_abc"}'));
    expect(events).toEqual([
      expect.objectContaining({ kind: "session_start", agent: "mimo", sessionId: "ses_abc" }),
    ]);
  });
});

describe("MimoAdapter", () => {
  it("defaults to the mimo binary and MiMo Auto", () => {
    const adapter = new MimoAdapter();
    expect(adapter.id).toBe("mimo");
    expect(adapter.binary).toBe("mimo");
    expect(adapter.defaultModel).toBe("mimo/mimo-auto");
    expect(adapter.supportsResume).toBe(true);
  });

  it("accepts a custom binary override", () => {
    expect(new MimoAdapter("mimo-cli").binary).toBe("mimo-cli");
  });
});
