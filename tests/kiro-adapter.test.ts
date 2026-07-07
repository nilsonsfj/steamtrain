import { describe, expect, it } from "vitest";
import { buildKiroExecArgs, createKiroMapper } from "../src/agents/kiro";
import type { AgentEvent } from "../src/types/events";

/**
 * Sample lines from `kiro --print --output-format stream-json --verbose`.
 * kiro emits Claude Code-compatible message-level stream JSON (like amp).
 */
const SAMPLES = {
  init: '{"type":"system","subtype":"init","session_id":"sess-001","model":"sonnet","tools":["Read","Write","Bash"]}',
  userEcho:
    '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"say PONG"}]},"session_id":"sess-001"}',
  assistantText:
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"PONG"}]},"session_id":"sess-001"}',
  assistantThinking:
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"The user wants PONG"}]},"session_id":"sess-001"}',
  assistantToolUse:
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}}]},"session_id":"sess-001"}',
  userToolResult:
    '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"file1\\nfile2","is_error":false}]}}',
  resultSuccess:
    '{"type":"result","subtype":"success","is_error":false,"duration_ms":2100,"result":"PONG","total_cost_usd":0.0045,"usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":20}}',
  resultError:
    '{"type":"result","subtype":"error_during_execution","duration_ms":500,"is_error":true,"error":"Authentication failed. Please run kiro and authenticate.","session_id":"sess-001"}',
  status: '{"type":"system","subtype":"status","status":"thinking","session_id":"sess-001"}',
  unknown: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
} as const;

function map(line: string): AgentEvent[] {
  return createKiroMapper()(JSON.parse(line));
}

describe("kiro mapper", () => {
  it("maps system/init to session_start with session_id, model and tools", () => {
    const [event, ...rest] = map(SAMPLES.init);
    expect(rest).toHaveLength(0);
    expect(event).toMatchObject({
      kind: "session_start",
      agent: "kiro",
      sessionId: "sess-001",
      model: "sonnet",
      tools: ["Read", "Write", "Bash"],
    });
  });

  it("emits text straight from assistant text blocks (no partial deltas)", () => {
    expect(map(SAMPLES.assistantText)).toEqual([
      expect.objectContaining({ kind: "text_delta", agent: "kiro", text: "PONG" }),
    ]);
  });

  it("maps assistant thinking blocks to thinking-flagged text deltas", () => {
    expect(map(SAMPLES.assistantThinking)).toEqual([
      expect.objectContaining({
        kind: "text_delta",
        text: "The user wants PONG",
        thinking: true,
      }),
    ]);
  });

  it("emits tool_use from an assistant tool_use block", () => {
    expect(map(SAMPLES.assistantToolUse)).toEqual([
      expect.objectContaining({
        kind: "tool_use",
        id: "toolu_1",
        name: "Bash",
        input: { command: "ls" },
      }),
    ]);
  });

  it("emits tool_result from a user tool_result block", () => {
    expect(map(SAMPLES.userToolResult)).toEqual([
      expect.objectContaining({
        kind: "tool_result",
        id: "toolu_1",
        output: "file1\nfile2",
        isError: false,
      }),
    ]);
  });

  it("treats the echoed user prompt as a no-op (no tool_result)", () => {
    expect(map(SAMPLES.userEcho)).toEqual([]);
  });

  it("maps a successful result with text, duration, cost and tokens", () => {
    const events = map(SAMPLES.resultSuccess);
    expect(events).toEqual([
      expect.objectContaining({
        kind: "result",
        isError: false,
        text: "PONG",
        subtype: "success",
        durationMs: 2100,
        costUsd: 0.0045,
        tokens: { input: 100, output: 50, cacheRead: 20 },
      }),
    ]);
  });

  it("surfaces a failed result's message as an error", () => {
    const events = map(SAMPLES.resultError);
    const error = events.find((e) => e.kind === "error");
    expect(error).toMatchObject({ kind: "error", agent: "kiro" });
    expect((error as { message: string }).message).toContain("Authentication failed");
    expect(events.some((e) => e.kind === "result" && e.isError === true)).toBe(true);
  });

  it("ignores system status events", () => {
    expect(map(SAMPLES.status)).toEqual([]);
  });

  it("passes through unrecognized top-level types as unknown", () => {
    expect(map(SAMPLES.unknown)).toEqual([
      expect.objectContaining({ kind: "unknown", rawType: "content_block_delta" }),
    ]);
  });

  it("never throws on malformed/empty objects", () => {
    expect(() => createKiroMapper()({})).not.toThrow();
    expect(createKiroMapper()({ type: "assistant" })).toEqual([
      expect.objectContaining({ kind: "unknown" }),
    ]);
  });
});

describe("buildKiroExecArgs", () => {
  it("builds standard args for print mode with stream-json", () => {
    const args = buildKiroExecArgs({ prompt: "do a thing", model: "sonnet" });
    expect(args).toEqual([
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "sonnet",
    ]);
  });

  it("appends --effort when provided", () => {
    const args = buildKiroExecArgs({ prompt: "go", model: "opus", effort: "high" });
    expect(args).toEqual([
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "opus",
      "--effort",
      "high",
    ]);
  });

  it("appends extraArgs after effort", () => {
    const args = buildKiroExecArgs({
      prompt: "go",
      model: "sonnet",
      effort: "max",
      extraArgs: ["--no-tool", "Bash"],
    });
    expect(args).toEqual([
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "sonnet",
      "--effort",
      "max",
      "--no-tool",
      "Bash",
    ]);
  });

  it("omits --effort when not provided", () => {
    const args = buildKiroExecArgs({ prompt: "go", model: "haiku" });
    expect(args).not.toContain("--effort");
  });
});
