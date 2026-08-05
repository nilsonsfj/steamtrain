import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { childEnv } from "../util/child-env";
import { LineBuffer } from "./line-buffer";

type PipedChild = ChildProcessByStdio<null, Readable, Readable>;
type PipedChildWithStdin = ChildProcessByStdio<Writable, Readable, Readable>;

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
  /** Prompt text to write to stdin and close. When provided, stdin is piped instead of ignored. */
  prompt?: string;
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
 *  - env is `{...process.env}` (see `childEnv`); cwd is configurable.
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

  let child: PipedChild | PipedChildWithStdin;
  try {
    const useStdin = typeof opts.prompt === "string";
    child = spawn(opts.binary, opts.args, {
      stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"],
      env: childEnv(opts.env),
      cwd: opts.cwd,
    }) as PipedChild | PipedChildWithStdin;
    if (useStdin && child.stdin) {
      child.stdin.write(opts.prompt);
      child.stdin.end();
    }
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
    const { cancel } = killProcess(child);
    cancelKill = cancel;
    // Wake the generator if it's blocked on waitForItem(), so it can
    // check the `killed` flag and exit instead of re-blocking.
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
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
      // Latch settled before any yield so a concurrent OS `close` → settle()
      // cannot also push a second exit (exactly one exit per process).
      if (killed && !settled) {
        settled = true;
        // Kill was initiated (timeout or AbortSignal). Surface an exit summary
        // immediately so adapters can mark the step failed — do NOT wait for
        // the OS `close` event, which can hang on stubborn children. Without
        // this exit event, runAgentProcess never emits a timeout error and
        // agent steps that hit stepTimeoutSec are wrongly recorded as ok:true.
        const remainder = outBuffer.flush();
        if (remainder && remainder.length > 0) yield { kind: "line", line: remainder };
        yield {
          kind: "exit",
          code: null,
          signal: "SIGTERM",
          timedOut,
          stderr: stderrAll,
          sawStdout,
          spawnError,
        };
        return;
      }
      if (killed) return;
      await waitForItem();
    }
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    if (!settled) startKill();
    cancelKill?.();
  }
}

function killProcess(child: PipedChild | PipedChildWithStdin): { cancel: () => void } {
  let killed = false;
  try {
    child.kill("SIGTERM");
  } catch {
    // already gone
  }
  const sigkillTimer = setTimeout(() => {
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
