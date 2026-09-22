import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter, createClaudeMapper, readClaudeSessionCost } from "../src/agents/claude";
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

  it("does not re-bill growth after a stale, lower restatement", () => {
    const mapper = createClaudeMapper();
    mapper(assistant("msg_1", { input_tokens: 100, output_tokens: 40 }));
    mapper(assistant("msg_1", { input_tokens: 100, output_tokens: 30 }));
    // Back to 40: nothing new was billed since the first line.
    expect(mapper(assistant("msg_1", { input_tokens: 100, output_tokens: 40 }))).toEqual([]);
  });

  it("keeps a watermark per message when subagent lines interleave", () => {
    const mapper = createClaudeMapper();
    mapper(assistant("msg_main", { input_tokens: 100, output_tokens: 10 }));
    mapper(assistant("msg_sub", { input_tokens: 50, output_tokens: 5 }));
    // Back on the main message: only its growth counts, not all of it again.
    expect(mapper(assistant("msg_main", { input_tokens: 100, output_tokens: 12 }))).toEqual([
      expect.objectContaining({ kind: "usage", tokens: { output: 2 } }),
    ]);
  });

  it("reads the final output count from the API stream's message_delta", () => {
    const mapper = createClaudeMapper();
    const stream = (event: unknown) => ({ type: "stream_event", event });
    expect(
      mapper(
        stream({
          type: "message_start",
          message: { id: "msg_1", usage: { input_tokens: 100, output_tokens: 1 } },
        }),
      ),
    ).toEqual([expect.objectContaining({ tokens: { input: 100, output: 1 } })]);
    // The assistant line restates the same message — nothing new.
    expect(mapper(assistant("msg_1", { input_tokens: 100, output_tokens: 1 }))).toEqual([]);
    // A subagent line in between must not steal the id-less delta.
    mapper(assistant("msg_sub", { input_tokens: 5, output_tokens: 5 }));
    expect(
      mapper(stream({ type: "message_delta", usage: { input_tokens: 100, output_tokens: 250 } })),
    ).toEqual([expect.objectContaining({ kind: "usage", tokens: { output: 249 } })]);
  });
});

describe("claude mapper · result usage", () => {
  it("prefers modelUsage, which includes subagent calls, over the main-loop usage", () => {
    const line = {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      total_cost_usd: 0.42,
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300 },
      modelUsage: {
        "claude-opus-5-5": {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 300,
          cacheCreationInputTokens: 0,
          costUSD: 0.4,
        },
        "claude-haiku-4-5-20251001": {
          inputTokens: 7,
          outputTokens: 3,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 50,
          costUSD: 0.02,
        },
      },
    };
    expect(createClaudeMapper()(line)).toEqual([
      expect.objectContaining({
        kind: "result",
        costUsd: 0.42,
        tokens: { input: 17, output: 23, cacheRead: 300, cacheWrite: 50 },
      }),
    ]);
  });

  it("falls back to usage when modelUsage is empty", () => {
    const line = {
      type: "result",
      is_error: false,
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 2 },
      modelUsage: {},
    };
    expect(createClaudeMapper()(line)).toEqual([
      expect.objectContaining({ tokens: { input: 1, output: 2 } }),
    ]);
  });
});

describe("claude mapper · resumed session cost", () => {
  it("reports only this run's share of a resumed session's restored totals", () => {
    const mapper = createClaudeMapper("claude", {
      costBaseline: {
        costUsd: 0.3,
        modelUsage: { "claude-opus-5-5": { inputTokens: 100, outputTokens: 40, costUSD: 0.3 } },
      },
    });
    const [result] = mapper({
      type: "result",
      is_error: false,
      total_cost_usd: 0.5,
      modelUsage: {
        "claude-opus-5-5": { inputTokens: 150, outputTokens: 70, costUSD: 0.45 },
        "claude-haiku-4-5-20251001": { inputTokens: 10, outputTokens: 5, costUSD: 0.05 },
      },
    });
    expect((result as { costUsd: number }).costUsd).toBeCloseTo(0.2, 10);
    expect(result).toMatchObject({ tokens: { input: 60, output: 35 } });
  });

  it("reads the last cost-state record from the session transcript", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "claude-config-"));
    const project = path.join(root, "projects", "-Users-me-repo");
    mkdirSync(project, { recursive: true });
    const costState = (usd: number) =>
      JSON.stringify({
        type: "cost-state",
        sessionId: "s1",
        totalCostUSD: usd,
        modelUsage: { "claude-sonnet-5": { inputTokens: 1, outputTokens: 2 } },
      });
    writeFileSync(
      path.join(project, "s1.jsonl"),
      [costState(0.1), '{"type":"user"}', costState(0.25)].join("\n"),
    );
    expect(await readClaudeSessionCost("s1", root)).toEqual({
      costUsd: 0.25,
      modelUsage: { "claude-sonnet-5": { inputTokens: 1, outputTokens: 2 } },
    });
    expect(await readClaudeSessionCost("missing", root)).toBeUndefined();
  });
});

describe("ClaudeCodeAdapter resume retry baseline", () => {
  it("does not re-bill an attempt whose transcript cost-state was never written", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "claude-home-"));
    const bin = path.join(home, "fake-claude.sh");
    writeFileSync(bin, '#!/bin/sh\ncat > /dev/null\nprintf "%s\\n" "$FAKE_CLAUDE_OUT"\n', {
      mode: 0o755,
    });
    const adapter = new ClaudeCodeAdapter(bin);
    const run = async (totalCost: number) => {
      const events: AgentEvent[] = [];
      for await (const e of adapter.run({
        prompt: "continue",
        model: "claude-sonnet-5",
        resumeSessionId: "sess-retry",
        env: {
          CLAUDE_CONFIG_DIR: home,
          FAKE_CLAUDE_OUT: JSON.stringify({
            type: "result",
            is_error: false,
            session_id: "sess-retry",
            total_cost_usd: totalCost,
          }),
        },
      }))
        events.push(e);
      return (events.find((e) => e.kind === "result") as { costUsd?: number }).costUsd;
    };
    expect(await run(0.4)).toBeCloseTo(0.4, 10);
    // The session total now includes the first attempt's $0.40.
    expect(await run(0.55)).toBeCloseTo(0.15, 10);
  });
});
