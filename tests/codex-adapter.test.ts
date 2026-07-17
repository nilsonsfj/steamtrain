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

  it("includes model and tools in session_start when present", () => {
    const m = createCodexMapper();
    const event = m(
      JSON.parse(
        '{"type":"thread.started","thread_id":"t1","model":"gpt-5.4-mini","tools":["bash","file_edit"]}',
      ),
    );
    expect(event).toEqual([
      expect.objectContaining({
        kind: "session_start",
        agent: "codex",
        sessionId: "t1",
        model: "gpt-5.4-mini",
        tools: ["bash", "file_edit"],
      }),
    ]);
  });

  it("omits model and tools from session_start when absent", () => {
    const m = createCodexMapper();
    const event = m(JSON.parse(SAMPLES.threadStarted));
    expect(event).toEqual([
      expect.objectContaining({
        kind: "session_start",
        sessionId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
      }),
    ]);
    expect(event[0]).not.toHaveProperty("model");
    expect(event[0]).not.toHaveProperty("tools");
  });

  it("tracks turn duration from turn.started to turn.completed", () => {
    const m = createCodexMapper();
    m(JSON.parse(SAMPLES.turnStarted));
    const result = m(JSON.parse(SAMPLES.turnCompleted));
    expect(result).toEqual([
      expect.objectContaining({
        kind: "result",
        isError: false,
        subtype: "turn.completed",
        durationMs: expect.any(Number),
      }),
    ]);
    expect((result[0] as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
  });

  it("tracks turn duration from turn.started to turn.failed", () => {
    const m = createCodexMapper();
    m(JSON.parse(SAMPLES.turnStarted));
    const result = m(JSON.parse(SAMPLES.turnFailed));
    const resultEvent = result.find((e) => e.kind === "result");
    expect(resultEvent).toEqual(
      expect.objectContaining({
        kind: "result",
        isError: true,
        subtype: "turn.failed",
        durationMs: expect.any(Number),
      }),
    );
  });

  it("estimates costUsd from usage tokens on turn.failed", () => {
    const m = createCodexMapper();
    const result = m(
      JSON.parse(
        '{"type":"turn.failed","model":"gpt-5.2","usage":{"input_tokens":500,"cached_input_tokens":0,"output_tokens":50},"error":{"message":"timeout"}}',
      ),
    );
    const costEvent = result.find((e) => e.kind === "result");
    expect(costEvent).toEqual(expect.objectContaining({ costUsd: expect.any(Number) }));
    // gpt-5.2 rates: input=$2.50/M, output=$15.00/M
    const expected = (500 * 2.5 + 50 * 15.0) / 1_000_000;
    expect((costEvent as { costUsd: number }).costUsd).toBeCloseTo(expected, 8);
  });

  it("estimates costUsd from usage tokens on turn.completed", () => {
    const m = createCodexMapper();
    const result = m(JSON.parse(SAMPLES.turnCompleted));
    expect(result).toEqual([
      expect.objectContaining({
        kind: "result",
        costUsd: expect.any(Number),
      }),
    ]);
    // SAMPLES.turnCompleted: input=8497, cached=8448, output=51
    // uncached=49*$0.75/M + cached=8448*$0.075/M + output=51*$4.50/M
    // (reasoning_output_tokens is a subset of output_tokens, not double-counted)
    const cost = (result[0] as { costUsd: number }).costUsd;
    expect(cost).toBeCloseTo(0.00089985, 8);
  });

  it("omits costUsd when usage is absent", () => {
    const m = createCodexMapper();
    const result = m(JSON.parse('{"type":"turn.completed"}'));
    expect(result).toEqual([
      expect.objectContaining({
        kind: "result",
        costUsd: undefined,
      }),
    ]);
  });

  it("omits costUsd when all usage token counts are zero", () => {
    const m = createCodexMapper();
    const result = m(
      JSON.parse(
        '{"type":"turn.completed","usage":{"input_tokens":0,"cached_input_tokens":0,"output_tokens":0}}',
      ),
    );
    expect(result).toEqual([
      expect.objectContaining({
        kind: "result",
        costUsd: undefined,
      }),
    ]);
  });

  it("does not double-count reasoning_output_tokens (subset of output_tokens)", () => {
    const m = createCodexMapper();
    // output_tokens=100 includes reasoning_output_tokens=40
    const result = m(
      JSON.parse(
        '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":0,"output_tokens":100,"reasoning_output_tokens":40}}',
      ),
    );
    const cost = (result[0] as { costUsd: number }).costUsd;
    // Should only count output_tokens (100), NOT output_tokens + reasoning_output_tokens (140)
    const expectedWithOnlyOutput = (1000 * 0.75 + 100 * 4.5) / 1_000_000;
    const wrongExpected = (1000 * 0.75 + (100 + 40) * 4.5) / 1_000_000;
    expect(cost).toBeCloseTo(expectedWithOnlyOutput, 8);
    expect(cost).not.toBeCloseTo(wrongExpected, 8);
  });

  it("uses per-model pricing when model is present in turn event", () => {
    const m = createCodexMapper();
    const result = m(
      JSON.parse(
        '{"type":"turn.completed","model":"gpt-5.4","usage":{"input_tokens":1000,"cached_input_tokens":0,"output_tokens":100}}',
      ),
    );
    const cost = (result[0] as { costUsd: number }).costUsd;
    // gpt-5.4 rates: input=$2.50/M, cached=$0.25/M, output=$15.00/M
    const expected = (1000 * 2.5 + 100 * 15.0) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 8);
  });

  it("uses correct rates for gpt-5.1-codex-mini (mini-tier)", () => {
    const m = createCodexMapper();
    const result = m(
      JSON.parse(
        '{"type":"turn.completed","model":"gpt-5.1-codex-mini","usage":{"input_tokens":1000,"cached_input_tokens":0,"output_tokens":100}}',
      ),
    );
    const cost = (result[0] as { costUsd: number }).costUsd;
    // gpt-5.1-codex-mini rates (mini-tier): input=$0.75/M, cached=$0.075/M, output=$4.50/M
    const expected = (1000 * 0.75 + 100 * 4.5) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 8);
  });

  it("falls back to default pricing for unknown model", () => {
    const m = createCodexMapper();
    const result = m(
      JSON.parse(
        '{"type":"turn.completed","model":"future-model-v99","usage":{"input_tokens":1000,"cached_input_tokens":0,"output_tokens":100}}',
      ),
    );
    const cost = (result[0] as { costUsd: number }).costUsd;
    // default (gpt-5.4-mini) rates: input=$0.75/M, output=$4.50/M
    const expected = (1000 * 0.75 + 100 * 4.5) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 8);
  });

  it("returns undefined durationMs when turn.started was never received", () => {
    const m = createCodexMapper();
    const result = m(JSON.parse(SAMPLES.turnCompleted));
    expect(result).toEqual([
      expect.objectContaining({
        kind: "result",
        durationMs: undefined,
      }),
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
    ]);
  });

  it("continues a recorded session via `exec resume <sessionId>`", () => {
    expect(
      buildCodexExecArgs({ prompt: "go on", model: "gpt-5.5", resumeSessionId: "thread-42" }),
    ).toEqual([
      "exec",
      "resume",
      "thread-42",
      "--json",
      "--sandbox",
      "workspace-write",
      "-c",
      'approval_policy="never"',
      "--skip-git-repo-check",
      "--model",
      "gpt-5.5",
    ]);
  });
});
