import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GrokAdapter, createGrokMapper } from "../src/agents/grok";
import type { AgentEvent } from "../src/types/events";

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function map(line: string, model?: string): AgentEvent[] {
  return createGrokMapper("grok", model)(JSON.parse(line));
}

function kinds(events: AgentEvent[]): string[] {
  return events.map((event) => event.kind);
}

describe("grok streaming-json mapper", () => {
  const mapper = () => createGrokMapper("reviewer", "grok-4.7");

  it("maps text, thought, tool calls, usage, and the terminal end line", () => {
    const mapLine = mapper();
    expect(kinds(mapLine({ type: "thought", data: "Looking" }))).toEqual(["text_delta"]);
    expect(mapLine({ type: "thought", data: "Looking" })[0]).toMatchObject({
      thinking: true,
      text: "Looking",
      agent: "reviewer",
    });
    expect(mapLine({ type: "text", data: "Done" })).toEqual([
      expect.objectContaining({ kind: "text_delta", text: "Done" }),
    ]);
    expect(mapLine({ type: "text", data: "Done" })[0]).not.toHaveProperty("thinking");

    expect(
      mapLine({
        type: "tool_call",
        toolCallId: "call_1",
        toolName: "read_file",
        status: "in_progress",
        rawInput: { path: "src/a.ts" },
      }),
    ).toEqual([
      expect.objectContaining({
        kind: "tool_use",
        id: "call_1",
        name: "read_file",
        input: { path: "src/a.ts" },
      }),
    ]);

    expect(
      mapLine({
        type: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
        rawOutput: { lines: 4 },
      }),
    ).toEqual([
      expect.objectContaining({
        kind: "tool_result",
        id: "call_1",
        name: "read_file",
        isError: false,
        output: JSON.stringify({ lines: 4 }),
      }),
    ]);

    expect(
      mapLine({
        type: "usage",
        usage: { input_tokens: 10, output_tokens: 4, reasoning_tokens: 2 },
      }),
    ).toEqual([
      expect.objectContaining({
        kind: "usage",
        tokens: { input: 10, output: 4, reasoning: 2 },
      }),
    ]);

    const end = mapLine({
      type: "end",
      stopReason: "end_turn",
      sessionId: "sess-g1",
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 1,
        reasoning_tokens: 2,
      },
      total_cost_usd: 0.01,
    });
    expect(end.map((event) => event.kind)).toEqual(["session_start", "result"]);
    expect(end[0]).toMatchObject({
      kind: "session_start",
      sessionId: "sess-g1",
      model: "grok-4.7",
      agent: "reviewer",
    });
    expect(end[1]).toMatchObject({
      kind: "result",
      isError: false,
      subtype: "end_turn",
      costUsd: 0.01,
      tokens: { input: 10, output: 4, cacheRead: 3, cacheWrite: 1, reasoning: 2 },
    });
  });

  it("announces the session once, even if later lines repeat it", () => {
    const mapLine = mapper();
    const first = mapLine({ type: "text", data: "Hi", sessionId: "sess-early" });
    expect(first.map((event) => event.kind)).toEqual(["session_start", "text_delta"]);
    const again = mapLine({ type: "end", stopReason: "end_turn", sessionId: "sess-early" });
    expect(again.map((event) => event.kind)).toEqual(["result"]);
  });

  it("accepts session_id and skips quiet control lines", () => {
    expect(map('{"type":"plan","session_id":"abc","entries":[]}')[0]).toMatchObject({
      kind: "session_start",
      sessionId: "abc",
    });
    expect(map('{"type":"available_commands"}')).toEqual([]);
    expect(map('{"type":"auto_compact_start"}')).toEqual([]);
    expect(map('{"type":"max_turns_reached"}')).toEqual([]);
    expect(map('{"type":"text","data":""}')).toEqual([]);
  });

  it("flags failed tool updates and completed calls that already carry output", () => {
    const failed = map(
      '{"type":"tool_call_update","toolCallId":"c9","title":"Shell","status":"failed","rawOutput":{"error":"nope"}}',
    );
    expect(failed).toEqual([
      expect.objectContaining({ kind: "tool_use", name: "Shell" }),
      expect.objectContaining({ kind: "tool_result", name: "Shell", isError: true }),
    ]);

    const done = map(
      '{"type":"tool_call","toolCallId":"c2","toolName":"search_replace","status":"completed","rawInput":{"path":"a"},"rawOutput":{"error":"denied"}}',
    );
    expect(done.map((event) => event.kind)).toEqual(["tool_use", "tool_result"]);
    expect(done[1]).toMatchObject({ isError: true });
  });

  it("does not emit a second result for a repeated terminal update", () => {
    const mapLine = createGrokMapper();
    mapLine({
      type: "tool_call_update",
      toolCallId: "c1",
      toolName: "read_file",
      status: "completed",
      rawOutput: "ok",
    });
    expect(
      mapLine({
        type: "tool_call_update",
        toolCallId: "c1",
        status: "completed",
        rawOutput: "ok",
      }),
    ).toEqual([]);
  });

  it("maps refusal and cancelled ends as errors, and withholds partial cost", () => {
    const refusal = map('{"type":"end","stopReason":"refusal","sessionId":"s","text":"no"}');
    expect(refusal.map((event) => event.kind)).toEqual(["session_start", "error", "result"]);
    expect(refusal[2]).toMatchObject({ isError: true, subtype: "refusal", text: "no" });

    const partial = map(
      '{"type":"end","stopReason":"end_turn","total_cost_usd":1,"cost_is_partial":true,"usage_is_incomplete":true}',
    );
    expect(partial[0]).toMatchObject({ kind: "result", isError: false, costUsd: undefined });
  });

  it("maps error lines, including spend when it was recorded", () => {
    expect(map('{"type":"error","message":"not logged in"}')).toEqual([
      expect.objectContaining({ kind: "error", message: "not logged in" }),
    ]);
    const spent = map(
      '{"type":"error","message":"overloaded","usage":{"output_tokens":3},"total_cost_usd":0.2}',
    );
    expect(spent.map((event) => event.kind)).toEqual(["error", "result"]);
    expect(spent[1]).toMatchObject({
      isError: true,
      tokens: { output: 3 },
      costUsd: 0.2,
    });
  });

  it("keeps unrecognized lines visible", () => {
    expect(map('{"type":"future_event","n":1}')[0]).toMatchObject({
      kind: "unknown",
      rawType: "future_event",
    });
    expect(map("null")).toEqual([expect.objectContaining({ kind: "unknown" })]);
  });
});

