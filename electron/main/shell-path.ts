import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * PATH recovery for a GUI-launched app.
 *
 * A macOS app opened from Finder (or a Linux app from a desktop launcher)
 * inherits a minimal PATH — roughly `/usr/bin:/bin:/usr/sbin:/sbin` — not the
 * one the user's shell builds. steamtrain resolves every agent CLI by scanning
 * `process.env.PATH` (`src/doctor/doctor.ts`) and spawns bare `git`, so without
 * this the app reports every agent as missing on a machine where the CLI works.
 *
 * The fix is to ask the user's login shell what its PATH is, once, before the
 * engine is forked. Everything here is deliberately outside `src/` so the CLI
 * and TUI keep their unmodified behavior.
 */

/** Directories worth trying when the login shell can't be consulted. */
const FALLBACK_DIRS = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
];

/** Home-relative directories common to per-user toolchain installs. */
const FALLBACK_HOME_DIRS = [".local/bin", ".bun/bin", ".cargo/bin", ".deno/bin", "bin"];

/** How long the login shell gets before we give up and use the fallback. */
const SHELL_TIMEOUT_MS = 5_000;

/**
 * Extract `PATH` from `env`-style `KEY=value` output.
 *
 * Values may themselves contain `=`, so only the first delimiter splits. Later
 * assignments win, matching how a shell would have applied them.
 */
export function parsePathFromEnvOutput(output: string): string | undefined {
  let found: string | undefined;
  for (const line of output.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    if (line.slice(0, eq) !== "PATH") continue;
    const value = line.slice(eq + 1).trim();
    if (value) found = value;
  }
  return found;
}

/**
 * Merge `additions` into `base`, preserving `base`'s order and dropping
 * duplicates and empty segments.
 */
export function mergePath(base: string | undefined, additions: readonly string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of [...(base ?? "").split(delimiter), ...additions]) {
    const trimmed = dir.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.join(delimiter);
}

/**
 * Directories to append when the login shell is unavailable: the well-known
 * toolchain locations that actually exist on this machine, plus every installed
 * nvm node version's `bin`.
 */
export function fallbackPathDirs(home: string = homedir()): string[] {
  const candidates = [...FALLBACK_DIRS, ...FALLBACK_HOME_DIRS.map((dir) => join(home, dir))];
  const nvmVersions = join(home, ".nvm", "versions", "node");
  try {
    for (const entry of readdirSync(nvmVersions)) {
      candidates.push(join(nvmVersions, entry, "bin"));
    }
  } catch {
    // No nvm install — nothing to add.
  }
  return candidates.filter((dir) => existsSync(dir));
}

/**
 * True when the process already has a usable PATH and consulting a shell would
 * be pointless: on Windows (no login-shell convention this trick relies on),
 * and when launched from a terminal, where the PATH is already the user's.
 */
export function shouldSkipShellPath(env: NodeJS.ProcessEnv = process.env): boolean {
  return process.platform === "win32" || Boolean(env.TERM);
}

/**
 * Ask the user's login shell for its PATH.
 *
 * Uses `command -p env` rather than `echo $PATH` so the dump is a plain
 * `KEY=value` list regardless of shell, and `-ilc` so interactive-only rc files
 * (where PATH is very often set) are sourced. A shell that hangs — a slow rc
 * file, or one that prompts — must not hang app start, so the child gets a
 * timeout and is killed by process group.
 */
async function readLoginShellPath(shell: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, ["-ilc", "command -p env"], {
        // Own process group, so the timeout kill reaches anything the rc files
        // started rather than just the shell itself.
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve(undefined);
      return;
    }

    const timer = setTimeout(() => {
      try {
        if (typeof child.pid === "number") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      finish(undefined);
    }, SHELL_TIMEOUT_MS);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => finish(undefined));
    child.on("close", (code) => finish(code === 0 ? parsePathFromEnvOutput(stdout) : undefined));
  });
}

export interface ResolvedShellPath {
  path: string;
  source: "inherited" | "login-shell" | "fallback";
}

/**
 * Resolve the PATH the engine should run with, and apply it to this process.
 *
 * Never throws and never blocks longer than {@link SHELL_TIMEOUT_MS}: a failure
 * to consult the shell degrades to the fallback directory scan, which is still
 * far better than the bare GUI PATH.
 */
export async function resolveShellPath(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedShellPath> {
  if (shouldSkipShellPath(env)) {
    return { path: env.PATH ?? "", source: "inherited" };
  }
  const shell = env.SHELL;
  if (shell) {
    const shellPath = await readLoginShellPath(shell);
    if (shellPath) {
      // Union rather than replace: the inherited entries are few and harmless,
      // and keeping them means a shell that drops a system dir can't break us.
      return {
        path: mergePath(shellPath, (env.PATH ?? "").split(delimiter)),
        source: "login-shell",
      };
    }
  }
  return { path: mergePath(env.PATH, fallbackPathDirs()), source: "fallback" };
}
