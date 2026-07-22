import { describe, expect, it } from "vitest";
import { MIMO_MODELS, MimoAdapter, createMimoMapper } from "../src/agents/mimo";
import { OPENCODE_MODELS } from "../src/agents/opencode";

/**
 * Mimo is an OpenCode fork: same `run --format json` protocol under a
 * different binary/branding, so it reuses createOpenCodeMapper /
 * buildOpenCodeRunArgs verbatim (see tests/opencode-adapter.test.ts for
 * protocol-level coverage). These tests only cover mimo-specific wiring.
 */

describe("MIMO_MODELS", () => {
  it("mirrors the OpenCode catalog with the provider prefix swapped", () => {
    expect(MIMO_MODELS).toHaveLength(OPENCODE_MODELS.length);
    expect(MIMO_MODELS.find((m) => m.id === "mimo/claude-sonnet-5")).toMatchObject({
      name: "Claude Sonnet 5",
    });
    expect(MIMO_MODELS.find((m) => m.id === "mimo-go/kimi-k3")).toMatchObject({ name: "Kimi K3" });
    expect(MIMO_MODELS.some((m) => m.id.startsWith("opencode"))).toBe(false);
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
  it("defaults to the mimo binary and a free default model", () => {
    const adapter = new MimoAdapter();
    expect(adapter.id).toBe("mimo");
    expect(adapter.binary).toBe("mimo");
    expect(adapter.defaultModel).toBe("mimo/mimo-v2.5-free");
    expect(adapter.supportsResume).toBe(true);
  });

  it("accepts a custom binary override", () => {
    expect(new MimoAdapter("mimo-cli").binary).toBe("mimo-cli");
  });
});
