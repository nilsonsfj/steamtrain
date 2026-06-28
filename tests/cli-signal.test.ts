import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { type ProcessLine, runProcessLines } from "../src/agents/spawn";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function drain(gen: AsyncGenerator<ProcessLine>): Promise<ProcessLine[]> {
  const lines: ProcessLine[] = [];
  for await (const item of gen) lines.push(item);
  return lines;
}

/**
 * Mirrors the CLI's interrupt handler pattern from src/cli.ts:
 *   - First interrupt: abort the AbortController (graceful cancel)
 *   - Second interrupt: request force exit
 */
function createInterruptHandler() {
  const ac = new AbortController();
  let interrupts = 0;
  let forceExit = false;

  const onSigint = (): void => {
    interrupts += 1;
    if (interrupts === 1) ac.abort();
    else forceExit = true;
  };

  return {
    controller: ac,
    onSigint,
    get interrupts() {
      return interrupts;
    },
    get forceExit() {
      return forceExit;
    },
  };
}

describe("CLI interrupt handler pattern", () => {
  it("aborts the controller on the first interrupt", () => {
    const handler = createInterruptHandler();
    expect(handler.controller.signal.aborted).toBe(false);

    handler.onSigint(); // simulate first Ctrl+C

    expect(handler.controller.signal.aborted).toBe(true);
    expect(handler.interrupts).toBe(1);
    expect(handler.forceExit).toBe(false);
  });

  it("sets forceExit on the second interrupt", () => {
    const handler = createInterruptHandler();

    handler.onSigint(); // first Ctrl+C
    expect(handler.forceExit).toBe(false);

    handler.onSigint(); // second Ctrl+C
    expect(handler.forceExit).toBe(true);
    expect(handler.interrupts).toBe(2);
  });

  it("an aborted signal propagates to a consuming generator", async () => {
    const handler = createInterruptHandler();

    async function* generator(signal: AbortSignal) {
      for (let i = 0; i < 100; i++) {
        if (signal.aborted) return;
        yield i;
      }
    }

    const items: number[] = [];
    for await (const item of generator(handler.controller.signal)) {
      items.push(item);
      if (item === 3) handler.onSigint(); // abort mid-stream
    }

    expect(items).toContain(3);
    expect(items.length).toBeLessThan(100);
  });

  it("an aborted signal kills a real child process via runProcessLines", async () => {
    // Full CLI signal chain:
    //   SIGINT → onSigint() → ac.abort() → signal propagates →
    //   startKill() → resolveCleanup() → generator wakes up → finally runs
    const handler = createInterruptHandler();
    const gen = runProcessLines({
      binary: "node",
      args: ["-e", "setTimeout(() => {}, 60_000)"],
      signal: handler.controller.signal,
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
    handler.onSigint(); // simulate Ctrl+C
    await consumer;

    expect(exit).toBeDefined();
    expect((exit as Extract<ProcessLine, { kind: "exit" }>).code).not.toBe(0);
  });

  it("second interrupt after abort sets forceExit", () => {
    const handler = createInterruptHandler();

    handler.onSigint(); // abort
    expect(handler.controller.signal.aborted).toBe(true);
    expect(handler.forceExit).toBe(false);

    handler.onSigint(); // force exit
    expect(handler.forceExit).toBe(true);
  });
});

describe("CLI signal integration", () => {
  it("a child process exits when sent SIGINT", async () => {
    const child = spawn("node", ["-e", "setTimeout(() => {}, 60_000)"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let exited = false;
    let exitSignal: string | null = null;

    child.on("close", (_code: number | null, signal: string | null) => {
      exited = true;
      exitSignal = signal;
    });

    await delay(50);
    child.kill("SIGINT");
    await delay(200);

    expect(exited).toBe(true);
    expect(exitSignal).toBe("SIGINT");
  });

  it("a SIGTERM-immune child is killed by the full kill chain", async () => {
    // Tests the runProcessLines kill chain: SIGTERM → grace → SIGKILL.
    const gen = runProcessLines({
      binary: "node",
      args: ["-e", `process.on("SIGTERM", () => {}); setTimeout(() => {}, 60_000)`],
      signal: AbortSignal.timeout(100),
    });

    const lines = await drain(gen);
    const exit = lines.find((l) => l.kind === "exit") as Extract<ProcessLine, { kind: "exit" }>;

    expect(exit).toBeDefined();
    expect(exit.signal).toBe("SIGKILL");
  }, 10_000);

  it("a child that handles SIGTERM exits cleanly before SIGKILL", async () => {
    const gen = runProcessLines({
      binary: "node",
      args: ["-e", `process.on("SIGTERM", () => process.exit(0)); setTimeout(() => {}, 60_000)`],
      signal: AbortSignal.timeout(50),
    });

    const start = Date.now();
    const lines = await drain(gen);
    const elapsed = Date.now() - start;
    const exit = lines.find((l) => l.kind === "exit") as Extract<ProcessLine, { kind: "exit" }>;

    expect(exit).toBeDefined();
    expect(elapsed).toBeLessThan(2000);
  });
});
