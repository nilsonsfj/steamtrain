import type { AgentEvent, AgentId } from "../types/events";
import { type AgentAdapter, type AgentRunOptions } from "./adapter";
import type { AgentModel } from "./agent-model";
import { type ProcessLine, type ProcessRunOptions, runProcessLines } from "./spawn";
import { firstLine } from "./util";

const AGENT: AgentId = "kiro";

/**
 * Known Kiro models. Ids must match `kiro-cli chat --list-models` exactly —
 * Kiro rejects Claude-style short aliases (`haiku` / `sonnet` / `opus`) and
 * dash-versioned ids (`claude-haiku-4-5`); it expects dotted forms
 * (`claude-haiku-4.5`). Catalog may still lag the live CLI.
 */
export const KIRO_MODELS: readonly AgentModel[] = [
  { id: "auto", name: "Auto" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { id: "claude-opus-4.8", name: "Claude Opus 4.8" },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
  { id: "claude-opus-4.7", name: "Claude Opus 4.7" },
  { id: "claude-opus-4.6", name: "Claude Opus 4.6" },
  { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
  { id: "claude-opus-4.5", name: "Claude Opus 4.5" },
  { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
  { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
  { id: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
  { id: "deepseek-3.2", name: "DeepSeek 3.2" },
  { id: "minimax-m2.5", name: "MiniMax M2.5" },
  { id: "minimax-m2.1", name: "MiniMax M2.1" },
  { id: "glm-5", name: "GLM-5" },
  { id: "qwen3-coder-next", name: "Qwen3 Coder Next" },
];

/**
 * Build headless argv for Amazon Kiro CLI (`kiro-cli`).
 *
 * Real contract (see https://kiro.dev/docs/cli/headless/):
 *   kiro-cli chat --no-interactive --trust-all-tools --model MODEL [PROMPT]
 *
 * There is no Claude-style `--print` / `--output-format stream-json` — those
 * flags are rejected (`unexpected argument '--print'`). Prompt is a positional
 * argument (stdin stays closed unless the caller pipes extra context).
 */
export function buildKiroExecArgs(opts: AgentRunOptions): string[] {
  // No session resume yet: headless mode does not expose a session id, and
  // this adapter does not set supportsResume (see docs/workflow-spec.md).
  // `--` keeps prompts that start with `-` from being parsed as CLI flags.
  return [
    "chat",
    "--no-interactive",
    "--trust-all-tools",
    "--wrap",
    "never",
    "--model",
    opts.model,
    ...(opts.effort ? ["--effort", opts.effort] : []),
    ...(opts.extraArgs ?? []),
    "--",
    opts.prompt,
  ];
}

export interface RunKiroProcessParams {
  id: AgentId;
  binary: string;
  args: string[];
  opts: AgentRunOptions;
  /** @internal Test seam — defaults to {@link runProcessLines}. */
  runLines?: (opts: ProcessRunOptions) => AsyncIterable<ProcessLine>;
}

/**
 * Plain-text driver for Kiro headless chat.
 *
 * kiro-cli prints the final assistant response to stdout (no stream-json).
 * We stream lines as text_delta and emit a result when the process exits 0.
 *
 * No `session_start`: headless mode does not expose a session id on stdout or
 * stderr (unlike agy, which surfaces a conversation id). Resume / takeover that
 * depend on a recorded session therefore cannot chain onto a kiro headless run.
 */
export async function* runKiroProcess(params: RunKiroProcessParams): AsyncGenerator<AgentEvent> {
  const { binary, args, opts } = params;
  const id = opts.agentId ?? params.id;
  const startedAt = Date.now();
  const textParts: string[] = [];
  const runLines = params.runLines ?? runProcessLines;

  const processOpts: ProcessRunOptions = {
    binary,
    args,
    cwd: opts.cwd,
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    // Prompt is an argv token — leave stdin closed.
  };

  for await (const item of runLines(processOpts)) {
    if (item.kind === "line") {
      textParts.push(item.line);
      yield { kind: "text_delta", agent: id, ts: Date.now(), text: `${item.line}\n` };
      continue;
    }

    if (item.kind === "stderr") {
      continue;
    }

    if (item.kind === "exit") {
      const ts = Date.now();
      const stderr = item.stderr.trim();
      const stderrTail = stderr ? `: ${firstLine(stderr)}` : "";

      if (item.spawnError) {
        yield {
          kind: "error",
          agent: id,
          ts,
          message: `failed to start '${binary}': ${item.spawnError}`,
          stderr: stderr || undefined,
          code: item.code,
        };
        return;
      }
      if (item.timedOut) {
        yield {
          kind: "error",
          agent: id,
          ts,
          message: `'${binary}' timed out after ${opts.timeoutMs! / 1000}s`,
          stderr: stderr || undefined,
          code: item.code,
          category: "transient",
          timedOut: true,
        };
        return;
      }
      if ((item.code ?? 0) !== 0) {
        yield {
          kind: "error",
          agent: id,
          ts,
          message: `'${binary}' exited with code ${item.code}${stderrTail}`,
          stderr: stderr || undefined,
          code: item.code,
        };
        return;
      }

      const text = textParts.join("\n").trim();
      if (!text) {
        yield {
          kind: "error",
          agent: id,
          ts,
          message: `'${binary}' produced no output${stderrTail}`,
          stderr: stderr || undefined,
          code: item.code,
        };
        return;
      }

      yield {
        kind: "result",
        agent: id,
        ts,
        isError: false,
        text,
        durationMs: Date.now() - startedAt,
        // Headless chat prints plain text only — no token usage / cost on
        // stdout (same limitation as antigravity print mode).
      };
    }
  }
}

/** Runs the real `kiro-cli` in headless chat mode with plain-text stdout. */
export class KiroCliAdapter implements AgentAdapter {
  readonly id: AgentId = AGENT;
  readonly binary: string;
  readonly defaultModel = "claude-sonnet-5";

  constructor(binary = "kiro-cli") {
    this.binary = binary;
  }

  run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
    return runKiroProcess({
      id: this.id,
      binary: this.binary,
      args: buildKiroExecArgs(opts),
      opts,
    });
  }
}
