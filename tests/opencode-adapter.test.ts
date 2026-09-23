import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
// Real opencode 1.18.x envelope: the stored `step-finish` part, verbatim.
const stepFinish =
  '{"type":"step_finish","timestamp":1790100893134,"sessionID":"ses_abc","part":{"id":"prt_sf1","type":"step-finish","reason":"stop","cost":0.0012,"tokens":{"total":1510,"input":1000,"output":200,"reasoning":10,"cache":{"write":0,"read":300}}}}';
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

    // step_finish becomes a result carrying the part's cost and tokens.
    // opencode's `output` excludes reasoning; the normalized one includes it.
    expect(m(JSON.parse(stepFinish))).toEqual([
      expect.objectContaining({
        kind: "result",
        isError: false,
        subtype: "step_finish",
        costUsd: 0.0012,
        tokens: { input: 1000, output: 210, reasoning: 10, cacheRead: 300, cacheWrite: 0 },
      }),
    ]);
  });

  it("accumulates cost and tokens across a turn's step_finish events", () => {
    // Each step_finish prices one model call; a tool-using turn has several.
    const m = createOpenCodeMapper();
    const step = (id: string, cost: number, input: number, output: number) =>
      JSON.parse(
        `{"type":"step_finish","sessionID":"ses_abc","part":{"id":"${id}","type":"step-finish","reason":"tool-calls","cost":${cost},"tokens":{"input":${input},"output":${output},"reasoning":0,"cache":{"write":0,"read":50}}}}`,
      );
    m(step("prt_a", 0.01, 100, 20));
    // A re-emitted part is not billed twice.
    m(step("prt_a", 0.01, 100, 20));
    const [last] = m(step("prt_b", 0.02, 300, 40)).filter((e) => e.kind === "result");
    expect(last).toMatchObject({
      costUsd: 0.03,
      tokens: { input: 400, output: 60, cacheRead: 100, cacheWrite: 0, reasoning: 0 },
    });
  });

  it("still reads a flat (legacy) step_finish cost", () => {
    const m = createOpenCodeMapper();
    expect(m(JSON.parse('{"type":"step_finish","sessionID":"ses_abc","cost":0.5}'))).toEqual([
      expect.objectContaining({ kind: "session_start" }),
      expect.objectContaining({ kind: "result", costUsd: 0.5 }),
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

describe("OpenCodeAdapter resuming a session recorded in another directory", () => {
  /**
   * A stand-in `opencode`: `export` prints a session recorded in `$SESSION_DIR`,
   * `import` logs what it was given and from where, and `run` prints the
   * session it was told to continue.
   */
  function fakeOpencode(sessionDir: string) {
    const home = mkdtempSync(path.join(tmpdir(), "st-oc-"));
    const log = path.join(home, "calls.jsonl");
    const bin = path.join(home, "opencode");
    const exported = {
      info: { id: "ses_f33132908ffeY2p6iYE7DZEtR1", directory: sessionDir, title: "t" },
      messages: [
        {
          info: {
            id: "msg_0ccecd714001CRrlS5pM4zyCeP",
            sessionID: "ses_f33132908ffeY2p6iYE7DZEtR1",
          },
          parts: [
            {
              id: "prt_0ccecd71a001bY6TT1esjTSlIU",
              sessionID: "ses_f33132908ffeY2p6iYE7DZEtR1",
              messageID: "msg_0ccecd714001CRrlS5pM4zyCeP",
              type: "text",
              text: "Remember PINEAPPLE",
            },
          ],
        },
      ],
    };
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const fs = require("fs");
const [cmd, ...rest] = process.argv.slice(2);
const log = (o) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cmd, cwd: process.cwd(), ...o }) + "\\n");
if (cmd === "export") {
  fs.appendFileSync(${JSON.stringify(`${log}.exports`)}, rest[0] + "\\n");
  if (process.env.FAIL_EXPORT) { process.stderr.write("Session not found"); process.exit(1); }
  if (process.env.SLOW_EXPORT) { setTimeout(() => {}, 30000); return; }
  process.stderr.write("Exporting session: " + rest[0] + "\\n");
  // A log line on stdout, braces and all, before the document itself.
  if (process.env.NOISY_EXPORT) process.stdout.write('{"level":"info","msg":"exporting"}\\n');
  process.stdout.write(${JSON.stringify(JSON.stringify(exported))});
} else if (cmd === "import") {
  log({ session: JSON.parse(fs.readFileSync(rest[0], "utf8")) });
} else {
  const session = process.argv[process.argv.indexOf("--session") + 1];
  log({ session });
  process.stdout.write(JSON.stringify({ type: "step_start", sessionID: session }) + "\\n");
}
`,
      { mode: 0o755 },
    );
    const calls = () =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
    const exports = () => {
      try {
        return readFileSync(`${log}.exports`, "utf8").trim().split("\n").filter(Boolean);
      } catch {
        return [];
      }
    };
    return { bin, calls, exports };
  }

  async function run(bin: string, cwd: string, env?: Record<string, string>, signal?: AbortSignal) {
    const events: AgentEvent[] = [];
    for await (const e of new OpenCodeAdapter(bin).run({
      prompt: "go on",
      model: "opencode/gpt-5.5",
      cwd,
      resumeSessionId: "ses_f33132908ffeY2p6iYE7DZEtR1",
      env,
      signal,
    }))
      events.push(e);
    return events;
  }

  it("copies the session into the step's worktree and continues the copy", async () => {
    const source = mkdtempSync(path.join(tmpdir(), "st-oc-src-"));
    const target = mkdtempSync(path.join(tmpdir(), "st-oc-dst-"));
    const { bin, calls } = fakeOpencode(source);

    await run(bin, target);

    const [imported, ran] = calls();
    expect(imported.cmd).toBe("import");
    // Import files a session under its own cwd, so it must run in the target.
    expect(realpathSync(imported.cwd)).toBe(realpathSync(target));
    const copy = imported.session;
    const text = JSON.stringify(copy);
    // Import skips rows whose ids exist, so no original id may survive…
    for (const old of [
      "ses_f33132908ffeY2p6iYE7DZEtR1",
      "msg_0ccecd714001CRrlS5pM4zyCeP",
      "prt_0ccecd71a001bY6TT1esjTSlIU",
    ]) {
      expect(text).not.toContain(old);
    }
    // …but each keeps its time prefix, and references follow their rows.
    expect(copy.info.id).toMatch(/^ses_f33132908ffe[0-9A-Za-z]{14}$/);
    expect(copy.messages[0].info.id).toMatch(/^msg_0ccecd714001[0-9A-Za-z]{14}$/);
    expect(copy.messages[0].parts[0].messageID).toBe(copy.messages[0].info.id);
    expect(copy.messages[0].parts[0].sessionID).toBe(copy.info.id);
    expect(copy.messages[0].parts[0].text).toBe("Remember PINEAPPLE");
    expect(ran.session).toBe(copy.info.id);
  });

  it("finds the export past a log line printed before it", async () => {
    const source = mkdtempSync(path.join(tmpdir(), "st-oc-src-"));
    const target = mkdtempSync(path.join(tmpdir(), "st-oc-dst-"));
    const { bin, calls } = fakeOpencode(source);

    await run(bin, target, { NOISY_EXPORT: "1" });

    const [imported, ran] = calls();
    expect(imported.cmd).toBe("import");
    expect(ran.session).toBe(imported.session.info.id);
  });

  it("continues the session itself when it already lives in the step's directory", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "st-oc-same-"));
    const { bin, calls } = fakeOpencode(dir);

    await run(bin, dir);

    expect(calls()).toEqual([
      expect.objectContaining({ cmd: "run", session: "ses_f33132908ffeY2p6iYE7DZEtR1" }),
    ]);
  });

  it("skips the export once it has seen the session run in the step's directory", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "st-oc-known-"));
    const { bin, calls, exports } = fakeOpencode(dir);

    // The first resume has to ask where the session lives; the second
    // (a canAsk answer, a structured-output fix) already knows.
    await run(bin, dir);
    await run(bin, dir);

    expect(exports()).toHaveLength(1);
    expect(calls().map((c) => c.session)).toEqual([
      "ses_f33132908ffeY2p6iYE7DZEtR1",
      "ses_f33132908ffeY2p6iYE7DZEtR1",
    ]);
    // A different directory still gets its own copy.
    const other = mkdtempSync(path.join(tmpdir(), "st-oc-other-"));
    await run(bin, other);
    expect(exports()).toHaveLength(2);
    expect(calls().at(-2)?.cmd).toBe("import");
  });

  it("stops copying the session as soon as the step is canceled", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "st-oc-abort-"));
    const { bin } = fakeOpencode(dir);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);

    const started = Date.now();
    const events = await run(bin, dir, { SLOW_EXPORT: "1" }, ac.signal);

    expect(Date.now() - started).toBeLessThan(5000);
    expect(events).toEqual([expect.objectContaining({ kind: "error" })]);
  });

  it("fails the step instead of hanging when the session cannot be copied", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "st-oc-fail-"));
    const { bin } = fakeOpencode(dir);

    const events = await run(bin, dir, { FAIL_EXPORT: "1" });

    expect(events).toEqual([
      expect.objectContaining({
        kind: "error",
        message: expect.stringMatching(
          /could not continue session ses_f33132908ffeY2p6iYE7DZEtR1.*Session not found/,
        ),
      }),
    ]);
  });
});
