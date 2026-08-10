import { describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_MODELS,
  AntigravityAdapter,
  buildAntigravityRunArgs,
  extractAntigravityConversationId,
  formatAntigravityPrintTimeout,
  resolveAntigravityModel,
  runAntigravityProcess,
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
        model: "gemini-3.6-flash-high",
      }),
    ).toEqual([
      "--model",
      "gemini-3.6-flash-high",
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
        model: "gemini-3.5-flash-low",
        resumeSessionId: "conv-123",
        timeoutMs: 90_000,
        extraArgs: ["--sandbox", "--add-dir", "/tmp/extra"],
      }),
    ).toEqual([
      "--model",
      "gemini-3.5-flash-low",
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

  it("rewrites legacy display labels to current slug ids", () => {
    expect(
      buildAntigravityRunArgs({
        prompt: "hello world",
        model: "Gemini 3.1 Pro (High)",
      }),
    ).toEqual([
      "--model",
      "gemini-3.1-pro-high",
      "--dangerously-skip-permissions",
      "--mode",
      "accept-edits",
      "--print",
      "hello world",
    ]);
  });

  it("rewrites base legacy display labels with effort to slug form", () => {
    expect(
      buildAntigravityRunArgs({
        prompt: "hello world",
        model: "Gemini 3.1 Pro",
        effort: "high",
      }),
    ).toContain("gemini-3.1-pro-high");
    expect(
      buildAntigravityRunArgs({
        prompt: "hello world",
        model: "Gemini 3.1 Pro",
        effort: "high",
      }),
    ).not.toContain("(High)");
  });
});

