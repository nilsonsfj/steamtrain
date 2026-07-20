import { describe, expect, it } from "vitest";
import { createCursorMapper } from "../src/agents/cursor";
import type { AgentEvent } from "../src/types/events";

const SAMPLES = {
  init: '{"type":"system","subtype":"init","apiKeySource":"login","cwd":"/tmp","session_id":"sess-c1","model":"Composer 2.5","permissionMode":"default"}',
  userEcho:
    '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]},"session_id":"sess-c1"}',
  assistantDelta:
    '{"type":"assistant","timestamp_ms":1000,"message":{"role":"assistant","content":[{"type":"text","text":"Hel"}]},"session_id":"sess-c1"}',
  assistantDelta2:
    '{"type":"assistant","timestamp_ms":1001,"message":{"role":"assistant","content":[{"type":"text","text":"lo"}]},"session_id":"sess-c1"}',
  assistantFlushBeforeTool:
    '{"type":"assistant","timestamp_ms":1002,"model_call_id":"mc1","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]},"session_id":"sess-c1"}',
  assistantFinalFlush:
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]},"session_id":"sess-c1"}',
  toolStartedRead:
    '{"type":"tool_call","subtype":"started","call_id":"c1","tool_call":{"readToolCall":{"args":{"path":"README.md"}}},"session_id":"sess-c1"}',
  toolCompletedRead:
    '{"type":"tool_call","subtype":"completed","call_id":"c1","tool_call":{"readToolCall":{"args":{"path":"README.md"},"result":{"success":{"content":"# Hi","totalLines":1}}}},"session_id":"sess-c1"}',
  toolStartedWrite:
    '{"type":"tool_call","subtype":"started","call_id":"c2","tool_call":{"writeToolCall":{"args":{"path":"out.txt","fileText":"x"}}},"session_id":"sess-c1"}',
  toolStartedFn:
    '{"type":"tool_call","subtype":"started","call_id":"c3","tool_call":{"function":{"name":"Shell","arguments":"{\\"command\\":\\"ls\\"}"}},"session_id":"sess-c1"}',
  resultSuccess:
    '{"type":"result","subtype":"success","duration_ms":1234,"duration_api_ms":1234,"is_error":false,"result":"Hello","session_id":"sess-c1"}',
  resultError:
    '{"type":"result","subtype":"error","duration_ms":100,"is_error":true,"result":"fail","session_id":"sess-c1"}',
  unknown: '{"type":"thinking","text":"nope"}',
} as const;

function map(line: string): AgentEvent[] {
  return createCursorMapper()(JSON.parse(line));
}

describe("cursor mapper", () => {
  it("maps system/init to session_start", () => {
    expect(map(SAMPLES.init)).toEqual([
      expect.objectContaining({
        kind: "session_start",
        agent: "cursor",
        sessionId: "sess-c1",
        model: "Composer 2.5",
      }),
    ]);
  });

  it("ignores user echo", () => {
    expect(map(SAMPLES.userEcho)).toEqual([]);
  });

  it("maps streaming assistant deltas and skips buffered flushes", () => {
    expect(map(SAMPLES.assistantDelta)).toEqual([
      expect.objectContaining({ kind: "text_delta", text: "Hel" }),
    ]);
    expect(map(SAMPLES.assistantDelta2)).toEqual([
      expect.objectContaining({ kind: "text_delta", text: "lo" }),
    ]);
    expect(map(SAMPLES.assistantFlushBeforeTool)).toEqual([]);
    expect(map(SAMPLES.assistantFinalFlush)).toEqual([]);
  });

  it("maps read/write/function tool_call started and completed", () => {
    expect(map(SAMPLES.toolStartedRead)).toEqual([
      expect.objectContaining({
        kind: "tool_use",
        id: "c1",
        name: "read",
        input: { path: "README.md" },
      }),
    ]);
    expect(map(SAMPLES.toolCompletedRead)).toEqual([
      expect.objectContaining({
        kind: "tool_result",
        id: "c1",
        name: "read",
        isError: false,
      }),
    ]);
    expect(map(SAMPLES.toolStartedWrite)[0]).toMatchObject({
      kind: "tool_use",
      name: "write",
    });
    expect(map(SAMPLES.toolStartedFn)[0]).toMatchObject({
      kind: "tool_use",
      name: "Shell",
      input: { command: "ls" },
    });
  });

  it("flags tool_result isError when the payload has error", () => {
    const line =
      '{"type":"tool_call","subtype":"completed","call_id":"c9","tool_call":{"readToolCall":{"args":{"path":"x"},"result":{"error":{"message":"missing"}}}},"session_id":"sess-c1"}';
    expect(map(line)).toEqual([
      expect.objectContaining({ kind: "tool_result", id: "c9", name: "read", isError: true }),
    ]);
  });

  it("maps result success and error", () => {
    expect(map(SAMPLES.resultSuccess)).toEqual([
      expect.objectContaining({
        kind: "result",
        isError: false,
        text: "Hello",
        durationMs: 1234,
        subtype: "success",
      }),
    ]);
    expect(map(SAMPLES.resultError)[0]).toMatchObject({ kind: "result", isError: true });
  });

  it("passes unknown types through", () => {
    expect(map(SAMPLES.unknown)).toEqual([
      expect.objectContaining({ kind: "unknown", rawType: "thinking" }),
    ]);
  });
});

import { CURSOR_MODELS, buildCursorRunArgs, resolveCursorModel } from "../src/agents/cursor";

describe("cursor argv", () => {
  it("includes print/stream-json/partial/force/trust/model and trailing prompt", () => {
    expect(buildCursorRunArgs({ prompt: "hello", model: "composer-2.5" })).toEqual([
      "--print",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--force",
      "--trust",
      "--model",
      "composer-2.5",
      "hello",
    ]);
  });

  it("adds --resume before extraArgs and prompt", () => {
    expect(
      buildCursorRunArgs({
        prompt: "more",
        model: "auto",
        resumeSessionId: "sess-9",
        extraArgs: ["--approve-mcps"],
      }),
    ).toEqual([
      "--print",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--force",
      "--trust",
      "--model",
      "auto",
      "--resume",
      "sess-9",
      "--approve-mcps",
      "more",
    ]);
  });

  it("appends [effort=…] unless model already has effort=", () => {
    expect(resolveCursorModel("composer-2.5", "high")).toBe("composer-2.5[effort=high]");
    expect(resolveCursorModel("claude-opus-4-8[effort=low]", "high")).toBe(
      "claude-opus-4-8[effort=low]",
    );
  });

  it("ships a static catalog including auto and composer-2.5", () => {
    const ids = CURSOR_MODELS.map((m) => m.id);
    expect(ids).toContain("auto");
    expect(ids).toContain("composer-2.5");
  });
});
