import { describe, expect, it } from "vitest";
import {
  OpenCodeAdapter,
  buildOpenCodeRunArgs,
  createOpenCodeMapper,
} from "../src/agents/opencode";
import type { AgentEvent } from "../src/types/events";

/**
 * Sample lines for `opencode run --format json` (opencode 1.15.x). The `error`
 * shape is captured verbatim from a real run; the part-bearing events follow
 * opencode's documented flat envelope (`{type, sessionID, part:{...}}`).
 */
const stepStart = '{"type":"step_start","sessionID":"ses_abc"}';
const textHe =
  '{"type":"message.part.updated","sessionID":"ses_abc","part":{"id":"prt_1","type":"text","text":"He"}}';
const textHello =
  '{"type":"message.part.updated","sessionID":"ses_abc","part":{"id":"prt_1","type":"text","text":"Hello"}}';
const reasoning =
  '{"type":"message.part.updated","sessionID":"ses_abc","part":{"id":"prt_r","type":"reasoning","text":"Let me think"}}';
const toolRunning =
  '{"type":"tool_use","sessionID":"ses_abc","part":{"id":"prt_t","type":"tool","tool":"bash","callID":"call_1","state":{"status":"running","input":{"command":"ls"}}}}';
const toolCompleted =
  '{"type":"message.part.updated","sessionID":"ses_abc","part":{"id":"prt_t","type":"tool","tool":"bash","callID":"call_1","state":{"status":"completed","output":"file1\\nfile2"}}}';
const stepFinish = '{"type":"step_finish","sessionID":"ses_abc","cost":0.0012}';
const errorLine =
  '{"type":"error","timestamp":1780531753199,"sessionID":"ses_170","error":{"name":"UnknownError","data":{"message":"Model not found: openai/gpt-4o-mini. Did you mean: gpt-5.4-mini, gpt-5.2?"}}}';
const nestedProps =
  '{"type":"message.part.updated","properties":{"part":{"id":"prt_x","type":"text","text":"yo"}},"sessionID":"ses_z"}';