describe("resolveAntigravityModel", () => {
  it("appends slug effort suffix when model has none", () => {
    expect(resolveAntigravityModel("gemini-3.1-pro", "high")).toBe("gemini-3.1-pro-high");
    expect(resolveAntigravityModel("gemini-3.5-flash", "low")).toBe("gemini-3.5-flash-low");
    expect(resolveAntigravityModel("gemini-3.6-flash", "medium")).toBe("gemini-3.6-flash-medium");
  });

  it("rewrites legacy display labels and applies effort as a slug suffix", () => {
    expect(resolveAntigravityModel("Gemini 3.1 Pro", "high")).toBe("gemini-3.1-pro-high");
    expect(resolveAntigravityModel("Gemini 3.5 Flash", "low")).toBe("gemini-3.5-flash-low");
    // Live agy lists Sonnet as bare id only; thinking/medium suffixes are rejected.
    expect(resolveAntigravityModel("Claude Sonnet 4.6", "thinking")).toBe("claude-sonnet-4-6");
    expect(resolveAntigravityModel("Claude Sonnet 4.6 (Thinking)")).toBe("claude-sonnet-4-6");
  });

  it("leaves models that already have an effort suffix alone", () => {
    expect(resolveAntigravityModel("gemini-3.1-pro-high", "low")).toBe("gemini-3.1-pro-high");
    expect(resolveAntigravityModel("Gemini 3.1 Pro (High)", "low")).toBe("gemini-3.1-pro-high");
  });

  it("never double-appends paren effort onto a slug that already has -high", () => {
    // Regression: babysit fan-out failed with
    // `--model "gemini-3.6-flash-high (High)"` when effort=high was also set.
    expect(resolveAntigravityModel("gemini-3.6-flash-high", "high")).toBe("gemini-3.6-flash-high");
    expect(resolveAntigravityModel("gemini-3.6-flash-high", "High")).toBe("gemini-3.6-flash-high");
    expect(
      buildAntigravityRunArgs({
        prompt: "x",
        model: "gemini-3.6-flash-high",
        effort: "high",
      }),
    ).toContain("gemini-3.6-flash-high");
    expect(
      buildAntigravityRunArgs({
        prompt: "x",
        model: "gemini-3.6-flash-high",
        effort: "high",
      }),
    ).not.toContain("gemini-3.6-flash-high (High)");
  });

  it("repairs already-glued slug + paren hybrids", () => {
    expect(resolveAntigravityModel("gemini-3.6-flash-high (High)")).toBe("gemini-3.6-flash-high");
    expect(resolveAntigravityModel("gemini-3.6-flash-high (High)", "high")).toBe(
      "gemini-3.6-flash-high",
    );
    expect(resolveAntigravityModel("gemini-3.5-flash-medium (Medium)")).toBe(
      "gemini-3.5-flash-medium",
    );
    expect(resolveAntigravityModel("gemini-3.5-flash-low (Low)")).toBe("gemini-3.5-flash-low");
    expect(resolveAntigravityModel("claude-opus-4-6-thinking (Thinking)")).toBe(
      "claude-opus-4-6-thinking",
    );
  });

  it("accepts case-insensitive legacy display labels", () => {
    expect(resolveAntigravityModel("gemini 3.1 pro (high)")).toBe("gemini-3.1-pro-high");
    expect(resolveAntigravityModel("GEMINI 3.6 FLASH", "high")).toBe("gemini-3.6-flash-high");
  });

  it("ignores unknown effort labels", () => {
    expect(resolveAntigravityModel("gemini-3.1-pro", "mystery")).toBe("gemini-3.1-pro-high");
  });

  it("defaults bare Gemini bases to -high when effort is missing", () => {
    // Regression: agy rejects `--model gemini-3.6-flash` without --effort.
    expect(resolveAntigravityModel("gemini-3.6-flash")).toBe("gemini-3.6-flash-high");
    expect(resolveAntigravityModel("Gemini 3.6 Flash")).toBe("gemini-3.6-flash-high");
    expect(resolveAntigravityModel("gemini-3.5-flash")).toBe("gemini-3.5-flash-high");
    expect(resolveAntigravityModel("gemini-3.1-pro")).toBe("gemini-3.1-pro-high");
    expect(resolveAntigravityModel("gemini-3.6-flash", "")).toBe("gemini-3.6-flash-high");
    expect(resolveAntigravityModel("gemini-3.6-flash", "medium")).toBe("gemini-3.6-flash-medium");
  });

  it("does not invent effort suffixes for Claude Sonnet", () => {
    // Regression: babysit prepare failed with
    // `--model "claude-sonnet-4-6-medium"` when effort=medium was carried over.
    expect(resolveAntigravityModel("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(resolveAntigravityModel("claude-sonnet-4-6", "medium")).toBe("claude-sonnet-4-6");
    expect(resolveAntigravityModel("claude-sonnet-4-6", "high")).toBe("claude-sonnet-4-6");
    expect(resolveAntigravityModel("claude-sonnet-4-6", "thinking")).toBe("claude-sonnet-4-6");
    expect(resolveAntigravityModel("claude-sonnet-4-6-thinking")).toBe("claude-sonnet-4-6");
    expect(
      buildAntigravityRunArgs({
        prompt: "x",
        model: "claude-sonnet-4-6",
        effort: "medium",
      }),
    ).toContain("claude-sonnet-4-6");
    expect(
      buildAntigravityRunArgs({
        prompt: "x",
        model: "claude-sonnet-4-6",
        effort: "medium",
      }),
    ).not.toContain("claude-sonnet-4-6-medium");
  });

  it("defaults bare Opus / GPT-OSS bases to their only live variants", () => {
    expect(resolveAntigravityModel("claude-opus-4-6")).toBe("claude-opus-4-6-thinking");
    expect(resolveAntigravityModel("claude-opus-4-6", "thinking")).toBe("claude-opus-4-6-thinking");
    expect(resolveAntigravityModel("gpt-oss-120b")).toBe("gpt-oss-120b-medium");
    expect(resolveAntigravityModel("gpt-oss-120b", "medium")).toBe("gpt-oss-120b-medium");
    // Unsupported efforts fall back to the model's default variant.
    expect(resolveAntigravityModel("gpt-oss-120b", "high")).toBe("gpt-oss-120b-medium");
  });

  it("does not invent gemini-3.1-pro-medium (pro only has low|high)", () => {
    expect(resolveAntigravityModel("gemini-3.1-pro", "medium")).toBe("gemini-3.1-pro-high");
    expect(resolveAntigravityModel("gemini-3.1-pro-medium")).toBe("gemini-3.1-pro-high");
    expect(resolveAntigravityModel("gemini-3.1-pro", "low")).toBe("gemini-3.1-pro-low");
    expect(resolveAntigravityModel("Gemini 3.1 Pro (Medium)")).toBe("gemini-3.1-pro-high");
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
    expect(
      extractAntigravityConversationId(
        "Stream goroutine exited for deadbeef-1234-5678-9abc-def012345678, sending completion signal",
      ),
    ).toBe("deadbeef-1234-5678-9abc-def012345678");
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

  it("prefers an explicit conversationId over the cwd last_conversations map", () => {
    const recovered = recoverAntigravityTranscriptText({
      cwd: "/tmp/demo",
      conversationId: "known-id",
      lastConversations: { "/tmp/demo": "stale-other-id" },
      readTranscript: (id) =>
        id === "known-id"
          ? `${JSON.stringify({
              source: "MODEL",
              type: "PLANNER_RESPONSE",
              content: "known transcript",
            })}\n`
          : id === "stale-other-id"
            ? `${JSON.stringify({
                source: "MODEL",
                type: "PLANNER_RESPONSE",
                content: "wrong transcript",
              })}\n`
            : undefined,
    });
    expect(recovered).toEqual({ conversationId: "known-id", text: "known transcript" });
  });
});

describe("runAntigravityProcess", () => {
  async function collect(
    events: AsyncIterable<import("../src/types/events").AgentEvent>,
  ): Promise<import("../src/types/events").AgentEvent[]> {
    const out: import("../src/types/events").AgentEvent[] = [];
    for await (const event of events) out.push(event);
    return out;
  }

  it("keeps stdin closed and streams stderr session + stdout text", async () => {
    let seenOpts: import("../src/agents/spawn").ProcessRunOptions | undefined;
    const events = await collect(
      runAntigravityProcess({
        id: "antigravity",
        binary: "agy",
        args: buildAntigravityRunArgs({
          prompt: "hi",
          model: "Gemini 3.5 Flash (Low)",
        }),
        opts: {
          prompt: "hi",
          model: "Gemini 3.5 Flash (Low)",
          cwd: "/tmp/demo",
        },
        runLines: async function* (opts) {
          seenOpts = opts;
          yield {
            kind: "stderr",
            text: "Created conversation abc-111-def",
          };
          yield { kind: "line", line: "hello" };
          yield {
            kind: "exit",
            code: 0,
            signal: null,
            timedOut: false,
            stderr: "Created conversation abc-111-def",
            sawStdout: true,
          };
        },
      }),
    );

    expect(seenOpts?.prompt).toBeUndefined();
    expect(events.map((e) => e.kind)).toEqual(["session_start", "text_delta", "result"]);
    expect(events[0]).toMatchObject({
      kind: "session_start",
      sessionId: "abc-111-def",
      model: "gemini-3.5-flash-low",
    });
    expect(events[1]).toMatchObject({ kind: "text_delta", text: "hello\n" });
    expect(events[2]).toMatchObject({ kind: "result", text: "hello", isError: false });
  });

  it("recovers empty stdout using the known conversation id, not a stale cwd mapping", async () => {
    const recoverCalls: Array<{ cwd: string; conversationId?: string }> = [];
    const events = await collect(
      runAntigravityProcess({
        id: "antigravity",
        binary: "agy",
        args: [],
        opts: {
          prompt: "hi",
          model: "Gemini 3.1 Pro (High)",
          cwd: "/tmp/demo",
          resumeSessionId: "resume-id",
        },
        runLines: async function* () {
          yield {
            kind: "exit",
            code: 0,
            signal: null,
            timedOut: false,
            stderr: "",
            sawStdout: false,
          };
        },
        recoverTranscript: (options) => {
          recoverCalls.push({
            cwd: options.cwd,
            conversationId: options.conversationId,
          });
          return { conversationId: "resume-id", text: "from known id" };
        },
        lastConversationForCwd: () => "stale-cwd-id",
      }),
    );

    expect(recoverCalls).toEqual([{ cwd: "/tmp/demo", conversationId: "resume-id" }]);
    expect(events.map((e) => e.kind)).toEqual(["session_start", "text_delta", "result"]);
    expect(events[0]).toMatchObject({ kind: "session_start", sessionId: "resume-id" });
    expect(events[2]).toMatchObject({ kind: "result", text: "from known id" });
  });

  it("emits session_start even when empty-output recovery fails", async () => {
    const events = await collect(
      runAntigravityProcess({
        id: "antigravity",
        binary: "agy",
        args: [],
        opts: {
          prompt: "hi",
          model: "Gemini 3.1 Pro (High)",
          cwd: "/tmp/demo",
        },
        runLines: async function* () {
          yield {
            kind: "stderr",
            text: "Stream completed for 1858e0e0-832e-469a-8f82-51d0f56a954f, clearing ResponsePending",
          };
          yield {
            kind: "exit",
            code: 0,
            signal: null,
            timedOut: false,
            stderr:
              "Stream completed for 1858e0e0-832e-469a-8f82-51d0f56a954f, clearing ResponsePending",
            sawStdout: false,
          };
        },
        recoverTranscript: () => undefined,
      }),
    );

    expect(events.map((e) => e.kind)).toEqual(["session_start", "error"]);
    expect(events[0]).toMatchObject({
      kind: "session_start",
      sessionId: "1858e0e0-832e-469a-8f82-51d0f56a954f",
    });
    expect(events[1]).toMatchObject({
      kind: "error",
      message: expect.stringContaining("produced no output"),
    });
  });

  it("falls back to last_conversations when stderr has no id but stdout succeeded", async () => {
    const events = await collect(
      runAntigravityProcess({
        id: "antigravity",
        binary: "agy",
        args: [],
        opts: {
          prompt: "hi",
          model: "Gemini 3.1 Pro (High)",
          cwd: "/tmp/demo",
        },
        runLines: async function* () {
          yield { kind: "line", line: "pong" };
          yield {
            kind: "exit",
            code: 0,
            signal: null,
            timedOut: false,
            stderr: "",
            sawStdout: true,
          };
        },
        lastConversationForCwd: (path) => (path === "/tmp/demo" ? "from-cache" : undefined),
      }),
    );

    expect(events.map((e) => e.kind)).toEqual(["session_start", "text_delta", "result"]);
    expect(events[0]).toMatchObject({ kind: "session_start", sessionId: "from-cache" });
    expect(events[1]).toMatchObject({ kind: "text_delta", text: "pong\n" });
  });

  it("reports spawn failure, timeout, and non-zero exit", async () => {
    const spawnEvents = await collect(
      runAntigravityProcess({
        id: "antigravity",
        binary: "agy",
        args: [],
        opts: { prompt: "hi", model: "Gemini 3.1 Pro (High)", cwd: "/tmp/demo" },
        lastConversationForCwd: () => undefined,
        runLines: async function* () {
          yield {
            kind: "exit",
            code: null,
            signal: null,
            timedOut: false,
            stderr: "",
            sawStdout: false,
            spawnError: "ENOENT",
          };
        },
      }),
    );
    expect(spawnEvents).toEqual([
      expect.objectContaining({
        kind: "error",
        message: "failed to start 'agy': ENOENT",
      }),
    ]);

    const timeoutEvents = await collect(
      runAntigravityProcess({
        id: "antigravity",
        binary: "agy",
        args: [],
        opts: {
          prompt: "hi",
          model: "Gemini 3.1 Pro (High)",
          timeoutMs: 5000,
          cwd: "/tmp/demo",
        },
        lastConversationForCwd: () => undefined,
        runLines: async function* () {
          yield {
            kind: "exit",
            code: null,
            signal: "SIGTERM",
            timedOut: true,
            stderr: "",
            sawStdout: false,
          };
        },
      }),
    );
    expect(timeoutEvents).toEqual([
      expect.objectContaining({
        kind: "error",
        message: "'agy' timed out after 5s",
      }),
    ]);

    const exitEvents = await collect(
      runAntigravityProcess({
        id: "antigravity",
        binary: "agy",
        args: [],
        opts: { prompt: "hi", model: "Gemini 3.1 Pro (High)", cwd: "/tmp/demo" },
        lastConversationForCwd: () => undefined,
        runLines: async function* () {
          yield {
            kind: "exit",
            code: 2,
            signal: null,
            timedOut: false,
            stderr: "auth failed\nmore detail",
            sawStdout: false,
          };
        },
      }),
    );
    expect(exitEvents).toEqual([
      expect.objectContaining({
        kind: "error",
        message: "'agy' exited with code 2: auth failed",
        code: 2,
      }),
    ]);
  });
});

describe("AntigravityAdapter metadata", () => {
  it("exposes provider identity and resume support", () => {
    const adapter = new AntigravityAdapter();
    expect(adapter.id).toBe("antigravity");
    expect(adapter.binary).toBe("agy");
    expect(adapter.defaultModel).toBe("gemini-3.6-flash-high");
    expect(adapter.supportsResume).toBe(true);
    expect(ANTIGRAVITY_MODELS.some((m) => m.id === adapter.defaultModel)).toBe(true);
  });
});
