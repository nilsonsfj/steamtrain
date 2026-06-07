import { describe, expect, it } from "vitest";
import { createCodexMapper } from "../src/agents/codex";
import type { AgentEvent } from "../src/types/events";

/**
 * Sample lines captured from real `codex exec --json` runs and Codex docs.
 */
const SAMPLES = {
  threadStarted: '{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}',
  turnStarted: '{"type":"turn.started"}',
  agentMessage:
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PING"}}',
  reasoningUpdated:
    '{"type":"item.updated","item":{"id":"item_r","type":"reasoning","text":"Let me think"}}',
  reasoningMore:
    '{"type":"item.updated","item":{"id":"item_r","type":"reasoning","text":"Let me think harder"}}',
  commandStarted:
    '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}',
  commandCompleted:
    '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","status":"completed","aggregated_output":"file1\\nfile2","exit_code":0}}',
  turnCompleted:
    '{"type":"turn.completed","usage":{"input_tokens":8497,"cached_input_tokens":8448,"output_tokens":51}}',
  turnFailed: '{"type":"turn.failed","error":{"message":"rate limit exceeded"}}',
  streamError: '{"type":"error","error":{"message":"not authenticated"}}',
} as const;

function map(line: string): AgentEvent[] {
  return createCodexMapper()(JSON.parse(line));
}

describe("codex mapper (stateful, one mapper per run)", () => {
  it("normalizes a full session sequence", () => {
    const m = createCodexMapper();

    expect(m(JSON.parse(SAMPLES.threadStarted))).toEqual([
      expect.objectContaining({
        kind: "session_start",
        agent: "codex",
        sessionId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
      }),
    ]);

    expect(m(JSON.parse(SAMPLES.turnStarted))).toEqual([]);

    expect(m(JSON.parse(SAMPLES.agentMessage))).toEqual([
      expect.objectContaining({ kind: "text_delta", text: "PING" }),
    ]);

    expect(m(JSON.parse(SAMPLES.reasoningUpdated))).toEqual([
      expect.objectContaining({ kind: "text_delta", text: "Let me think", thinking: true }),
    ]);
    expect(m(JSON.parse(SAMPLES.reasoningMore))).toEqual([
      expect.objectContaining({ kind: "text_delta", text: " harder", thinking: true }),
    ]);

    expect(m(JSON.parse(SAMPLES.commandStarted))).toEqual([
      expect.objectContaining({
        kind: "tool_use",
        id: "item_1",
        name: "command_execution",
        input: { command: "bash -lc ls" },
        status: "in_progress",
      }),
    ]);
    expect(m(JSON.parse(SAMPLES.commandStarted))).toEqual([]);

    expect(m(JSON.parse(SAMPLES.commandCompleted))).toEqual([
      expect.objectContaining({
        kind: "tool_result",
        id: "item_1",
        output: "file1\nfile2",
        isError: false,
        status: "completed",
      }),
    ]);

    expect(m(JSON.parse(SAMPLES.turnCompleted))).toEqual([
      expect.objectContaining({ kind: "result", isError: false, subtype: "turn.completed" }),
    ]);
  });

  it("maps turn.failed and stream errors", () => {
    const m = createCodexMapper();
    const failed = m(JSON.parse(SAMPLES.turnFailed));
    expect(failed).toEqual([
      expect.objectContaining({ kind: "error", message: "rate limit exceeded" }),
      expect.objectContaining({ kind: "result", isError: true, subtype: "turn.failed" }),
    ]);

    expect(m(JSON.parse(SAMPLES.streamError))).toEqual([
      expect.objectContaining({ kind: "error", message: "not authenticated" }),
    ]);
  });

  it("passes through unrecognized events as unknown and never throws", () => {
    const m = createCodexMapper();
    expect(m(JSON.parse('{"type":"server.connected"}'))).toEqual([
      expect.objectContaining({ kind: "unknown", rawType: "server.connected" }),
    ]);
    expect(() => m({})).not.toThrow();
  });
});
