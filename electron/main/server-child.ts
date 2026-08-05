import { type ChildProcess, spawn } from "node:child_process";

/**
 * The steamtrain engine as a child process.
 *
 * The desktop app does not embed the web server; it forks the real CLI entry
 * (`dist/index.js --web-ui`) and points a window at the port it reports. Two
 * reasons this is worth an extra process:
 *
 *  - `WorkflowRunManager` has no teardown path, and the live-run store's poll
 *    timer is deliberately not `unref`'d, so an embedded server could not be
 *    stopped without leaking watchers and timers into the GUI process.
 *  - The child is a genuine Node process whose `process.argv[1]` is the entry
 *    script, so re-exec (`workflow/handoff.ts`) and `import.meta.url`-relative
 *    asset loading (`src/web/server.ts`) work with no changes.
 *
 * `ELECTRON_RUN_AS_NODE=1` is what makes the Electron binary usable as that
 * Node runtime, and it propagates to the detached runner for free.
 */

/** Seconds to wait for the server to report itself listening before giving up. */
const READY_TIMEOUT_MS = 30_000;

/** How much stderr to keep for the crash report. */
const STDERR_TAIL_LINES = 40;

export interface ServerReady {
  steamtrain: "ready";
  url: string;
  port: number;
  pid: number;
}

/**
 * Recognize the `--desktop-ready-json` handshake line.
 *
 * The server also prints a human banner, a project line and asynchronous doctor
 * progress, so the reader must ignore everything that isn't this exact shape
 * rather than assuming the first line it sees is the answer.
 */
export function parseReadyLine(line: string): ServerReady | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as ServerReady).steamtrain === "ready" &&
      typeof (parsed as ServerReady).url === "string" &&
      typeof (parsed as ServerReady).port === "number"
    ) {
      return parsed as ServerReady;
    }
  } catch {
    // Not JSON — ordinary banner output.
  }
  return undefined;
}

export interface StartServerOptions {
  /** Absolute path to the built CLI entry (`dist/index.js`). */
  entry: string;
  /** Project directory the engine operates on. */
  cwd: string;
  /** PATH-corrected environment (see `shell-path.ts`). */
  env: NodeJS.ProcessEnv;
  /** Where to forward the child's non-handshake output. */
  log?: (line: string) => void;
}

export interface ServerHandle {
  ready: ServerReady;
  child: ChildProcess;
  /** Most recent stderr, for the crash page. */
  stderrTail(): string;
  /** Has the child already exited? */
  exited(): boolean;
  /** Register a callback for unexpected exit. */
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  /** SIGTERM, escalating to SIGKILL. Safe to call more than once. */
  stop(): Promise<void>;
}

/**
 * Fork the engine and resolve once it reports a bound address.
 *
 * Rejects (after killing the child) if the handshake never arrives, so a hung
 * boot surfaces as an error dialog rather than an empty window.
 */
export async function startServer(options: StartServerOptions): Promise<ServerHandle> {
  const { entry, cwd, env, log = () => {} } = options;

  const child = spawn(
    process.execPath,
    [
      entry,
      "--web-ui",
      "--host",
      "127.0.0.1",
      // Port 0 lets the OS pick; the handshake reports what we actually got.
      "--port",
      "0",
      "--project-dir",
      cwd,
      "--desktop-ready-json",
    ],
    {
      cwd,
      env: {
        ...env,
        // Run the Electron binary as plain Node.
        ELECTRON_RUN_AS_NODE: "1",
        // Lets the engine tailor diagnostics to a GUI host.
        STEAMTRAIN_DESKTOP: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const stderrLines: string[] = [];
  let exitedWith: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const exitCallbacks: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];

  child.on("exit", (code, signal) => {
    exitedWith = { code, signal };
    for (const cb of exitCallbacks) cb(code, signal);
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      stderrLines.push(line);
      if (stderrLines.length > STDERR_TAIL_LINES) stderrLines.shift();
      log(`[engine] ${line}`);
    }
  });

  const ready = await new Promise<ServerReady>((resolve, reject) => {
    let settled = false;
    let buffer = "";

    const finish = (err: Error | undefined, value?: ServerReady): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value as ServerReady);
    };

    const timer = setTimeout(() => {
      finish(new Error(`the steamtrain engine did not start within ${READY_TIMEOUT_MS / 1000}s`));
    }, READY_TIMEOUT_MS);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      // Keep the trailing partial line in the buffer for the next chunk.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseReadyLine(line);
        if (parsed) {
          finish(undefined, parsed);
          continue;
        }
        if (line.trim()) log(`[engine] ${line}`);
      }
    });

    child.on("error", (err) => finish(err));
    child.on("exit", (code, signal) => {
      finish(
        new Error(
          `the steamtrain engine exited before it was ready (${signal ?? `code ${code}`})\n${stderrLines.join("\n")}`,
        ),
      );
    });
  }).catch((err: Error) => {
    if (!exitedWith) child.kill("SIGKILL");
    throw err;
  });

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    stopping = new Promise<void>((resolve) => {
      if (exitedWith) {
        resolve();
        return;
      }
      // Signalling can throw (EPERM, or a child that died between the check and
      // the call). This promise gates app shutdown, so it must always settle —
      // a rejection here would leave the app unable to quit.
      const signal = (sig: NodeJS.Signals): void => {
        try {
          child.kill(sig);
        } catch {
          resolve();
        }
      };
      // The engine already handles SIGTERM by closing the server and its live
      // sockets, so this is the graceful path; SIGKILL is only the backstop.
      const kill = setTimeout(() => signal("SIGKILL"), 5_000);
      kill.unref?.();
      child.once("exit", () => {
        clearTimeout(kill);
        resolve();
      });
      signal("SIGTERM");
    });
    return stopping;
  };

  return {
    ready,
    child,
    stderrTail: () => stderrLines.join("\n"),
    exited: () => exitedWith !== undefined,
    onExit: (cb) => {
      if (exitedWith) cb(exitedWith.code, exitedWith.signal);
      else exitCallbacks.push(cb);
    },
    stop,
  };
}
