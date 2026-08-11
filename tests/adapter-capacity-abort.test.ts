import { describe, expect, it } from "vitest";
import { runAgentProcess } from "../src/agents/adapter";
import type { AgentEvent } from "../src/types/events";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

describe("runAgentProcess capacity abort", () => {
  it("kills a hung child when stderr reports rate-limit exhaustion", async () => {
    // Mimic OpenCode JSON mode: log a capacity ERROR on stderr, then wait forever
    // with no stdout (the real CLI waits hours for the free-tier retry window).
    const gen = runAgentProcess({
      id: "opencode",
      binary: "node",
      args: [
        "-e",
        [
          "process.stderr.write(",
          JSON.stringify(
            'timestamp=2026-08-11T00:00:00.000Z level=ERROR message="stream error" error.error="AI_APICallError: Rate limit exceeded. Please try again later."\n',
          ),
          ");",
          "setTimeout(() => {}, 60_000);",
        ].join(""),
      ],
      opts: { prompt: "hi", model: "opencode/mimo-v2.5-free", idleTimeoutMs: 0 },
      map: () => [],
    });

    const start = Date.now();
    const events = await drain(gen);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5000);
    const err = events.find((e) => e.kind === "error");
    expect(err).toEqual(
      expect.objectContaining({
        kind: "error",
        category: "rate_limit",
        message: expect.stringContaining("Rate limit exceeded"),
      }),
    );
  });

  it("kills a hung child when stderr reports OpenCode free-usage exhaustion", async () => {
    const gen = runAgentProcess({
      id: "opencode",
      binary: "node",
      args: [
        "-e",
        [
          "process.stderr.write(",
          JSON.stringify("Free usage exceeded, subscribe to Go [retrying in 18h 1m attempt #1]\n"),
          ");",
          "setTimeout(() => {}, 60_000);",
        ].join(""),
      ],
      opts: { prompt: "hi", model: "opencode/mimo-v2.5-free", idleTimeoutMs: 0 },
      map: () => [],
    });

    const start = Date.now();
    const events = await drain(gen);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(events.find((e) => e.kind === "error")).toEqual(
      expect.objectContaining({
        kind: "error",
        category: "quota",
        message: expect.stringContaining("Free usage exceeded"),
      }),
    );
  });

  it("does not abort on unrelated stderr noise", async () => {
    const gen = runAgentProcess({
      id: "opencode",
      binary: "node",
      args: [
        "-e",
        'process.stderr.write(\'loading plugins\\n\'); process.stdout.write(\'{"type":"step_start","sessionID":"ses_x"}\\n\'); process.exit(0);',
      ],
      opts: { prompt: "hi", model: "opencode/mimo-v2.5-free" },
      map: () => [{ kind: "session_start", agent: "opencode", ts: 1, sessionId: "ses_x" }],
    });

    const events = await drain(gen);
    expect(events.some((e) => e.kind === "error")).toBe(false);
    expect(events.some((e) => e.kind === "session_start")).toBe(true);
  });

  it("still respects an external AbortSignal", async () => {
    const ac = new AbortController();
    const gen = runAgentProcess({
      id: "opencode",
      binary: "node",
      args: ["-e", "setTimeout(() => {}, 60_000)"],
      opts: { prompt: "hi", model: "x", signal: ac.signal, idleTimeoutMs: 0 },
      map: () => [],
    });

    const consumer = drain(gen);
    await delay(50);
    ac.abort();
    const events = await consumer;
    expect(events.some((e) => e.kind === "error")).toBe(true);
  });
});
