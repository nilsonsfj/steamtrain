import type { AgentEvent, AgentId } from "../types/events";
import { type AgentAdapter, type AgentRunOptions } from "./adapter";
import type { AgentModel } from "./agent-model";
import {
  type RecoverAntigravityTranscriptOptions,
  lastAntigravityConversationForCwd,
  recoverAntigravityTranscriptText,
} from "./antigravity-transcript";
import { type ProcessLine, type ProcessRunOptions, runProcessLines } from "./spawn";
import { firstLine } from "./util";

/**
 * Known Antigravity CLI models (used by `/model` and autocomplete).
 *
 * agy does not accept slug aliases (`gemini-3-pro` is rejected). Model ids
 * are the display labels from `agy models`, including spaces / parentheses.
 * Base names (no effort suffix) are included so steamtrain's effort picker
 * can append `(Low|Medium|High|Thinking)` via {@link resolveAntigravityModel}.
 */
export const ANTIGRAVITY_MODELS: readonly AgentModel[] = [
  { id: "Gemini 3.1 Pro", name: "Gemini 3.1 Pro" },
  { id: "Gemini 3.1 Pro (High)", name: "Gemini 3.1 Pro (High)" },
  { id: "Gemini 3.1 Pro (Low)", name: "Gemini 3.1 Pro (Low)" },
  { id: "Gemini 3.5 Flash", name: "Gemini 3.5 Flash" },
  { id: "Gemini 3.5 Flash (High)", name: "Gemini 3.5 Flash (High)" },
  { id: "Gemini 3.5 Flash (Medium)", name: "Gemini 3.5 Flash (Medium)" },
  { id: "Gemini 3.5 Flash (Low)", name: "Gemini 3.5 Flash (Low)" },
  { id: "Claude Sonnet 4.6", name: "Claude Sonnet 4.6" },
  { id: "Claude Sonnet 4.6 (Thinking)", name: "Claude Sonnet 4.6 (Thinking)" },
  { id: "Claude Opus 4.6", name: "Claude Opus 4.6" },
  { id: "Claude Opus 4.6 (Thinking)", name: "Claude Opus 4.6 (Thinking)" },
  { id: "GPT-OSS 120B", name: "GPT-OSS 120B" },
  { id: "GPT-OSS 120B (Medium)", name: "GPT-OSS 120B (Medium)" },
];

const EFFORT_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  thinking: "Thinking",
  // Accepted as aliases when remapping efforts from other providers.
  xhigh: "Thinking",
  max: "Thinking",
};

const HAS_EFFORT_SUFFIX = /\((Low|Medium|High|Thinking)\)\s*$/i;

/**
 * Antigravity models encode effort in the display label
 * (`Gemini 3.1 Pro (High)`). When steamtrain's separate `effort` field is set
 * and the model has no parenthetical suffix, append one.
 */
export function resolveAntigravityModel(model: string, effort?: string): string {
  if (!effort) return model;
  if (HAS_EFFORT_SUFFIX.test(model)) return model;
  const label = EFFORT_LABELS[effort.toLowerCase()];
  if (!label) return model;
  return `${model} (${label})`;
}

/** Format steamtrain timeoutMs as a Go duration string for `--print-timeout`. */
export function formatAntigravityPrintTimeout(timeoutMs?: number): string | undefined {
  if (!timeoutMs || timeoutMs <= 0) return undefined;
  return `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`;
}

/**
 * Build headless argv for `agy`.
 *
 * Critical: `--print` consumes the next token as the prompt, so it must be
 * the final flag pair. Open inherited stdin can hang print mode — callers
 * must spawn with stdin ignored (this adapter does).
 */
export function buildAntigravityRunArgs(opts: AgentRunOptions): string[] {
  const printTimeout = formatAntigravityPrintTimeout(opts.timeoutMs);
  return [
    "--model",
    resolveAntigravityModel(opts.model, opts.effort),
    "--dangerously-skip-permissions",
    "--mode",
    "accept-edits",
    ...(opts.resumeSessionId ? ["--conversation", opts.resumeSessionId] : []),
    ...(printTimeout ? ["--print-timeout", printTimeout] : []),
    ...(opts.extraArgs ?? []),
    "--print",
    opts.prompt,
  ];
}

const CONVERSATION_ID_PATTERNS: readonly RegExp[] = [
  /Created conversation\s+([0-9a-fA-F-]{8,})/,
  /conversation=([0-9a-fA-F-]{8,})/,
  /Stream completed for\s+([0-9a-fA-F-]{8,})/,
  /Stream goroutine exited for\s+([0-9a-fA-F-]{8,})/,
];

