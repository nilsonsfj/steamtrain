import { describe, expect, it } from "vitest";
import { buildKiroExecArgs, runKiroProcess } from "../src/agents/kiro";
import type { AgentEvent } from "../src/types/events";

/**
 * Real headless contract (kiro-cli 2.x):
 *   kiro-cli chat --no-interactive --trust-all-tools --model MODEL [--effort E] PROMPT
 *
 * Output is plain text on stdout — there is no Claude-style `--print` /
 * `--output-format stream-json` (those flags are rejected by the CLI).
 */

describe("buildKiroExecArgs", () => {
  it("builds headless chat argv with prompt last (no --print)", () => {
    const args = buildKiroExecArgs({ prompt: "do a thing", model: "sonnet" });
    expect(args).toEqual([
      "chat",
      "--no-interactive",
      "--trust-all-tools",
      "--wrap",
      "never",
      "--model",
      "sonnet",
      "do a thing",
    ]);
    expect(args).not.toContain("--print");
    expect(args).not.toContain("stream-json");
  });

  it("appends --effort when provided", () => {
    const args = buildKiroExecArgs({ prompt: "go", model: "opus", effort: "high" });
    expect(args).toEqual([
      "chat",
      "--no-interactive",
      "--trust-all-tools",
      "--wrap",
      "never",
      "--model",
      "opus",
      "--effort",
      "high",
      "go",
    ]);
  });

  it("appends extraArgs before the prompt (resume not wired yet)", () => {
    const args = buildKiroExecArgs({
      prompt: "continue",
      model: "sonnet",
      effort: "max",
      resumeSessionId: "sess-abc",
      extraArgs: ["--agent", "reviewer"],
    });
    expect(args).toEqual([
      "chat",
      "--no-interactive",
      "--trust-all-tools",
      "--wrap",
      "never",
      "--model",
      "sonnet",
      "--effort",
      "max",
      "--agent",
      "reviewer",
      "continue",
    ]);
    expect(args).not.toContain("--resume-id");
  });

  it("omits --effort when not provided", () => {
    const args = buildKiroExecArgs({ prompt: "go", model: "haiku" });
    expect(args).not.toContain("--effort");
  });
});

describe("runKiroProcess", () => {
  async function collect(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
    const out: AgentEvent[] = [];
    for await (const event of iter) out.push(event);
    return out;
  }

  it("keeps stdin closed and streams stdout lines as text_delta + result", async () => {
    let seenOpts: import("../src/agents/spawn").ProcessRunOptions | undefined;
    const events = await collect(
      runKiroProcess({
        id: "kiro",
        binary: "kiro-cli",
        args: buildKiroExecArgs({ prompt: "hi", model: "sonnet" }),
        opts: { prompt: "hi", model: "sonnet", cwd: "/tmp/demo" },
        runLines: async function* (opts) {
          seenOpts = opts;
          yield { kind: "line", line: "hello" };
          yield { kind: "line", line: "world" };
          yield {
            kind: "exit",
            code: 0,
            signal: null,
            timedOut: false,
            stderr: "",
            sawStdout: true,
          };
        },
      }),
    );

    // Prompt is an argv token — stdin must stay closed (open stdin can hang
    // non-interactive chat when nothing is piped).
    expect(seenOpts?.prompt).toBeUndefined();
    expect(events.map((e) => e.kind)).toEqual(["text_delta", "text_delta", "result"]);
    expect(events[0]).toMatchObject({ kind: "text_delta", agent: "kiro", text: "hello\n" });
    expect(events[1]).toMatchObject({ kind: "text_delta", text: "world\n" });
    expect(events[2]).toMatchObject({
      kind: "result",
      text: "hello\nworld",
      isError: false,
    });
  });

  it("reports spawn failure, timeout, and non-zero exit", async () => {
    const spawnEvents = await collect(
      runKiroProcess({
        id: "kiro",
        binary: "kiro-cli",
        args: [],
        opts: { prompt: "hi", model: "sonnet" },
        runLines: async function* () {
          yield {
            kind: "exit",
            code: null,
            signal: null,
            timedOut: false,
            stderr: "",
            sawStdout: false,
            spawnError: "ENOENT",
          };
        },
      }),
    );
    expect(spawnEvents).toEqual([
      expect.objectContaining({
        kind: "error",
        message: "failed to start 'kiro-cli': ENOENT",
      }),
    ]);

    const timeoutEvents = await collect(
      runKiroProcess({
        id: "kiro",
        binary: "kiro-cli",
        args: [],
        opts: { prompt: "hi", model: "sonnet", timeoutMs: 5000 },
        runLines: async function* () {
          yield {
            kind: "exit",
            code: null,
            signal: null,
            timedOut: true,
            stderr: "",
            sawStdout: false,
          };
        },
      }),
    );
    expect(timeoutEvents).toEqual([
      expect.objectContaining({
        kind: "error",
        message: "'kiro-cli' timed out after 5s",
      }),
    ]);

    const exitEvents = await collect(
      runKiroProcess({
        id: "kiro",
        binary: "kiro-cli",
        args: [],
        opts: { prompt: "hi", model: "sonnet" },
        runLines: async function* () {
          yield {
            kind: "exit",
            code: 2,
            signal: null,
            timedOut: false,
            stderr: "error: unexpected argument '--print' found",
            sawStdout: false,
          };
        },
      }),
    );
    expect(exitEvents).toEqual([
      expect.objectContaining({
        kind: "error",
        message: expect.stringContaining("exited with code 2"),
        code: 2,
      }),
    ]);
    expect((exitEvents[0] as { message: string }).message).toContain("unexpected argument '--print'");
  });

  it("errors when stdout is empty on success", async () => {
    const events = await collect(
      runKiroProcess({
        id: "kiro",
        binary: "kiro-cli",
        args: [],
        opts: { prompt: "hi", model: "sonnet" },
        runLines: async function* () {
          yield {
            kind: "exit",
            code: 0,
            signal: null,
            timedOut: false,
            stderr: "",
            sawStdout: false,
          };
        },
      }),
    );
    expect(events).toEqual([
      expect.objectContaining({
        kind: "error",
        message: expect.stringContaining("produced no output"),
      }),
    ]);
  });
});
