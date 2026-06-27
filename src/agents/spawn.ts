import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { LineBuffer } from "./line-buffer";

type PipedChild = ChildProcessByStdio<null, Readable, Readable>;

export interface ProcessRunOptions {
  binary: string;
  args: string[];
  cwd?: string;
  /** Extra env vars merged over `process.env`. */
  env?: Record<string, string>;
  /** Kill the process if it runs longer than this (ms). 0/undefined = no limit. */
  timeoutMs?: number;
  /** External cancellation. Aborting kills the process. */
  signal?: AbortSignal;
}

export type ProcessLine =
  | { kind: "line"; line: string }
  | { kind: "stderr"; text: string }
  | {
      kind: "exit";
      code: number | null;
      signal: NodeJS.Signals | null;
      timedOut: boolean;
      stderr: string;
      sawStdout: boolean;
      spawnError?: string;
    };

const SIGKILL_GRACE_MS = 2000;

/**
 * Spawns a child process and yields its stdout as complete NDJSON lines, plus
 * stderr chunks and a final `exit` summary.
 *
 * Contract enforced here for every agent:
 *  - stdio is `['ignore','pipe','pipe']` — we never inherit a TTY.
 *  - env is `{...process.env}`; cwd is configurable.
 *  - stdout is reassembled into whole lines across chunk boundaries.
 *  - a timeout (or aborted signal) kills the process (SIGTERM, then SIGKILL).
 */
export async function* runProcessLines(opts: ProcessRunOptions): AsyncGenerator<ProcessLine> {
  const queue: ProcessLine[] = [];
  let resolveNext: (() => void) | null = null;
  let finished = false;

  const push = (item: ProcessLine): void => {
    queue.push(item);
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  };
  const waitForItem = (): Promise<void> =>
    new Promise((resolve) => {
      resolveNext = resolve;
    });

  let child: PipedChild;
  try {
    child = spawn(opts.binary, opts.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
      cwd: opts.cwd,
    });
  } catch (err) {
    // Synchronous spawn failure (rare; usually surfaces via the 'error' event).
    yield {
      kind: "exit",
      code: null,
      signal: null,
      timedOut: false,
      stderr: "",
      sawStdout: false,
      spawnError: errorMessage(err),
    };
    return;
  }

  const outBuffer = new LineBuffer();
  let sawStdout = false;
  let stderrAll = "";
  let timedOut = false;
  let spawnError: string | undefined;
  let settled = false;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk: string) => {
    if (chunk.length > 0) sawStdout = true;
    for (const line of outBuffer.push(chunk)) {
      if (line.length > 0) push({ kind: "line", line });
    }
  });

  child.stderr.on("data", (chunk: string) => {
    stderrAll += chunk;
    push({ kind: "stderr", text: chunk });
  });

  const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (settled) return;
    settled = true;
    const remainder = outBuffer.flush();
    if (remainder && remainder.length > 0) push({ kind: "line", line: remainder });
    push({ kind: "exit", code, signal, timedOut, stderr: stderrAll, sawStdout, spawnError });
    finished = true;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  };

  child.on("error", (err) => {
    // e.g. ENOENT when the binary vanished between resolution and spawn.
    spawnError = errorMessage(err);
    stderrAll += `${spawnError}\n`;
    settle(null, null);
  });
  child.on("close", (code, signal) => settle(code, signal));

  let timer: NodeJS.Timeout | undefined;
  let cancelKill: (() => void) | undefined;
  let killed = false;

  const startKill = (): void => {
    if (killed) return;
    killed = true;
    cancelKill?.();
    const { cancel } = killProcess(child);
    cancelKill = cancel;
  };

  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      startKill();
    }, opts.timeoutMs);
    timer.unref?.();
  }

  const onAbort = (): void => startKill();
  if (opts.signal) {
    if (opts.signal.aborted) startKill();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    while (true) {
      while (queue.length > 0) {
        const item = queue.shift() as ProcessLine;
        yield item;
        if (item.kind === "exit") return;
      }
      if (finished) return;
      await waitForItem();
    }
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    if (!settled) startKill();
    cancelKill?.();
  }
}

function killProcess(child: PipedChild): { cancel: () => void } {
  let killed = false;
  let sigkillTimer: NodeJS.Timeout | undefined;
  try {
    child.kill("SIGTERM");
  } catch {
    // already gone
  }
  sigkillTimer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }, SIGKILL_GRACE_MS);
  sigkillTimer.unref?.();
  return {
    cancel() {
      if (!killed) {
        killed = true;
        if (sigkillTimer) clearTimeout(sigkillTimer);
      }
    },
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
