import { spawn } from "node:child_process";
import { childEnv } from "../util/child-env";

/**
 * Subprocess plumbing for `command` workflow steps: run one shell command,
 * stream its combined stdout+stderr, and report how it ended. Kept separate
 * from the engine so the spawn/timeout/abort mechanics are testable on their
 * own.
 */

/**
 * Cap on captured command output. Agent steps are naturally bounded by model
 * context; a command (`npm test` in a loop, a verbose build) is not, and the
 * output is persisted into run history and re-rendered into downstream
 * prompts. When exceeded, the HEAD of the output is dropped — diagnostics
 * (test failures, error summaries) conventionally print last.
 */
export const MAX_COMMAND_OUTPUT_BYTES = 512 * 1024;

export interface RunShellCommandOptions {
  cwd: string;
  /** Extra env vars merged over `process.env`. */
  env?: Record<string, string>;
  /** Wall-clock limit; the process group gets SIGTERM, then SIGKILL. */
  timeoutMs?: number;
  /** Grace between SIGTERM and the SIGKILL escalation (default 5s). */
  killGraceMs?: number;
  signal?: AbortSignal;
  /** Called with each raw chunk (stdout and stderr interleaved) for live streaming. */
  onChunk?: (text: string) => void;
}

export interface ShellCommandResult {
  /** Exit code; undefined when the process was killed by a signal. */
  exitCode?: number;
  /** Combined stdout+stderr in arrival order, tail-truncated at the cap. */
  output: string;
  /** True when the output cap dropped earlier chunks. */
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  /** Spawn-level failure (command interpreter missing etc.), if any. */
  spawnError?: string;
}

/**
 * Run `cmd` through the platform shell (`sh -c` / `cmd.exe /c` via the node
 * `shell` option), capturing stdout and stderr interleaved. Never rejects —
 * every way the command can end is reported in the result.
 */
export async function runShellCommand(
  cmd: string,
  opts: RunShellCommandOptions,
): Promise<ShellCommandResult> {
  if (opts.signal?.aborted) {
    return { output: "", truncated: false, timedOut: false, cancelled: true };
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bufferedBytes = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let spawnError: string | undefined;

    // detached puts the command in its own process group so kills reach the
    // whole tree (`npm test` spawning node spawning workers), not just the shell.
    const child = spawn(cmd, {
      shell: true,
      cwd: opts.cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      // Always build the env explicitly (rather than inheriting by omission) so
      // ELECTRON_RUN_AS_NODE never reaches a user's command under the desktop
      // app. `$STEAMTRAIN_CLI` re-adds it inline for its own invocation.
      env: childEnv(opts.env),
    });

    const killTree = (sig: NodeJS.Signals): void => {
      try {
        if (process.platform !== "win32" && typeof child.pid === "number") {
          process.kill(-child.pid, sig);
        } else {
          child.kill(sig);
        }
      } catch {
        // already gone
      }
    };

    // Timeout and abort both terminate the same way: SIGTERM, then SIGKILL
    // after a grace period — a command that traps SIGTERM (dev servers, test
    // runners) must not outlive a cancellation and hold its worktree lease.
    let killTimer: NodeJS.Timeout | undefined;
    const terminate = (): void => {
      killTree("SIGTERM");
      killTimer ??= setTimeout(() => killTree("SIGKILL"), opts.killGraceMs ?? 5000);
      killTimer.unref();
    };

    const timer =
      opts.timeoutMs !== undefined && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            terminate();
          }, opts.timeoutMs)
        : undefined;

    const onAbort = (): void => {
      cancelled = true;
      terminate();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const capture = (chunk: Buffer): void => {
      opts.onChunk?.(chunk.toString("utf8"));
      chunks.push(chunk);
      bufferedBytes += chunk.length;
      // Tail truncation: drop whole chunks from the head once over the cap.
      while (bufferedBytes > MAX_COMMAND_OUTPUT_BYTES && chunks.length > 1) {
        const dropped = chunks.shift() as Buffer;
        bufferedBytes -= dropped.length;
        truncated = true;
      }
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    const finish = (exitCode: number | undefined): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // Clear the pending SIGKILL escalation so it can't fire after the
      // process already exited (PID/PGID-reuse window).
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      let output = Buffer.concat(chunks).toString("utf8");
      if (output.length > MAX_COMMAND_OUTPUT_BYTES) {
        // A single chunk can exceed the cap; trim characters as a final guard.
        output = output.slice(output.length - MAX_COMMAND_OUTPUT_BYTES);
        truncated = true;
      }
      if (truncated) {
        output = `[output truncated to last ${Math.round(MAX_COMMAND_OUTPUT_BYTES / 1024)} KiB]\n${output}`;
      }
      resolve({ exitCode, output, truncated, timedOut, cancelled, spawnError });
    };

    child.on("error", (err) => {
      spawnError = err instanceof Error ? err.message : String(err);
      finish(undefined);
    });
    child.on("close", (code) => finish(code ?? undefined));
  });
}