describe("opencode mapper (stateful, one mapper per run)", () => {
  it("normalizes a full session sequence", () => {
    const m = createOpenCodeMapper();

    // First event carrying ses_… yields exactly one session_start.
    expect(m(JSON.parse(stepStart))).toEqual([
      expect.objectContaining({ kind: "session_start", agent: "opencode", sessionId: "ses_abc" }),
    ]);

    // Cumulative text parts are diffed into true deltas.
    expect(m(JSON.parse(textHe))).toEqual([
      expect.objectContaining({ kind: "text_delta", text: "He" }),
    ]);
    expect(m(JSON.parse(textHello))).toEqual([
      expect.objectContaining({ kind: "text_delta", text: "llo" }),
    ]);

    // reasoning/thinking parts are flagged.
    expect(m(JSON.parse(reasoning))).toEqual([
      expect.objectContaining({ kind: "text_delta", text: "Let me think", thinking: true }),
    ]);

    // Tool start emits tool_use once.
    expect(m(JSON.parse(toolRunning))).toEqual([
      expect.objectContaining({
        kind: "tool_use",
        id: "call_1",
        name: "bash",
        input: { command: "ls" },
        status: "running",
      }),
    ]);
    // A repeated running status is de-duplicated.
    expect(m(JSON.parse(toolRunning))).toEqual([]);

    // Completion emits tool_result once.
    expect(m(JSON.parse(toolCompleted))).toEqual([
      expect.objectContaining({
        kind: "tool_result",
        id: "call_1",
        name: "bash",
        output: "file1\nfile2",
        isError: false,
        status: "completed",
      }),
    ]);

    // step_finish becomes a result carrying cost.
    expect(m(JSON.parse(stepFinish))).toEqual([
      expect.objectContaining({
        kind: "result",
        isError: false,
        subtype: "step_finish",
        costUsd: 0.0012,
      }),
    ]);
  });

  it("surfaces a tool_use for a tool part with an unrecognized (future) status", () => {
    // A status outside the known running/done/failed sets must never be silently
    // dropped — the tool invocation has to stay visible so retry can't treat a
    // step that already ran a tool as a clean, retryable failure.
    const m = createOpenCodeMapper();
    m(JSON.parse(stepStart)); // establish the session first
    const line =
      '{"type":"tool_use","sessionID":"ses_abc","part":{"id":"prt_z","type":"tool","tool":"bash","callID":"call_z","state":{"status":"throttled_v2","input":{"command":"rm"}}}}';
    expect(m(JSON.parse(line))).toEqual([
      expect.objectContaining({
        kind: "tool_use",
        id: "call_z",
        name: "bash",
        status: "throttled_v2",
      }),
    ]);
  });

  it("does not emit a full-text delta when a replacement shortens prior text", () => {
    const m = createOpenCodeMapper();
    m(JSON.parse(textHello));
    const shortened =
      '{"type":"message.part.updated","sessionID":"ses_abc","part":{"id":"prt_1","type":"text","text":"Hi"}}';
    expect(m(JSON.parse(shortened))).toEqual([]);
  });

  it("does not repeat session_start for later events", () => {
    const m = createOpenCodeMapper();
    m(JSON.parse(stepStart));
    const events = m(JSON.parse(textHe));
    expect(events.some((e) => e.kind === "session_start")).toBe(false);
  });

  it("maps the real error event shape to an error", () => {
    const m = createOpenCodeMapper();
    const events = m(JSON.parse(errorLine)) as AgentEvent[];
    expect(events).toEqual([expect.objectContaining({ kind: "error", agent: "opencode" })]);
    expect((events[0] as { message: string }).message).toContain("Model not found");
  });

  it("accepts the nested properties.part shape", () => {
    const m = createOpenCodeMapper();
    const events = m(JSON.parse(nestedProps));
    expect(events).toEqual([
      expect.objectContaining({ kind: "session_start", sessionId: "ses_z" }),
      expect.objectContaining({ kind: "text_delta", text: "yo" }),
    ]);
  });

  it("passes through unrecognized events as unknown and never throws", () => {
    const m = createOpenCodeMapper();
    expect(m(JSON.parse('{"type":"server.connected"}'))).toEqual([
      expect.objectContaining({ kind: "unknown", rawType: "server.connected" }),
    ]);
    expect(() => m({})).not.toThrow();
  });
});

describe("buildOpenCodeRunArgs", () => {
  it("includes model, variant, ERROR print-logs, and extra args", () => {
    expect(
      buildOpenCodeRunArgs({
        prompt: "hello",
        model: "opencode/gpt-5.5",
        effort: "high",
        extraArgs: ["--share"],
      }),
    ).toEqual([
      "run",
      "--format",
      "json",
      "--print-logs",
      "--log-level",
      "ERROR",
      "--model",
      "opencode/gpt-5.5",
      "--variant",
      "high",
      "--share",
    ]);
  });

  it("pins the project with --dir so OpenCode does not attach to another repo", () => {
    expect(
      buildOpenCodeRunArgs({
        prompt: "babysit",
        model: "opencode/gpt-5.5",
        cwd: "/tmp/camelo-worktree",
      }),
    ).toEqual([
      "run",
      "--format",
      "json",
      "--print-logs",
      "--log-level",
      "ERROR",
      "--model",
      "opencode/gpt-5.5",
      "--dir",
      "/tmp/camelo-worktree",
    ]);
  });

  it("continues a recorded session via --session", () => {
    expect(
      buildOpenCodeRunArgs({
        prompt: "go on",
        model: "opencode/gpt-5.5",
        resumeSessionId: "ses_42",
      }),
    ).toEqual([
      "run",
      "--format",
      "json",
      "--print-logs",
      "--log-level",
      "ERROR",
      "--model",
      "opencode/gpt-5.5",
      "--session",
      "ses_42",
    ]);
    expect(new OpenCodeAdapter().supportsResume).toBe(true);
  });
});
