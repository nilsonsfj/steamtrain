import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  KIMI_MODELS,
  KimiAdapter,
  buildKimiRunArgs,
  buildKimiRunEnv,
  createKimiMapper,
  readKimiRunUsage,
} from "../src/agents/kimi";
import { fallbackKimiEfforts } from "../src/agents/kimi-efforts-fallback";

/**
 * Kimi Code speaks its own `stream-json` NDJSON protocol (`-p … --output-format
 * stream-json`): whole assistant messages, OpenAI-style tool_calls, tool
 * results, and a meta line carrying the session id.
 */

describe("KIMI_MODELS", () => {
  it("ships the Kimi Code catalog with K2.7 Coding as the default", () => {
    expect(KIMI_MODELS.map((m) => m.id)).toEqual([
      "kimi-code/kimi-for-coding",
      "kimi-code/kimi-for-coding-highspeed",
      "kimi-code/k3",
      "kimi-code/k3-256k",
    ]);
    expect(KIMI_MODELS.find((m) => m.id === "kimi-code/kimi-for-coding")).toMatchObject({
      name: "K2.7 Coding",
    });
    expect(KIMI_MODELS.some((m) => m.id.startsWith("opencode"))).toBe(false);
  });
});

describe("fallbackKimiEfforts", () => {
  it("exposes low/high/max for k3 aliases", () => {
    expect(fallbackKimiEfforts("kimi-code/k3")).toEqual(["low", "high", "max"]);
    expect(fallbackKimiEfforts("kimi-code/k3-256k")).toEqual(["low", "high", "max"]);
    expect(fallbackKimiEfforts("kimi-code/kimi-for-coding")).toEqual([]);
    expect(fallbackKimiEfforts("openai/gpt-5")).toEqual([]);
  });
});

describe("createKimiMapper", () => {
  it("emits session_start once from the meta resume hint", () => {
    const m = createKimiMapper();
    const line = JSON.parse(
      '{"role":"meta","type":"session.resume_hint","session_id":"session_abc","command":"kimi -r session_abc","content":"…"}',
    );
    expect(m(line)).toEqual([
      expect.objectContaining({ kind: "session_start", agent: "kimi", sessionId: "session_abc" }),
    ]);
    expect(m(line)).toEqual([]);
  });

  it("maps a whole assistant message to a single text_delta", () => {
    const m = createKimiMapper();
    const events = m(JSON.parse('{"role":"assistant","content":"hello world"}'));
    expect(events).toEqual([
      expect.objectContaining({ kind: "text_delta", agent: "kimi", text: "hello world\n" }),
    ]);
  });

  it("maps tool_calls to tool_use with parsed JSON arguments", () => {
    const m = createKimiMapper();
    const events = m(
      JSON.parse(
        '{"role":"assistant","tool_calls":[{"type":"function","id":"tool_1","function":{"name":"Bash","arguments":"{\\"command\\":\\"ls\\"}"}}]}',
      ),
    );
    expect(events).toEqual([
      expect.objectContaining({
        kind: "tool_use",
        agent: "kimi",
        id: "tool_1",
        name: "Bash",
        input: { command: "ls" },
      }),
    ]);
  });

  it("maps tool results back to their call id and name", () => {
    const m = createKimiMapper();
    m(
      JSON.parse(
        '{"role":"assistant","tool_calls":[{"type":"function","id":"tool_1","function":{"name":"Bash","arguments":"{}"}}]}',
      ),
    );
    const events = m(JSON.parse('{"role":"tool","tool_call_id":"tool_1","content":"file.txt"}'));
    expect(events).toEqual([
      expect.objectContaining({
        kind: "tool_result",
        agent: "kimi",
        id: "tool_1",
        name: "Bash",
        output: "file.txt",
        isError: false,
      }),
    ]);
  });

  it("honors is_error on tool results", () => {
    const m = createKimiMapper();
    const events = m(
      JSON.parse('{"role":"tool","tool_call_id":"tool_err","content":"boom","is_error":true}'),
    );
    expect(events).toEqual([
      expect.objectContaining({
        kind: "tool_result",
        id: "tool_err",
        isError: true,
        output: "boom",
      }),
    ]);
  });

  it("passes unrecognized lines through as unknown", () => {
    const m = createKimiMapper("kimi-fork");
    const events = m(JSON.parse('{"role":"meta","type":"session.some_future_hint"}'));
    expect(events).toEqual([
      expect.objectContaining({
        kind: "unknown",
        agent: "kimi-fork",
        rawType: "session.some_future_hint",
      }),
    ]);
  });

  it("treats an assistant line with empty content as unknown", () => {
    const m = createKimiMapper();
    const events = m(JSON.parse('{"role":"assistant","content":""}'));
    expect(events).toEqual([
      expect.objectContaining({ kind: "unknown", agent: "kimi", rawType: "assistant" }),
    ]);
  });

  it("keeps unparseable tool arguments as the raw string", () => {
    const m = createKimiMapper();
    const events = m(
      JSON.parse(
        '{"role":"assistant","tool_calls":[{"type":"function","id":"tool_1","function":{"name":"Bash","arguments":"not json"}}]}',
      ),
    );
    expect(events).toEqual([expect.objectContaining({ kind: "tool_use", input: "not json" })]);
  });

  it("passes non-string tool arguments through unchanged", () => {
    const m = createKimiMapper();
    const events = m(
      JSON.parse(
        '{"role":"assistant","tool_calls":[{"type":"function","id":"tool_1","function":{"name":"Bash","arguments":{"command":"ls"}}}]}',
      ),
    );
    expect(events).toEqual([
      expect.objectContaining({ kind: "tool_use", input: { command: "ls" } }),
    ]);
  });

  it("flags completely unrecognized shapes as unknown without a rawType", () => {
    const m = createKimiMapper();
    expect(m(42)).toEqual([
      expect.objectContaining({ kind: "unknown", agent: "kimi", rawType: undefined }),
    ]);
  });
});

