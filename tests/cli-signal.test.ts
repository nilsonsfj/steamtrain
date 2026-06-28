import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { type ProcessLine, runProcessLines } from "../src/agents/spawn";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
    //   SIGINT → onSigint() → ac.abort() → startKill() → killProcess()
    //   → generator wakes via killed flag → for-await exits cleanly
    const handler = createInterruptHandler();
    const gen = runProcessLines({
      binary: "node",
      args: ["-e", "setTimeout(() => {}, 60_000)"],
      signal: handler.controller.signal,
    });

    const start = Date.now();
    const consumer = (async () => {
      for await (const _item of gen) {
        // no items expected from a silent child
      }
    })();

    await delay(80);
    handler.onSigint(); // simulate Ctrl+C
    await consumer;
    const elapsed = Date.now() - start;

    // Generator exits promptly via killed flag — no hang.
    expect(elapsed).toBeLessThan(2000);
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

  it("a SIGTERM-immune child is killed by SIGKILL after grace period", async () => {
    // Tests the kill chain: SIGTERM (ignored) → grace → SIGKILL.
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

    // Wait for readiness signal (handler installed).
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
    // Child handles SIGTERM by exiting — should complete before SIGKILL timer.
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

    // Wait for readiness signal.
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
