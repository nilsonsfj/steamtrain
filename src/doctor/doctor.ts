import { spawn } from "node:child_process";
import { constants, access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { DEFAULT_AGENT_BINARY, resolveAgentInstances } from "../agents/config";
import { firstLine } from "../agents/util";
import type { SteamtrainConfig } from "../config/types";
import type { AgentId, AgentProviderId } from "../types/events";

export type DoctorStatus = "ok" | "binary_missing" | "not_authenticated" | "unknown_error";

export interface DoctorResult {
  agent: AgentId;
  provider?: AgentProviderId;
  label?: string;
  status: DoctorStatus;
  binary: string;
  binaryPath?: string;
  version?: string;
  /** Short status line for the panel. */
  message: string;
  /** Actionable fix-it hint when not ok. */
  detail?: string;
}

const VERSION_TIMEOUT_MS = 8000;
const AUTH_PATTERN =
  /not logged in|unauthor|authenticat|please run.*login|login required|no api key|api key not|set .*_api_key/i;

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
  return new Promise((resolve) => {
    const child = spawn(binaryPath, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      if (stdout.length < 10_000) stdout += c;
    });
    child.stderr.on("data", (c: string) => {
      if (stderr.length < 10_000) stderr += c;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, VERSION_TIMEOUT_MS);
    timer.unref?.();
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** Check one agent: resolve its binary, run `--version`, classify readiness. */
export async function checkAgent(
  agent: AgentId,
  binary: string,
  options: { provider?: AgentProviderId; label?: string; env?: Record<string, string> } = {},
): Promise<DoctorResult> {
  const provider = options.provider ?? (agent as AgentProviderId);
  const binaryPath = await resolveBinary(binary);
  if (!binaryPath) {
    return {
      agent,
      provider,
      label: options.label,
      status: "binary_missing",
      binary,
      message: `'${binary}' not found on PATH`,
      detail: installHint(provider),
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
    return {
      agent,
      provider,
      label: options.label,
      status: "not_authenticated",
      binary,
      binaryPath,
      message: "not authenticated",
      detail: authHint(provider),
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

function installHint(agent: AgentProviderId): string {
  switch (agent) {
    case "claude":
      return "Install Claude Code (npm i -g @anthropic-ai/claude-code) and ensure `claude` is on PATH.";
    case "opencode":
      return "Install OpenCode (brew install sst/tap/opencode, or npm i -g opencode-ai) and ensure `opencode` is on PATH.";
    case "codex":
      return "Install Codex (npm i -g @openai/codex) and ensure `codex` is on PATH.";
    case "amp":
      return "Install Amp (npm i -g @sourcegraph/amp) and ensure `amp` is on PATH.";
  }
}

function authHint(agent: AgentProviderId): string {
  switch (agent) {
    case "claude":
      return "Run `claude` and `/login` (subscription) or set ANTHROPIC_API_KEY.";
    case "opencode":
      return "Run `opencode auth login` for the provider you want to use.";
    case "codex":
      return "Run `codex login` (ChatGPT) or set CODEX_API_KEY for `codex exec`.";
    case "amp":
      return "Run `amp login`, or set AMP_API_KEY for non-interactive use (execute mode needs paid credits).";
  }
}
