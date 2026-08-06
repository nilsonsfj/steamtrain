import { describe, expect, it } from "vitest";
import { createClaudeMapper } from "../src/agents/claude";
import type { AgentEvent } from "../src/types/events";

/**
 * Sample lines captured from a real run of:
 *   claude --print --output-format stream-json --verbose \
 *          --include-partial-messages --model haiku "Reply with exactly: hi"
 * (Claude Code 2.1.x), trimmed to the fields the mapper reads.
 */
const SAMPLES = {
  init: '{"type":"system","subtype":"init","cwd":"/x","session_id":"4a6e2862-4514-4b05-abab-89bbe24d8a62","tools":["Task","Bash","Edit","Read"],"model":"claude-haiku-4-5-20251001","permissionMode":"default","apiKeySource":"none"}',
  status: '{"type":"system","subtype":"status","status":"requesting","session_id":"4a6e2862"}',
  rateLimit:
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"},"session_id":"4a6e2862"}',
  thinkingDelta:
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"The user is asking me to reply"}},"session_id":"4a6e2862"}',
  signatureDelta:
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"abc=="}},"session_id":"4a6e2862"}',
  textDelta:
    '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hi"}},"session_id":"4a6e2862"}',
  assistantText:
    '{"type":"assistant","message":{"id":"msg_1","role":"assistant","content":[{"type":"text","text":"hi"}]},"session_id":"4a6e2862"}',
  assistantToolUse:
    '{"type":"assistant","message":{"id":"msg_2","role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls -la"}}]},"session_id":"4a6e2862"}',
  userToolResult:
    '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"file1\\nfile2","is_error":false}]}}',
  result:
    '{"type":"result","subtype":"success","is_error":false,"duration_ms":1550,"result":"hi","total_cost_usd":0.0246}',
  authError:
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Not logged in · Please run /login"}]},"error":"authentication_failed","session_id":"c80b"}',
  messageStop: '{"type":"stream_event","event":{"type":"message_stop"},"session_id":"4a6e2862"}',
} as const;

function map(line: string): AgentEvent[] {
  return createClaudeMapper()(JSON.parse(line));
}