describe("buildKimiRunArgs", () => {
  it("keeps the prompt as the final -p pair and keeps effort out of argv", () => {
    const args = buildKimiRunArgs({
      prompt: "do the thing",
      model: "kimi-code/k3",
      effort: "max",
    });
    expect(args).toEqual([
      "-m",
      "kimi-code/k3",
      "--output-format",
      "stream-json",
      "-p",
      "do the thing",
    ]);
  });

  it("appends extraArgs before the prompt", () => {
    const args = buildKimiRunArgs({
      prompt: "do the thing",
      model: "kimi-code/k3",
      extraArgs: ["--add-dir", "/tmp/extra"],
    });
    expect(args.at(-4)).toBe("--add-dir");
    expect(args.at(-3)).toBe("/tmp/extra");
    expect(args.at(-2)).toBe("-p");
    expect(args.at(-1)).toBe("do the thing");
  });

  it("prepends --session when resuming", () => {
    const args = buildKimiRunArgs({
      prompt: "continue",
      model: "kimi-code/kimi-for-coding",
      resumeSessionId: "session_abc",
    });
    expect(args.slice(0, 2)).toEqual(["--session", "session_abc"]);
    expect(args.at(-2)).toBe("-p");
    expect(args.at(-1)).toBe("continue");
  });
});

describe("buildKimiRunEnv", () => {
  it("forwards effort via KIMI_MODEL_THINKING_EFFORT", () => {
    expect(buildKimiRunEnv({ prompt: "p", model: "kimi-code/k3", effort: "max" })).toEqual({
      KIMI_MODEL_THINKING_EFFORT: "max",
    });
  });

  it("merges over caller-provided env", () => {
    expect(
      buildKimiRunEnv({
        prompt: "p",
        model: "kimi-code/k3",
        effort: "low",
        env: { FOO: "bar" },
      }),
    ).toEqual({ FOO: "bar", KIMI_MODEL_THINKING_EFFORT: "low" });
  });

  it("leaves env untouched without an effort", () => {
    expect(buildKimiRunEnv({ prompt: "p", model: "kimi-code/k3" })).toBeUndefined();
    expect(buildKimiRunEnv({ prompt: "p", model: "kimi-code/k3", env: { FOO: "bar" } })).toEqual({
      FOO: "bar",
    });
  });
});

describe("KimiAdapter", () => {
  it("defaults to the kimi binary and K2.7 Coding", () => {
    const adapter = new KimiAdapter();
    expect(adapter.id).toBe("kimi");
    expect(adapter.binary).toBe("kimi");
    expect(adapter.defaultModel).toBe("kimi-code/kimi-for-coding");
    expect(adapter.supportsResume).toBe(true);
  });

  it("accepts a custom binary override", () => {
    expect(new KimiAdapter("kimi-cli").binary).toBe("kimi-cli");
  });
});

describe("kimi run usage (read back from the session's wire logs)", () => {
  function sessionHome(): { home: string; write: (agent: string, lines: object[]) => void } {
    const home = mkdtempSync(path.join(tmpdir(), "kimi-home-"));
    const write = (agent: string, lines: object[]) => {
      const dir = path.join(home, "sessions", "wd_proj_abc123", "session_s1", "agents", agent);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "wire.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
    };
    return { home, write };
  }
  const record = (time: number, inputOther: number, output: number, inputCacheRead = 0) => ({
    type: "usage.record",
    model: "kimi-code/k3",
    usage: { inputOther, output, inputCacheRead, inputCacheCreation: 0 },
    usageScope: "turn",
    time,
  });

  it("sums this run's usage records across the main loop and subagents", async () => {
    const { home, write } = sessionHome();
    write("main", [
      record(100, 999, 999), // an earlier run of this resumed session
      { type: "step.end", usage: { inputOther: 5 } },
      record(2000, 300, 40, 1000),
      record(3000, 100, 10, 2000),
    ]);
    write("agent-1", [record(2500, 50, 5)]);
    expect(await readKimiRunUsage("session_s1", 1000, home)).toEqual({
      input: 450,
      output: 55,
      cacheRead: 3000,
      cacheWrite: 0,
    });
  });

  it("reports nothing for an unknown session or a home without sessions", async () => {
    const { home, write } = sessionHome();
    write("main", [record(2000, 1, 1)]);
    expect(await readKimiRunUsage("session_other", 0, home)).toBeUndefined();
    expect(await readKimiRunUsage("session_s1", 0, path.join(home, "missing"))).toBeUndefined();
  });
});
