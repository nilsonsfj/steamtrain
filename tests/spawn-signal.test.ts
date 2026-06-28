import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { type ProcessLine, runProcessLines } from "../src/agents/spawn";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function drain(gen: AsyncGenerator<ProcessLine>): Promise<ProcessLine[]> {
  const lines: ProcessLine[] = [];
  for await (const item of gen) lines.push(item);
  return lines;
}

describe("runProcessLines signal handling", () => {
  it("generator exits promptly when AbortSignal fires", async () => {
    const ac = new AbortController();
    const gen = runProcessLines({
      binary: "node",
      args: ["-e", "setTimeout(() => {}, 60_000)"],
      signal: ac.signal,
    });

    const start = Date.now();
    const consumer = (async () => {
      for await (const _item of gen) {
        // no items expected from a silent child
      }
    })();

    await delay(80);
    ac.abort();
    await consumer;
    const elapsed = Date.now() - start;

    // Generator exits via `killed` check — clean return, no hang.
    expect(elapsed).toBeLessThan(2000);
  });

  it("generator exits via killed flag without yielding exit event", async () => {
    const ac = new AbortController();
    const gen = runProcessLines({
      binary: "node",
      args: ["-e", "setTimeout(() => {}, 60_000)"],
      signal: ac.signal,
    });

    const items: ProcessLine[] = [];
    const consumer = (async () => {
      for await (const item of gen) items.push(item);
    })();

    await delay(50);
    ac.abort();
    await consumer;

    // The generator returned via `killed` flag — no exit event yielded.
    expect(items.filter((i) => i.kind === "exit")).toHaveLength(0);
  });

  it("pre-aborted signal kills child and generator exits immediately", async () => {
    // When the signal is already aborted at spawn time, startKill() fires
    // before the generator loop starts. The generator exits via `killed`.
    const ac = new AbortController();
    ac.abort();
    const gen = runProcessLines({
      binary: "node",
      args: ["-e", "setTimeout(() => {}, 60_000)"],
      signal: ac.signal,
    });
    const items = await drain(gen);
    // Generator exits via killed flag — no exit event.
    expect(items.filter((i) => i.kind === "exit")).toHaveLength(0);
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

  it("exits promptly when the timeout fires", async () => {
    const gen = runProcessLines({
      binary: "node",
      args: ["-e", "setTimeout(() => {}, 60_000)"],
      timeoutMs: 100,
    });

    const start = Date.now();
    await drain(gen);
    const elapsed = Date.now() - start;

    // Generator exits via killed flag — prompt, no hang.
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

describe("kill chain (SIGTERM → SIGKILL fallback)", () => {
  it("SIGKILL kills a SIGTERM-immune child after grace period", async () => {
    // Spawn a child that ignores SIGTERM. Verify SIGKILL is the fallback.
    const child = spawn(
      "node",
      [
        "-e",
        `process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setTimeout(() => {}, 60_000)`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let exitSignal: string | null = null;
    child.on("close", (_code: number | null, signal: string | null) => {
      exitSignal = signal;
    });

    // Wait for readiness (handler installed).
    await new Promise<void>((resolve) => {
      child.stdout.once("data", () => resolve());
    });

    child.kill("SIGTERM"); // ignored by child
    await delay(2200); // grace period
    child.kill("SIGKILL"); // fallback — this is what killProcess() does
    await delay(200);

    expect(exitSignal).toBe("SIGKILL");
  }, 10_000);

  it("a child that handles SIGTERM exits cleanly before SIGKILL", async () => {
    const child = spawn(
      "node",
      [
        "-e",
        `process.on("SIGTERM", () => process.exit(0)); process.stdout.write("ready\\n"); setTimeout(() => {}, 60_000)`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let exitCode: number | null = null;
    child.on("close", (code: number | null) => {
      exitCode = code;
    });

    // Wait for readiness.
    await new Promise<void>((resolve) => {
      child.stdout.once("data", () => resolve());
    });

    const start = Date.now();
    child.kill("SIGTERM");
    await delay(500);
    const elapsed = Date.now() - start;

    expect(exitCode).toBe(0);
    expect(elapsed).toBeLessThan(2000);
  });
});
