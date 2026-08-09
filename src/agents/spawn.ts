import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { appendCapped } from "../util/capped-buffer";
import { childEnv } from "../util/child-env";
import { LineBuffer } from "./line-buffer";

type PipedChild = ChildProcessByStdio<null, Readable, Readable>;
type PipedChildWithStdin = ChildProcessByStdio<Writable, Readable, Readable>;

/** Cap on accumulated agent stderr kept for the exit summary (tail-truncated). */
export const MAX_AGENT_STDERR_BYTES = 512 * 1024;

/**
 * Default "no stdout/stderr for N ms" kill when a wall-clock `timeoutMs` is
 * set and the caller did not pass `idleTimeoutMs`. Long enough to tolerate
 * quiet tool runs; short enough to beat a full 15m step timeout on a hung CLI.
 * Pass `idleTimeoutMs: 0` to disable.
 */
export const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export interface ProcessRunOptions {
  binary: string;
  args: string[];
  cwd?: string;
  /** Extra env vars merged over `process.env`. */
  env?: Record<string, string>;
  /** Kill the process if it runs longer than this (ms). 0/undefined = no limit. */
  timeoutMs?: number;
  /**
   * Kill the process if no stdout/stderr arrives for this long (ms).
   * `undefined` → {@link DEFAULT_AGENT_IDLE_TIMEOUT_MS} when `timeoutMs` is set
   * (capped by `timeoutMs`). `0` disables idle detection.
   */
  idleTimeoutMs?: number;
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
      /** True when the kill was triggered by idle (no output), not wall-clock. */
      idleTimedOut?: boolean;
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
 *  - stdio is `['ignore'|'pipe','pipe','pipe']` — we never inherit a TTY.
 *  - env is `{...process.env}` (see `childEnv`); cwd is configurable.
 *  - stdout is reassembled into whole lines across chunk boundaries.
 *  - on Unix the child is detached into its own process group so kills reach
 *    helpers the CLI forks (mirrors `workflow/command.ts`).
 *  - a timeout, idle timeout, or aborted signal kills the process group
 *    (SIGTERM, then SIGKILL). Synthetic early-exit for adapters does NOT
 *    cancel the pending SIGKILL — a SIGTERM-immune agent must not keep
 *    writing the worktree after the step is already marked failed.
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
      // Own process group on Unix so SIGTERM/SIGKILL reach helpers the agent
      // CLI forks (same pattern as command steps and doctor --version probes).
      detached: process.platform !== "win32",
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
  let idleTimedOut = false;
  let spawnError: string | undefined;
  let settled = false;
  /** True once the OS delivered `close`/`error` — only then is canceling SIGKILL safe. */
  let processExited = false;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const noteActivity = (): void => {
    resetIdleTimer();
  };

  child.stdout.on("data", (chunk: string) => {
    noteActivity();
    if (chunk.length > 0) sawStdout = true;
    for (const line of outBuffer.push(chunk)) {
      if (line.length > 0) push({ kind: "line", line });
    }
  });

  child.stderr.on("data", (chunk: string) => {
    noteActivity();
    stderrAll = appendCapped(stderrAll, chunk, MAX_AGENT_STDERR_BYTES);
    push({ kind: "stderr", text: chunk });
  });

  const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
    processExited = true;
    // Process is gone — drop the pending SIGKILL so a recycled PID/PGID is safe.
    cancelKill?.();
    if (settled) {
      // Synthetic exit already yielded; still wake the generator if it is
      // blocked so `finished` can end the loop.
      finished = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r();
      }
      return;
    }
    settled = true;
    const remainder = outBuffer.flush();
    if (remainder && remainder.length > 0) push({ kind: "line", line: remainder });
    push({
      kind: "exit",
      code,
      signal,
      timedOut,
      idleTimedOut: idleTimedOut || undefined,
      stderr: stderrAll,
      sawStdout,
      spawnError,
    });
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
    stderrAll = appendCapped(stderrAll, `${spawnError}\n`, MAX_AGENT_STDERR_BYTES);
    settle(null, null);
  });
  child.on("close", (code, signal) => settle(code, signal));

  let timer: NodeJS.Timeout | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let cancelKill: (() => void) | undefined;
  let killed = false;

  const startKill = (): void => {
    if (killed) return;
    killed = true;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    // Keep the SIGKILL timer referenced so a synthetic early-exit cannot let
    // the event loop drain before escalation fires on a stubborn child.
    const { cancel } = killProcessTree(child, { keepAlive: true });
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

  const resolvedIdleMs = resolveIdleTimeoutMs(opts);
  const armIdleTimer = (): void => {
    if (resolvedIdleMs === undefined || killed || processExited) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      idleTimedOut = true;
      startKill();
    }, resolvedIdleMs);
    idleTimer.unref?.();
  };
  const resetIdleTimer = (): void => {
    armIdleTimer();
  };
  armIdleTimer();

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
        // Kill was initiated (timeout, idle, or AbortSignal). Surface an exit
        // summary immediately so adapters can mark the step failed — do NOT
        // wait for the OS `close` event, which can hang on stubborn children.
        // The pending SIGKILL stays armed until `close` (see finally).
        const remainder = outBuffer.flush();
        if (remainder && remainder.length > 0) yield { kind: "line", line: remainder };
        yield {
          kind: "exit",
          code: null,
          signal: "SIGTERM",
          timedOut,
          idleTimedOut: idleTimedOut || undefined,
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
    if (idleTimer) clearTimeout(idleTimer);
    opts.signal?.removeEventListener("abort", onAbort);
    if (!settled && !killed) startKill();
    // Only cancel SIGKILL once the OS confirms the process is gone. Canceling
    // after a synthetic exit left SIGTERM-immune agents writing the worktree.
    if (processExited) cancelKill?.();
  }
}

function resolveIdleTimeoutMs(opts: {
  timeoutMs?: number;
  idleTimeoutMs?: number;
}): number | undefined {
  if (opts.idleTimeoutMs === 0) return undefined;
  if (opts.idleTimeoutMs !== undefined && opts.idleTimeoutMs > 0) return opts.idleTimeoutMs;
  if (!opts.timeoutMs || opts.timeoutMs <= 0) return undefined;
  return Math.min(DEFAULT_AGENT_IDLE_TIMEOUT_MS, opts.timeoutMs);
}

/** Resolve idle timeout for callers that need to echo it in error messages. */
export function resolveAgentIdleTimeoutMs(opts: {
  timeoutMs?: number;
  idleTimeoutMs?: number;
}): number | undefined {
  return resolveIdleTimeoutMs(opts);
}

function killProcessTree(
  child: PipedChild | PipedChildWithStdin,
  opts?: { keepAlive?: boolean },
): { cancel: () => void } {
  let cancelled = false;
  killTree(child, "SIGTERM");
  const sigkillTimer = setTimeout(() => {
    if (cancelled) return;
    killTree(child, "SIGKILL");
  }, SIGKILL_GRACE_MS);
  // Ref the timer when the caller has already returned a synthetic exit and
  // needs escalation to finish even if nothing else keeps the loop alive.
  if (!opts?.keepAlive) sigkillTimer.unref?.();
  return {
    cancel() {
      if (cancelled) return;
      cancelled = true;
      clearTimeout(sigkillTimer);
    },
  };
}

function killTree(child: PipedChild | PipedChildWithStdin, sig: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && typeof child.pid === "number") {
      try {
        // Negative PID = process group (requires detached spawn above).
        process.kill(-child.pid, sig);
        return;
      } catch {
        // Not a group leader / already gone — fall through to direct kill.
      }
    }
    child.kill(sig);
  } catch {
    // already gone
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