/** Pull a conversation UUID out of agy stderr / log noise. */
export function extractAntigravityConversationId(text: string): string | undefined {
  for (const pattern of CONVERSATION_ID_PATTERNS) {
    const match = pattern.exec(text);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export interface RunAntigravityProcessParams {
  id: AgentId;
  binary: string;
  args: string[];
  opts: AgentRunOptions;
  /** @internal Test seam — defaults to {@link runProcessLines}. */
  runLines?: (opts: ProcessRunOptions) => AsyncIterable<ProcessLine>;
  /** @internal Test seam — defaults to {@link recoverAntigravityTranscriptText}. */
  recoverTranscript?: (
    options: RecoverAntigravityTranscriptOptions,
  ) => ReturnType<typeof recoverAntigravityTranscriptText>;
  /** @internal Test seam — defaults to {@link lastAntigravityConversationForCwd}. */
  lastConversationForCwd?: (cwd: string) => string | undefined;
}

/**
 * Plain-text driver for Antigravity print mode.
 *
 * agy 1.1.x has no stream-json. We stream stdout lines as text_delta, discover
 * session ids from stderr, and fall back to the on-disk transcript when stdout
 * is empty (known non-TTY drop).
 */
export async function* runAntigravityProcess(
  params: RunAntigravityProcessParams,
): AsyncGenerator<AgentEvent> {
  const { binary, args, opts } = params;
  const id = opts.agentId ?? params.id;
  const startedAt = Date.now();
  let sessionId = opts.resumeSessionId;
  let emittedSession = false;
  const textParts: string[] = [];
  const pendingDeltas: string[] = [];
  let sawStdout = false;
  let sawError = false;
  const cwd = opts.cwd ?? process.cwd();
  const runLines = params.runLines ?? runProcessLines;
  const recoverTranscript = params.recoverTranscript ?? recoverAntigravityTranscriptText;
  const lastConversationForCwd =
    params.lastConversationForCwd ?? ((path: string) => lastAntigravityConversationForCwd(path));

  const emitSession = function* (): Generator<AgentEvent> {
    if (emittedSession || !sessionId) return;
    emittedSession = true;
    yield {
      kind: "session_start",
      agent: id,
      ts: Date.now(),
      sessionId,
      model: resolveAntigravityModel(opts.model, opts.effort),
    };
  };

  const flushPendingDeltas = function* (): Generator<AgentEvent> {
    while (pendingDeltas.length > 0) {
      const line = pendingDeltas.shift() as string;
      yield { kind: "text_delta", agent: id, ts: Date.now(), text: `${line}\n` };
    }
  };

  const processOpts: ProcessRunOptions = {
    binary,
    args,
    cwd: opts.cwd,
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    // Intentionally omit prompt — stdin must stay closed for agy print mode.
  };

  for await (const item of runLines(processOpts)) {
    if (item.kind === "stderr") {
      const found = extractAntigravityConversationId(item.text);
      if (found && !sessionId) {
        sessionId = found;
        yield* emitSession();
        yield* flushPendingDeltas();
      }
      continue;
    }

    if (item.kind === "line") {
      sawStdout = true;
      textParts.push(item.line);
      if (emittedSession || sessionId) {
        if (!emittedSession) yield* emitSession();
        yield* flushPendingDeltas();
        yield { kind: "text_delta", agent: id, ts: Date.now(), text: `${item.line}\n` };
      } else {
        // Hold text until session_start so event order matches other adapters.
        pendingDeltas.push(item.line);
      }
      continue;
    }

    if (item.kind === "exit") {
      const ts = Date.now();
      const stderr = item.stderr.trim();
      const stderrTail = stderr ? `: ${firstLine(stderr)}` : "";
      if (item.sawStdout) sawStdout = true;

      if (!sessionId) {
        const fromStderr = extractAntigravityConversationId(item.stderr);
        if (fromStderr) sessionId = fromStderr;
      }
      if (!sessionId) {
        sessionId = lastConversationForCwd(cwd);
      }

      if (item.spawnError) {
        sawError = true;
        yield* emitSession();
        yield* flushPendingDeltas();
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
        sawError = true;
        yield* emitSession();
        yield* flushPendingDeltas();
        yield {
          kind: "error",
          agent: id,
          ts,
          message: `'${binary}' timed out after ${opts.timeoutMs! / 1000}s`,
          stderr: stderr || undefined,
          code: item.code,
        };
        return;
      }
      if ((item.code ?? 0) !== 0) {
        sawError = true;
        yield* emitSession();
        yield* flushPendingDeltas();
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

      let text = textParts.join("\n").trim();
      if (!text || !sawStdout) {
        const recovered = recoverTranscript({
          cwd,
          conversationId: sessionId,
        });
        if (recovered) {
          sessionId = sessionId ?? recovered.conversationId;
          text = recovered.text;
          // session_start (if any) then any buffered lines, then recovered text.
          yield* emitSession();
          yield* flushPendingDeltas();
          yield { kind: "text_delta", agent: id, ts, text: `${text}\n` };
        }
      }

      // Prefer session_start before any remaining buffered text_delta / result.
      // emitSession / flushPendingDeltas are no-ops when already drained above.
      yield* emitSession();
      yield* flushPendingDeltas();

      if (!text && !sawError) {
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
        // agy print mode does not report token usage / cost on stdout or in
        // transcript PLANNER_RESPONSE lines (as of 1.1.x).
      };
    }
  }
}

export class AntigravityAdapter implements AgentAdapter {
  readonly id: AgentId = "antigravity";
  readonly binary: string;
  /** Prefer High effort out of the box; users can switch to the base id + effort. */
  readonly defaultModel = "Gemini 3.1 Pro (High)";
  readonly supportsResume = true;

  constructor(binary = "agy") {
    this.binary = binary;
  }

  run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
    return runAntigravityProcess({
      id: this.id,
      binary: this.binary,
      args: buildAntigravityRunArgs(opts),
      opts,
    });
  }
}
