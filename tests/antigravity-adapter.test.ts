import { describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_MODELS,
  AntigravityAdapter,
  buildAntigravityRunArgs,
  extractAntigravityConversationId,
  formatAntigravityPrintTimeout,
  resolveAntigravityModel,
} from "../src/agents/antigravity";
import {
  parseAntigravityPlannerResponse,
  recoverAntigravityTranscriptText,
} from "../src/agents/antigravity-transcript";

describe("buildAntigravityRunArgs", () => {
  it("puts --print and the prompt last, with headless safety flags", () => {
    expect(
      buildAntigravityRunArgs({
        prompt: "hello world",
        model: "Gemini 3.1 Pro (High)",
      }),
    ).toEqual([
      "--model",
      "Gemini 3.1 Pro (High)",
      "--dangerously-skip-permissions",
      "--mode",
      "accept-edits",
      "--print",
      "hello world",
    ]);
  });

  it("includes resume, print-timeout, and extraArgs before --print", () => {
    expect(
      buildAntigravityRunArgs({
        prompt: "continue",
        model: "Gemini 3.5 Flash (Low)",
        resumeSessionId: "conv-123",
        timeoutMs: 90_000,
        extraArgs: ["--sandbox", "--add-dir", "/tmp/extra"],
      }),
    ).toEqual([
      "--model",
      "Gemini 3.5 Flash (Low)",
      "--dangerously-skip-permissions",
      "--mode",
      "accept-edits",
      "--conversation",
      "conv-123",
      "--print-timeout",
      "90s",
      "--sandbox",
      "--add-dir",
      "/tmp/extra",
      "--print",
      "continue",
    ]);
  });
});

describe("resolveAntigravityModel", () => {
  it("appends effort suffix when model has none", () => {
    expect(resolveAntigravityModel("Gemini 3.1 Pro", "high")).toBe("Gemini 3.1 Pro (High)");
    expect(resolveAntigravityModel("Gemini 3.5 Flash", "low")).toBe("Gemini 3.5 Flash (Low)");
    expect(resolveAntigravityModel("Claude Sonnet 4.6", "thinking")).toBe(
      "Claude Sonnet 4.6 (Thinking)",
    );
  });

  it("leaves models that already have a parenthetical suffix alone", () => {
    expect(resolveAntigravityModel("Gemini 3.1 Pro (High)", "low")).toBe("Gemini 3.1 Pro (High)");
  });

  it("ignores unknown effort labels", () => {
    expect(resolveAntigravityModel("Gemini 3.1 Pro", "mystery")).toBe("Gemini 3.1 Pro");
  });
});

describe("formatAntigravityPrintTimeout", () => {
  it("formats milliseconds as whole seconds", () => {
    expect(formatAntigravityPrintTimeout(1000)).toBe("1s");
    expect(formatAntigravityPrintTimeout(90_000)).toBe("90s");
    expect(formatAntigravityPrintTimeout(1500)).toBe("2s");
  });

  it("returns undefined for missing/non-positive timeouts", () => {
    expect(formatAntigravityPrintTimeout(undefined)).toBeUndefined();
    expect(formatAntigravityPrintTimeout(0)).toBeUndefined();
  });
});

describe("extractAntigravityConversationId", () => {
  it("parses common stderr patterns", () => {
    expect(extractAntigravityConversationId("Created conversation abc-123-def")).toBe(
      "abc-123-def",
    );
    expect(
      extractAntigravityConversationId(
        "Print mode: conversation=9f926293-5fd5-48ca-b3d6-2111119c9b7a, sending message",
      ),
    ).toBe("9f926293-5fd5-48ca-b3d6-2111119c9b7a");
    expect(
      extractAntigravityConversationId(
        "Stream completed for 1858e0e0-832e-469a-8f82-51d0f56a954f, clearing ResponsePending",
      ),
    ).toBe("1858e0e0-832e-469a-8f82-51d0f56a954f");
  });

  it("returns undefined when no id is present", () => {
    expect(extractAntigravityConversationId("no conversation here")).toBeUndefined();
  });
});

describe("transcript recovery helpers", () => {
  it("extracts the last PLANNER_RESPONSE content", () => {
    const jsonl = [
      JSON.stringify({
        source: "USER",
        type: "USER_INPUT",
        content: "hi",
      }),
      JSON.stringify({
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "first",
      }),
      JSON.stringify({
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "final answer",
      }),
    ].join("\n");
    expect(parseAntigravityPlannerResponse(jsonl)).toBe("final answer");
  });

  it("returns undefined for empty or unrelated transcripts", () => {
    expect(parseAntigravityPlannerResponse("")).toBeUndefined();
    expect(
      parseAntigravityPlannerResponse(
        JSON.stringify({ source: "MODEL", type: "THINKING", content: "hmm" }),
      ),
    ).toBeUndefined();
  });

  it("recovers text from an injected last_conversations map + transcript", () => {
    const conversationId = "conv-recover-1";
    const text = recoverAntigravityTranscriptText({
      cwd: "/tmp/demo",
      lastConversations: { "/tmp/demo": conversationId },
      readTranscript: (id) =>
        id === conversationId
          ? `${JSON.stringify({
              source: "MODEL",
              type: "PLANNER_RESPONSE",
              content: "from transcript",
            })}\n`
          : undefined,
    });
    expect(text).toEqual({ conversationId, text: "from transcript" });
  });
});

describe("AntigravityAdapter metadata", () => {
  it("exposes provider identity and resume support", () => {
    const adapter = new AntigravityAdapter();
    expect(adapter.id).toBe("antigravity");
    expect(adapter.binary).toBe("agy");
    expect(adapter.defaultModel).toBe("Gemini 3.1 Pro (High)");
    expect(adapter.supportsResume).toBe(true);
    expect(ANTIGRAVITY_MODELS.some((m) => m.id === adapter.defaultModel)).toBe(true);
  });
});
