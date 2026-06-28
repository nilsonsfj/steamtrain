import { describe, expect, it } from "vitest";
import { buildAmpExecArgs, createAmpMapper } from "../src/agents/amp";
import type { AgentEvent } from "../src/types/events";

/**
 * Sample lines from `amp --execute "…" --stream-json --stream-json-thinking`.
 * The `init`, `user` and `result` (error) lines were captured from a real run;
 * the assistant/result-success lines use amp's Claude Code-compatible,
 * message-level shape (amp does NOT emit partial `stream_event` deltas).
 */
const SAMPLES = {
  init: '{"type":"system","subtype":"init","cwd":"/x","session_id":"T-019f02d6-71be-71b6-af01-6d1072845ec5","tools":["Bash","create_file","edit_file"],"mcp_servers":[],"agent_mode":"smart","reasoning_effort":"high"}',
  userEcho:
    '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"say PONG"}]},"parent_tool_use_id":null,"session_id":"T-1"}',
  assistantText:
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"PONG"}]},"session_id":"T-1"}',
  assistantThinking:
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"The user wants PONG"}]},"session_id":"T-1"}',
  assistantToolUse:
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}}]},"session_id":"T-1"}',
  userToolResult:
    '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"file1\\nfile2","is_error":false}]}}',
  resultSuccess:
    '{"type":"result","subtype":"success","is_error":false,"duration_ms":1462,"result":"PONG","total_cost_usd":0.0123}',
  resultError:
    '{"type":"result","subtype":"error_during_execution","duration_ms":1435,"is_error":true,"num_turns":0,"error":"Execute mode (amp -x) and the Amp SDK require paid credits and cannot use Amp Free in non-interactive contexts. Add credits at https://ampcode.com/pay to continue.","session_id":"T-1"}',
  status: '{"type":"system","subtype":"status","status":"thinking","session_id":"T-1"}',
  unknown: '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}',
} as const;

function map(line: string): AgentEvent[] {
  return createAmpMapper()(JSON.parse(line));
}

describe("amp mapper", () => {
  it("maps system/init to session_start with ids, mode-as-model and tools", () => {
    const [event, ...rest] = map(SAMPLES.init);
    expect(rest).toHaveLength(0);
    expect(event).toMatchObject({
      kind: "session_start",
      agent: "amp",
      sessionId: "T-019f02d6-71be-71b6-af01-6d1072845ec5",
      model: "smart",
      tools: ["Bash", "create_file", "edit_file"],
    });
  });

  it("emits text straight from assistant text blocks (no partial deltas)", () => {
    expect(map(SAMPLES.assistantText)).toEqual([
      expect.objectContaining({ kind: "text_delta", agent: "amp", text: "PONG" }),
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

  it("maps a successful result with text, duration and cost", () => {
    expect(map(SAMPLES.resultSuccess)).toEqual([
      expect.objectContaining({
        kind: "result",
        isError: false,
        text: "PONG",
        subtype: "success",
        durationMs: 1462,
        costUsd: 0.0123,
      }),
    ]);
  });

  it("surfaces a failed result's message as an error (e.g. no credits)", () => {
    const events = map(SAMPLES.resultError);
    const error = events.find((e) => e.kind === "error");
    expect(error).toMatchObject({ kind: "error", agent: "amp" });
    expect((error as { message: string }).message).toContain("paid credits");
    // The result event still follows so totals/duration are recorded.
    expect(events.some((e) => e.kind === "result" && e.isError === true)).toBe(true);
  });

  it("ignores system status events", () => {
    expect(map(SAMPLES.status)).toEqual([]);
  });

  it("passes through unrecognized top-level types as unknown", () => {
    expect(map(SAMPLES.unknown)).toEqual([
      expect.objectContaining({ kind: "unknown", rawType: "rate_limit_event" }),
    ]);
  });

  it("never throws on malformed/empty objects", () => {
    expect(() => createAmpMapper()({})).not.toThrow();
    expect(createAmpMapper()({ type: "assistant" })).toEqual([
      expect.objectContaining({ kind: "unknown" }),
    ]);
  });
});

describe("buildAmpExecArgs", () => {
  it("attaches the prompt to -x and requests Claude-compatible stream JSON", () => {
    const args = buildAmpExecArgs({ prompt: "do a thing", model: "smart" });
    expect(args).toEqual([
      "-x",
      "",
      "--stream-json",
      "--stream-json-thinking",
      "-m",
      "smart",
    ]);
  });

  it("appends --effort and extraArgs when provided", () => {
    const args = buildAmpExecArgs({
      prompt: "go",
      model: "deep",
      effort: "xhigh",
      extraArgs: ["--no-archive-after-execute"],
    });
    expect(args).toEqual([
      "-x",
      "",
      "--stream-json",
      "--stream-json-thinking",
      "-m",
      "deep",
      "--effort",
      "xhigh",
      "--no-archive-after-execute",
    ]);
  });

  it("drops --effort for the rush mode, which rejects reasoning effort", () => {
    const args = buildAmpExecArgs({ prompt: "go", model: "rush", effort: "high" });
    expect(args).not.toContain("--effort");
    expect(args).toEqual(["-x", "", "--stream-json", "--stream-json-thinking", "-m", "rush"]);
  });
});
