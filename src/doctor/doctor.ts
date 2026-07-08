import { spawn } from "node:child_process";
import { constants, access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { DEFAULT_AGENT_BINARY, resolveAgentInstances } from "../agents/config";
import { firstLine } from "../agents/util";
import type { SteamtrainConfig } from "../config/types";
import type { AgentInstanceId, AgentProviderId } from "../types/events";
import { type LlmProviderId, llmApiKeyEnvName, resolveLlmProvider } from "../workflow/llm";
import { type LlmStep, type WorkflowSpec, workflowStepKind } from "../workflow/types";

export type DoctorStatus =
  | "ok"
  | "binary_missing"
  | "not_authenticated"
  | "unknown_error"
  | "api_key_missing";

export interface DoctorResult {
  /** What this readiness entry checks: an agent CLI, or an llm-step API key. */
  category: "agent" | "llm-key";
  /** Agent instance id (agent checks only). */
  agent?: AgentInstanceId;
  /** For display: an agent provider, or "anthropic"/"openai" for llm keys. */
  provider?: AgentProviderId | LlmProviderId;
  label?: string;
  status: DoctorStatus;
  /** Agent binary (agent checks only). */
  binary?: string;
  binaryPath?: string;
  version?: string;
  /** For llm-key checks: the env var that must be set (e.g. "ANTHROPIC_API_KEY"). */
  requirement?: string;
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
  agent: AgentInstanceId,
  binary: string,
  options: { provider: AgentProviderId; label?: string; env?: Record<string, string> },
): Promise<DoctorResult> {
  const provider = options.provider;
  const binaryPath = await resolveBinary(binary);
  if (!binaryPath) {
    return {
      category: "agent",
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
      category: "agent",
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
      category: "agent",
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
      category: "agent",
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
    category: "agent",
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

/** A distinct API key a workflow's `llm` steps need at runtime. */
export interface LlmKeyRequirement {
  provider: LlmProviderId;
  /** Env var holding the key, e.g. "ANTHROPIC_API_KEY". */
  envVar: string;
}

/**
 * Distinct API-key requirements of a workflow's `llm` steps. Each `llm` step
 * resolves to a provider (explicit, or inferred from the model name) and an env
 * var holding the key (step override, else the provider's convention). The
 * result is deduped by env var, so a workflow with many anthropic steps yields
 * a single `ANTHROPIC_API_KEY` entry.
 */
export function collectLlmKeyRequirements(spec: WorkflowSpec): LlmKeyRequirement[] {
  const byEnv = new Map<string, LlmKeyRequirement>();
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      if (workflowStepKind(step) !== "llm") continue;
      const llm = step as LlmStep;
      const provider = resolveLlmProvider(llm);
      const envVar = llmApiKeyEnvName(provider, llm.apiKeyEnv);
      if (!byEnv.has(envVar)) byEnv.set(envVar, { provider, envVar });
    }
  }
  return [...byEnv.values()];
}

/**
 * Preflight readiness of a workflow's `llm` API keys against the environment.
 * An `llm` step is stateless and needs only its provider key (read from the
 * env at run time); surfacing a missing key here lets the run fail fast at the
 * preflight panel instead of mid-run when the first `llm` step fires.
 */
export function checkLlmApiKeys(
  spec: WorkflowSpec,
  env: Record<string, string | undefined> = process.env,
): DoctorResult[] {
  return collectLlmKeyRequirements(spec).map((req) => {
    const present = !!env[req.envVar];
    const providerLabel = req.provider === "anthropic" ? "Anthropic" : "OpenAI-compatible";
    return {
      category: "llm-key",
      provider: req.provider,
      requirement: req.envVar,
      label: `${providerLabel} (${req.envVar})`,
      status: present ? "ok" : "api_key_missing",
      message: present ? `${req.envVar} set` : `${req.envVar} not set`,
      detail: present
        ? undefined
        : `Set ${req.envVar} in the environment to run workflows with ${req.provider} llm steps.`,
    };
  });
}

/** Union of llm-key requirements across several workflows (for a global preflight panel). */
export function checkLlmApiKeysForCatalog(
  specs: WorkflowSpec[],
  env: Record<string, string | undefined> = process.env,
): DoctorResult[] {
  const byEnv = new Map<string, DoctorResult>();
  for (const spec of specs) {
    for (const check of checkLlmApiKeys(spec, env)) {
      const key = `${check.category}:${check.requirement ?? ""}`;
      if (!byEnv.has(key)) byEnv.set(key, check);
    }
  }
  return [...byEnv.values()];
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
    case "kiro":
      return "Install Kiro CLI (npm i -g @anthropic-ai/kiro-cli) and ensure `kiro-cli` is on PATH.";
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
    case "kiro":
      return "Run `kiro-cli` and authenticate, or set ANTHROPIC_API_KEY.";
  }
}