describe("claude mapper", () => {
  it("maps system/init to session_start with ids, model and tools", () => {
    const [event, ...rest] = map(SAMPLES.init);
    expect(rest).toHaveLength(0);
    expect(event).toMatchObject({
      kind: "session_start",
      agent: "claude",
      sessionId: "4a6e2862-4514-4b05-abab-89bbe24d8a62",
      model: "claude-haiku-4-5-20251001",
      tools: ["Task", "Bash", "Edit", "Read"],
    });
  });

  it("streams text deltas from stream_event content_block_delta", () => {
    expect(map(SAMPLES.textDelta)).toEqual([
      expect.objectContaining({ kind: "text_delta", agent: "claude", text: "hi" }),
    ]);
  });

  it("maps thinking_delta to a thinking-flagged text delta", () => {
    expect(map(SAMPLES.thinkingDelta)).toEqual([
      expect.objectContaining({
        kind: "text_delta",
        text: "The user is asking me to reply",
        thinking: true,
      }),
    ]);
  });

  it("ignores non-text stream events (signature_delta, message_stop)", () => {
    expect(map(SAMPLES.signatureDelta)).toEqual([]);
    expect(map(SAMPLES.messageStop)).toEqual([]);
  });

  it("skips full assistant text (already streamed) to avoid duplicates", () => {
    expect(map(SAMPLES.assistantText)).toEqual([]);
  });

  it("emits tool_use from an assistant tool_use block", () => {
    expect(map(SAMPLES.assistantToolUse)).toEqual([
      expect.objectContaining({
        kind: "tool_use",
        id: "toolu_1",
        name: "Bash",
        input: { command: "ls -la" },
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

  it("maps result with is_error, text, duration and cost", () => {
    expect(map(SAMPLES.result)).toEqual([
      expect.objectContaining({
        kind: "result",
        isError: false,
        text: "hi",
        subtype: "success",
        durationMs: 1550,
        costUsd: 0.0246,
      }),
    ]);
  });

  it("surfaces an assistant-level error (e.g. not logged in)", () => {
    const [event] = map(SAMPLES.authError);
    expect(event).toMatchObject({ kind: "error", agent: "claude" });
    expect((event as { message: string }).message).toContain("Not logged in");
    expect((event as { message: string }).message).toContain("authentication_failed");
  });

  it("ignores system status events", () => {
    expect(map(SAMPLES.status)).toEqual([]);
  });

  it("passes through unrecognized top-level types as unknown", () => {
    expect(map(SAMPLES.rateLimit)).toEqual([
      expect.objectContaining({ kind: "unknown", rawType: "rate_limit_event" }),
    ]);
  });

  it("never throws on malformed/empty objects", () => {
    expect(() => createClaudeMapper()({})).not.toThrow();
    expect(createClaudeMapper()({ type: "assistant" })).toEqual([
      expect.objectContaining({ kind: "unknown" }),
    ]);
  });
});

/**
 * Live spend: Claude Code reports `usage` on every `assistant` line, which is
 * the only mid-turn source there is — the `result` line's totals land when the
 * step is already over. The mapper turns those reports into INCREMENTS (see
 * UsageEvent), because Claude repeats a message's usage on every line it
 * splits that message across.
 */
describe("claude mapper · live usage", () => {
  /** An `assistant` line carrying usage, as Claude Code emits it. */
  function assistant(id: string, usage: Record<string, number>, block = '{"type":"text"}') {
    return {
      type: "assistant",
      message: { id, role: "assistant", content: [JSON.parse(block)], usage },
      session_id: "4a6e2862",
    };
  }

  it("emits a usage increment for a message's first line", () => {
    const mapper = createClaudeMapper();
    expect(mapper(assistant("msg_1", { input_tokens: 12, output_tokens: 4 }))).toEqual([
      expect.objectContaining({
        kind: "usage",
        agent: "claude",
        tokens: { input: 12, output: 4 },
      }),
    ]);
  });

  it("maps cache reads and writes onto the normalized categories", () => {
    const mapper = createClaudeMapper();
    const [event] = mapper(
      assistant("msg_1", {
        input_tokens: 3,
        output_tokens: 1,
        cache_read_input_tokens: 9000,
        cache_creation_input_tokens: 250,
      }),
    );
    expect(event).toMatchObject({
      kind: "usage",
      tokens: { input: 3, output: 1, cacheRead: 9000, cacheWrite: 250 },
    });
  });

  it("reports only what grew when the same message is restated", () => {
    const mapper = createClaudeMapper();
    mapper(assistant("msg_1", { input_tokens: 100, output_tokens: 10 }));
    // Same message, one more content block: input is unchanged, output grew by 5.
    const events = mapper(
      assistant("msg_1", { input_tokens: 100, output_tokens: 15 }, '{"type":"text"}'),
    );
    expect(events).toEqual([expect.objectContaining({ kind: "usage", tokens: { output: 5 } })]);
  });

  it("emits nothing when a restated message reports no growth", () => {
    const mapper = createClaudeMapper();
    mapper(assistant("msg_1", { input_tokens: 100, output_tokens: 10 }));
    expect(mapper(assistant("msg_1", { input_tokens: 100, output_tokens: 10 }))).toEqual([]);
  });

  it("bills a new message in full rather than differencing it", () => {
    const mapper = createClaudeMapper();
    mapper(assistant("msg_1", { input_tokens: 100, output_tokens: 40 }));
    // A second message's input is its own prompt, not a continuation of the
    // first's — differencing it would report a negative and count nothing.
    expect(mapper(assistant("msg_2", { input_tokens: 120, output_tokens: 8 }))).toEqual([
      expect.objectContaining({ kind: "usage", tokens: { input: 120, output: 8 } }),
    ]);
  });

  it("never reports a negative increment when a counter goes backwards", () => {
    const mapper = createClaudeMapper();
    mapper(assistant("msg_1", { input_tokens: 100, output_tokens: 40 }));
    expect(mapper(assistant("msg_1", { input_tokens: 100, output_tokens: 30 }))).toEqual([]);
  });

  it("still emits the message's tool_use alongside its usage", () => {
    const mapper = createClaudeMapper();
    const events = mapper(
      assistant(
        "msg_2",
        { output_tokens: 7 },
        '{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}}',
      ),
    );
    expect(events.map((e) => e.kind)).toEqual(["tool_use", "usage"]);
  });

  it("says nothing at all when a line carries no usage", () => {
    expect(map(SAMPLES.assistantText)).toEqual([]);
  });
});