describe("GrokAdapter", () => {
  it("defaults to the grok binary, Grok 4.7, and resume", () => {
    const adapter = new GrokAdapter();
    expect(adapter.id).toBe("grok");
    expect(adapter.binary).toBe("grok");
    expect(adapter.defaultModel).toBe("grok-4.7");
    expect(adapter.supportsResume).toBe(true);
    expect(new GrokAdapter("/opt/grok").binary).toBe("/opt/grok");
  });

  it("runs a headless streaming-json process and reads the prompt file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steamtrain-grok-fake-"));
    scratch.push(dir);
    const argvFile = join(dir, "argv.json");
    const binary = join(dir, "grok");
    writeFileSync(
      binary,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.GROK_ARGV_OUT, JSON.stringify(args));
const file = args[args.indexOf("--prompt-file") + 1];
const prompt = fs.readFileSync(file, "utf8");
const lines = [
  { type: "text", data: prompt },
  { type: "end", stopReason: "end_turn", sessionId: "sess-live", text: prompt },
];
process.stdout.write(lines.map((line) => JSON.stringify(line)).join("\\n") + "\\n");
`,
      { mode: 0o755 },
    );

    const adapter = new GrokAdapter(binary);
    const events: AgentEvent[] = [];
    for await (const event of adapter.run({
      prompt: "ship it",
      model: "grok-4.7",
      effort: "high",
      resumeSessionId: "sess-prev",
      env: { GROK_ARGV_OUT: argvFile },
    })) {
      events.push(event);
    }

    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    expect(argv).toContain("--output-format");
    expect(argv[argv.indexOf("--output-format") + 1]).toBe("streaming-json");
    expect(argv).toContain("--always-approve");
    expect(argv).toContain("--effort");
    expect(argv).toContain("--resume");
    expect(argv[argv.indexOf("--resume") + 1]).toBe("sess-prev");
    const promptFile = argv[argv.indexOf("--prompt-file") + 1]!;
    expect(promptFile.endsWith("prompt.txt")).toBe(true);
    expect(events.map((event) => event.kind)).toEqual(["text_delta", "session_start", "result"]);
    expect(events[0]).toMatchObject({ kind: "text_delta", text: "ship it" });
    expect(events[2]).toMatchObject({ kind: "result", text: "ship it", isError: false });
    // The prompt file is removed once the run finishes.
    expect(() => readFileSync(promptFile, "utf8")).toThrow();
  });
});
