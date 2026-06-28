import { describe, expect, it } from "vitest";
import { type ProcessLine, runProcessLines } from "../src/agents/spawn";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function drain(gen: AsyncGenerator<ProcessLine>): Promise<ProcessLine[]> {
  const lines: ProcessLine[] = [];
  for await (const item of gen) lines.push(item);
  return lines;
}

describe("runProcessLines signal handling", () => {
  it("kills a running child when the AbortSignal fires", async () => {
    const ac = new AbortController();
    const gen = runProcessLines({
      binary: "node",
      args: ["-e", "setTimeout(() => {}, 60_000)"],
      signal: ac.signal,
    });

    let exit: ProcessLine | undefined;
    const consumer = (async () => {
      for await (const item of gen) {
        if (item.kind === "exit") {
          exit = item;
          return;
        }
      }
    })();

    await delay(80);
    ac.abort();
    await consumer;

    expect(exit).toBeDefined();
    expect(exit).toMatchObject({ kind: "exit" });
    expect((exit as Extract<ProcessLine, { kind: "exit" }>).code).not.toBe(0);
  });

  it("sends SIGKILL when the child ignores SIGTERM", async () => {
    const gen = runProcessLines({
      binary: "node",
      args: ["-e", `process.on("SIGTERM", () => {}); setTimeout(() => {}, 60_000)`],
      signal: AbortSignal.timeout(100),
    });

    const exit = (await drain(gen)).find((l) => l.kind === "exit") as
      | Extract<ProcessLine, { kind: "exit" }>
      | undefined;

    expect(exit).toBeDefined();
    expect(exit!.signal).toBe("SIGKILL");
  }, 10_000);

  it("generator cleanup runs when abort signal fires mid-consumption", async () => {
    // Mirrors the CLI's Ctrl+C path: ac.abort() → startKill() → resolveWait()
    // → generator wakes up → child exits → exit event yielded.
    const ac = new AbortController();
    const gen = runProcessLines({
      binary: "node",
      args: ["-e", "setTimeout(() => {}, 60_000)"],
      signal: ac.signal,
    });

    let exit: ProcessLine | undefined;
    const consumer = (async () => {
      for await (const item of gen) {
        if (item.kind === "exit") {
          exit = item;
          return;
        }
      }
    })();

    await delay(80);
    ac.abort(); // trigger the kill chain from outside
    await consumer;

    expect(exit).toBeDefined();
    expect((exit as Extract<ProcessLine, { kind: "exit" }>).kind).toBe("exit");
  });

  it("generator returns promptly after abort (no hang)", async () => {
    const ac = new AbortController();
    const gen = runProcessLines({
      binary: "node",
      args: ["-e", "setTimeout(() => {}, 60_000)"],
      signal: ac.signal,
    });

    let exit: ProcessLine | undefined;
    const start = Date.now();
    const consumer = (async () => {
      for await (const item of gen) {
        if (item.kind === "exit") {
          exit = item;
          return;
        }
      }
    })();

    await delay(50);
    ac.abort();
    await consumer;
    const elapsed = Date.now() - start;

    expect(exit).toBeDefined();
    // Should complete quickly after abort, not wait for the 60s child.
    expect(elapsed).toBeLessThan(5000);
  });

  it("completes promptly when the child exits on its own", async () => {
    const gen = runProcessLines({
      binary: "node",
      args: ["-e", "process.exit(0)"],
    });
    const lines = await drain(gen);
    const exit = lines.find((l) => l.kind === "exit") as Extract<ProcessLine, { kind: "exit" }>;
    expect(exit).toBeDefined();
    expect(exit.code).toBe(0);
    expect(exit.signal).toBeNull();
  });

  it("reports stdout from the child before it exits", async () => {
    const gen = runProcessLines({
      binary: "node",
      args: ["-e", "process.stdout.write('hello\\n'); process.exit(0)"],
    });
    const lines = await drain(gen);
    const textLines = lines
      .filter((l) => l.kind === "line")
      .map((l) => (l as { kind: "line"; line: string }).line);
    expect(textLines).toContain("hello");
    const exit = lines.find((l) => l.kind === "exit") as Extract<ProcessLine, { kind: "exit" }>;
    expect(exit.code).toBe(0);
  });

  it("kills a long-running child when the signal is pre-aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const gen = runProcessLines({
      binary: "node",
      args: ["-e", "setTimeout(() => {}, 60_000)"],
      signal: ac.signal,
    });
    const lines = await drain(gen);
    const exit = lines.find((l) => l.kind === "exit") as Extract<ProcessLine, { kind: "exit" }>;
    expect(exit).toBeDefined();
    expect(exit.code).not.toBe(0);
  });

  it("exits with timedOut=true when the timeout fires", async () => {
    const gen = runProcessLines({
      binary: "node",
      args: ["-e", "setTimeout(() => {}, 60_000)"],
      timeoutMs: 100,
    });

    const lines = await drain(gen);
    const exit = lines.find((l) => l.kind === "exit") as Extract<ProcessLine, { kind: "exit" }>;
    expect(exit).toBeDefined();
    expect(exit.timedOut).toBe(true);
    expect(exit.code).not.toBe(0);
  });

  it("cancels the SIGKILL timer when the child exits during the grace period", async () => {
    // A child that exits 200ms after SIGTERM (well within the 2s grace).
    const gen = runProcessLines({
      binary: "node",
      args: ["-e", `process.on("SIGTERM", () => setTimeout(() => process.exit(0), 200))`],
      signal: AbortSignal.timeout(50),
    });

    const start = Date.now();
    const lines = await drain(gen);
    const elapsed = Date.now() - start;
    const exit = lines.find((l) => l.kind === "exit") as Extract<ProcessLine, { kind: "exit" }>;

    expect(exit).toBeDefined();
    // Should complete well before the 2s SIGKILL grace.
    expect(elapsed).toBeLessThan(2000);
  });

  it("reports stderr from the child", async () => {
    const gen = runProcessLines({
      binary: "node",
      args: ["-e", "process.stderr.write('err\\n'); process.exit(1)"],
    });
    const lines = await drain(gen);
    const exit = lines.find((l) => l.kind === "exit") as Extract<ProcessLine, { kind: "exit" }>;
    expect(exit).toBeDefined();
    expect(exit.stderr).toContain("err");
    expect(exit.code).toBe(1);
  });
});
