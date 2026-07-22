import { type ChildProcess, spawn } from "node:child_process";
import { constants, access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { DEFAULT_AGENT_BINARY, resolveAgentInstances } from "../agents/config";
import { firstLine } from "../agents/util";
import type { SteamtrainConfig } from "../config/types";
import type { AgentInstanceId, AgentProviderId } from "../types/events";

export type DoctorStatus = "ok" | "binary_missing" | "not_authenticated" | "unknown_error";

export interface DoctorResult {
  agent: AgentInstanceId;
  provider: AgentProviderId;
  label?: string;
  status: DoctorStatus;
  binary: string;
  binaryPath?: string;
  version?: string;
  /** Short status line for the panel. */
  message: string;
  /** Actionable fix-it hint when not ok. */
  detail?: string;
  /**
   * The single shell command that resolves `detail`, ready for a one-click
   * copy in the UIs (install command, or the CLI's login command). Kept as
   * structured data rather than scraped from `detail`'s prose so both the TUI
   * and the web setup panel can offer a reliable "copy the fix" button.
   */
  fixCommand?: string;
}

const VERSION_TIMEOUT_MS = 8000;
const AUTH_PATTERN =
  /not logged in|unauthor|authenticat|please run.*login|login required|no api key|api key not|set .*_api_key/i;

/**
 * In-flight `--version` probes. Agent CLIs (especially Bun-based ones like
 * `amp`) can burn a full core while starting; if steamtrain exits mid-probe
 * without reaping them, they are reparented to PID 1 and keep spinning.
 */
const liveVersionChecks = new Set<ChildProcess>();
let exitHandlerInstalled = false;

function ensureExitHandler(): void {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  // `exit` is sync-only and fires for process.exit / natural shutdown / fatal
  // signals that terminate the process — the window where orphans otherwise leak.
  process.on("exit", () => {
    killDoctorVersionChecks();
  });
}

/** PIDs of in-flight doctor `--version` probes (test/diagnostics). */
export function doctorVersionCheckPids(): number[] {
  const pids: number[] = [];
  for (const child of liveVersionChecks) {
    if (typeof child.pid === "number") pids.push(child.pid);
  }
  return pids;
}

/** Reap every outstanding doctor `--version` child (and its process group). */
export function killDoctorVersionChecks(): void {
  for (const child of [...liveVersionChecks]) {
    killVersionChild(child);
  }
}

function killVersionChild(child: ChildProcess): void {
  try {
    if (process.platform !== "win32" && typeof child.pid === "number") {
      try {
        // Negative PID = process group. Matches workflow/command.ts so a CLI
        // that forks helpers during `--version` cannot outlive the probe.
        process.kill(-child.pid, "SIGKILL");
        return;
      } catch {
        // Not a group leader / already gone — fall through to direct kill.
      }
    }
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
}

/** Resolve a command to an absolute, executable path by scanning PATH. */
export async function resolveBinary(name: string): Promise<string | undefined> {
  if (name.includes("/") || isAbsolute(name)) {
    return (await isExecutable(name)) ? name : undefined;
  }
  const pathEnv = process.env.PATH ?? "";
  const exts =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

interface VersionRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runVersion(binaryPath: string, env?: Record<string, string>): Promise<VersionRun> {
  if (!binaryPath || !binaryPath.trim()) {
    return Promise.resolve({
      code: null,
      stdout: "",
      stderr: "empty binary path",
      timedOut: false,
    });
  }
  ensureExitHandler();
  return new Promise((resolve) => {
    // Own process group on Unix so timeout/exit kills reach any helpers the
    // CLI forks (amp is a Bun binary that can spin up workers during startup).
    const child = spawn(binaryPath, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
      detached: process.platform !== "win32",
    });
    liveVersionChecks.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const settle = (result: VersionRun): void => {
      if (settled) return;
      settled = true;
      liveVersionChecks.delete(child);
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      if (stdout.length < 10_000) stdout += c;
    });
    child.stderr?.on("data", (c: string) => {
      if (stderr.length < 10_000) stderr += c;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killVersionChild(child);
    }, VERSION_TIMEOUT_MS);
    // Do not unref: an unref'd timer is dropped on process.exit before the
    // `exit` handler runs in some runtimes, leaving the child unreaped. The
    // child handle already keeps the loop alive for the probe's lifetime.
    child.on("error", (err) => {
      settle({ code: null, stdout, stderr: `${stderr}${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      settle({ code, stdout, stderr, timedOut });
    });
  });
}
/** Check one agent: resolve its binary, run `--version`, classify readiness. */
export async function checkAgent(
  agent: AgentInstanceId,
  binary: string,
  options: { provider: AgentProviderId; label?: string; env?: Record<string, string> },
): Promise<DoctorResult> {
  const provider = options.provider;
  const binaryPath = await resolveBinary(binary);
  if (!binaryPath) {
    const fix = installHint(provider);
    return {
      agent,
      provider,
      label: options.label,
      status: "binary_missing",
      binary,
      message: `'${binary}' not found on PATH`,
      detail: fix.detail,
      fixCommand: fix.command,
    };
  }

  const run = await runVersion(binaryPath, options.env);
  if (run.timedOut) {
    return {
      agent,
      provider,
      label: options.label,
      status: "unknown_error",
      binary,
      binaryPath,
      message: `'${binary} --version' timed out`,
      detail: "The binary is on PATH but did not respond — check the install.",
    };
  }

  const combined = `${run.stdout}\n${run.stderr}`;
  if ((run.code ?? 1) === 0) {
    return {
      agent,
      provider,
      label: options.label,
      status: "ok",
      binary,
      binaryPath,
      version: firstLine(run.stdout) || firstLine(run.stderr) || "unknown",
      message: "ready",
    };
  }

  if (AUTH_PATTERN.test(combined)) {
    const fix = authHint(provider);
    return {
      agent,
      provider,
      label: options.label,
      status: "not_authenticated",
      binary,
      binaryPath,
      message: "not authenticated",
      detail: fix.detail,
      fixCommand: fix.command,
    };
  }

  return {
    agent,
    provider,
    label: options.label,
    status: "unknown_error",
    binary,
    binaryPath,
    message: `'${binary} --version' exited ${run.code}`,
    detail: firstLine(run.stderr) || "Run the command manually to see the error.",
  };
}

/** Run preflight for all agents (honoring config binary overrides). */
export function runDoctor(config: SteamtrainConfig): Promise<DoctorResult[]> {
  return Promise.all(
    resolveAgentInstances(config).map((agent) =>
      checkAgent(agent.id, agent.binary ?? DEFAULT_AGENT_BINARY[agent.provider], {
        provider: agent.provider,
        label: agent.label,
        env: agent.env,
      }),
    ),
  );
}

/** Prose fix plus the single shell command that resolves it (for one-click copy). */
interface FixHint {
  detail: string;
  command?: string;
}

function installHint(agent: AgentProviderId): FixHint {
  switch (agent) {
    case "claude":
      return {
        detail:
          "Install Claude Code (npm i -g @anthropic-ai/claude-code) and ensure `claude` is on PATH.",
        command: "npm i -g @anthropic-ai/claude-code",
      };
    case "opencode":
      return {
        detail:
          "Install OpenCode (brew install sst/tap/opencode, or npm i -g opencode-ai) and ensure `opencode` is on PATH.",
        command: "npm i -g opencode-ai",
      };
    case "codex":
      return {
        detail: "Install Codex (npm i -g @openai/codex) and ensure `codex` is on PATH.",
        command: "npm i -g @openai/codex",
      };
    case "amp":
      return {
        detail: "Install Amp (npm i -g @sourcegraph/amp) and ensure `amp` is on PATH.",
        command: "npm i -g @sourcegraph/amp",
      };
    case "kiro":
      return {
        detail:
          "Install Kiro CLI (curl -fsSL https://cli.kiro.dev/install | bash) and ensure `kiro-cli` is on PATH.",
        command: "curl -fsSL https://cli.kiro.dev/install | bash",
      };
    case "mimo":
      return {
        detail: "Install Mimo (npm i -g mimo-ai) and ensure `mimo` is on PATH.",
        command: "npm i -g mimo-ai",
      };
    case "cursor":
      return {
        detail:
          "Install Cursor Agent CLI (curl https://cursor.com/install -fsS | bash) and ensure `agent` is on PATH.",
        command: "curl https://cursor.com/install -fsS | bash",
      };
    case "antigravity":
      return {
        detail:
          "Install Antigravity CLI (curl -fsSL https://antigravity.google/cli/install.sh | bash) and ensure `agy` is on PATH.",
        command: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
      };
  }
}

function authHint(agent: AgentProviderId): FixHint {
  switch (agent) {
    case "claude":
      return {
        detail: "Run `claude` and `/login` (subscription) or set ANTHROPIC_API_KEY.",
        command: "claude",
      };
    case "opencode":
      return {
        detail: "Run `opencode auth login` for the provider you want to use.",
        command: "opencode auth login",
      };
    case "codex":
      return {
        detail: "Run `codex login` (ChatGPT) or set CODEX_API_KEY for `codex exec`.",
        command: "codex login",
      };
    case "amp":
      return {
        detail:
          "Run `amp login`, or set AMP_API_KEY for non-interactive use (execute mode needs paid credits).",
        command: "amp login",
      };
    case "kiro":
      return {
        detail: "Run `kiro-cli login`, or set KIRO_API_KEY for non-interactive use.",
        command: "kiro-cli login",
      };
    case "mimo":
      return {
        detail: "Run `mimo auth login` for the provider you want to use.",
        command: "mimo auth login",
      };
    case "cursor":
      return {
        detail: "Run `agent login`, or set CURSOR_API_KEY.",
        command: "agent login",
      };
    case "antigravity":
      return {
        detail:
          "Run `agy` and complete Google sign-in, or set GEMINI_API_KEY / ANTIGRAVITY_API_KEY.",
        command: "agy",
      };
  }
}
