import { describe, expect, it } from "vitest";
import { buildCodexExecArgs, createCodexMapper } from "../src/agents/codex";
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
  commandUpdatedCompleted:
    '{"type":"item.updated","item":{"id":"item_2","type":"command_execution","command":"bash -lc pwd","status":"completed","aggregated_output":"/workspace","exit_code":0}}',
  mcpStarted:
    '{"type":"item.started","item":{"id":"item_m","type":"mcp_tool_call","server":"github","tool":"search_code","status":"in_progress","arguments":{"query":"foo"}}}',
  mcpCompleted:
    '{"type":"item.completed","item":{"id":"item_m","type":"mcp_tool_call","server":"github","tool":"search_code","status":"completed","result":{"items":[]}}}',
  itemError:
    '{"type":"item.completed","item":{"id":"item_e","type":"error","message":"tool execution failed"}}',
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

  it("emits tool_result when command status completes on item.updated", () => {
    const m = createCodexMapper();
    m(
      JSON.parse(
        '{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"bash -lc pwd","status":"in_progress"}}',
      ),
    );
    expect(m(JSON.parse(SAMPLES.commandUpdatedCompleted))).toEqual([
      expect.objectContaining({
        kind: "tool_result",
        id: "item_2",
        output: "/workspace",
        isError: false,
        status: "completed",
      }),
    ]);
  });

  it("surfaces a tool_use for a command with an unrecognized (future) status", () => {
    // A status value outside the known running/done/failed sets must never be
    // silently dropped — the tool invocation has to stay visible so retry can't
    // treat a step that already ran a tool as a clean, retryable failure.
    const m = createCodexMapper();
    expect(
      m(
        JSON.parse(
          '{"type":"item.started","item":{"id":"item_x","type":"command_execution","command":"bash -lc rm","status":"throttled_v2"}}',
        ),
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "tool_use",
        id: "item_x",
        name: "command_execution",
        status: "throttled_v2",
      }),
    ]);
  });

  it("surfaces a tool_use for an MCP call with an unrecognized status", () => {
    const m = createCodexMapper();
    expect(
      m(
        JSON.parse(
          '{"type":"item.started","item":{"id":"item_y","type":"mcp_tool_call","server":"s","tool":"search_code","arguments":{"q":"x"},"status":"weird_state"}}',
        ),
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "tool_use",
        id: "item_y",
        name: "search_code",
        status: "weird_state",
      }),
    ]);
  });

  it("maps MCP tool calls and item errors", () => {
    const m = createCodexMapper();

    expect(m(JSON.parse(SAMPLES.mcpStarted))).toEqual([
      expect.objectContaining({
        kind: "tool_use",
        id: "item_m",
        name: "search_code",
        input: { query: "foo" },
        status: "in_progress",
      }),
    ]);

    expect(m(JSON.parse(SAMPLES.mcpCompleted))).toEqual([
      expect.objectContaining({
        kind: "tool_result",
        id: "item_m",
        name: "search_code",
        isError: false,
        status: "completed",
      }),
    ]);

    expect(m(JSON.parse(SAMPLES.itemError))).toEqual([
      expect.objectContaining({ kind: "error", message: "tool execution failed" }),
    ]);
  });
});

describe("buildCodexExecArgs", () => {
  it("includes sandbox, approval, model, effort, extra args, and prompt", () => {
    expect(
      buildCodexExecArgs({
        prompt: "hello",
        model: "gpt-5.4-mini",
        effort: "high",
        extraArgs: ["--ephemeral"],
      }),
    ).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "-c",
      'approval_policy="never"',
      "--skip-git-repo-check",
      "--model",
      "gpt-5.4-mini",
      "-c",
      'model_reasoning_effort="high"',
      "--ephemeral",
      "hello",
    ]);
  });

  it("omits effort override when unset", () => {
    expect(buildCodexExecArgs({ prompt: "ping", model: "gpt-5.5" })).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "-c",
      'approval_policy="never"',
      "--skip-git-repo-check",
      "--model",
      "gpt-5.5",
      "ping",
    ]);
  });
});
