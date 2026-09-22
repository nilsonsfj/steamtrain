import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentEvent,
  AgentId,
  AgentInstanceId,
  EventMapper,
  TokenUsage,
} from "../types/events";
import {
  type GrokEnd,
  type GrokError,
  type GrokUsage,
  grokEnd,
  grokEnvelope,
  grokError,
  grokText,
  grokToolCall,
  grokToolUpdate,
  grokUsageLine,
} from "../types/raw-grok";
import { type AgentAdapter, type AgentRunOptions, runAgentProcess } from "./adapter";
import type { AgentModel } from "./agent-model";
import { permissionArgs } from "./permissions";
import { stringifyContent } from "./util";

const AGENT: AgentInstanceId = "grok";

/**
 * Offline catalog for `/model` when `grok models` has not succeeded.
 * Live installs replace this list; keep the ids current with `grok models`.
 * Default is `grok-4.7` (Grok Build's account default as of 2026-09).
 */
export const GROK_MODELS: readonly AgentModel[] = [
  { id: "grok-4.7", name: "Grok 4.7" },
  { id: "grok-4.7-build-fast", name: "Grok 4.7 Fast" },
  { id: "grok-4.6", name: "Grok 4.6" },
  { id: "grok-4.5", name: "Grok 4.5" },
];

/** Stop reasons that mean the turn did not finish with an answer. */
const ERROR_STOP_REASONS = new Set([
  "refusal",
  "cancelled",
  "canceled",
  "max_turn_requests",
  "error",
]);

/** Events that carry no normalized steamtrain equivalent. */
const QUIET_TYPES = new Set(["plan", "available_commands", "max_turns_reached"]);

const TERMINAL_SKIP = new Set(["in_progress", "pending", "started"]);

/**
 * Args for one headless `grok -p` run.
 *
 * The prompt is a file (`--prompt-file`) so workflow prompts are not bounded
 * by `ARG_MAX` and cannot be parsed as flags. Permission flags land before
 * `extraArgs`, so a hand-written flag still has the last word. With no
 * profile, `--always-approve` is what makes a headless tool loop runnable —
 * Grok's default ask mode cannot prompt. Update checks are not disabled with
 * a flag: piped stderr already skips them, and not every `grok` build accepts
 * `--no-auto-update`.
 */
export function buildGrokRunArgs(opts: AgentRunOptions, promptFile: string): string[] {
  const permissionFlags = opts.permissions
    ? permissionArgs("grok", opts.permissions)
    : ["--always-approve"];
  return [
    "--output-format",
    "streaming-json",
    "--model",
    opts.model,
    ...(opts.effort ? ["--effort", opts.effort] : []),
    ...(opts.resumeSessionId ? ["--resume", opts.resumeSessionId] : []),
    ...permissionFlags,
    ...(opts.extraArgs ?? []),
    "--prompt-file",
    promptFile,
  ];
}

function grokTokens(usage: GrokUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  const tokens: TokenUsage = {};
  if (usage.input_tokens !== undefined) tokens.input = usage.input_tokens;
  if (usage.output_tokens !== undefined) tokens.output = usage.output_tokens;
  if (usage.cache_read_input_tokens !== undefined) tokens.cacheRead = usage.cache_read_input_tokens;
  if (usage.cache_creation_input_tokens !== undefined) {
    tokens.cacheWrite = usage.cache_creation_input_tokens;
  }
  if (usage.reasoning_tokens !== undefined) tokens.reasoning = usage.reasoning_tokens;
  return Object.keys(tokens).length > 0 ? tokens : undefined;
}

function grokCost(raw: {
  total_cost_usd?: number;
  cost_is_partial?: boolean;
  usage_is_incomplete?: boolean;
}): number | undefined {
  if (raw.cost_is_partial || raw.usage_is_incomplete) return undefined;
  return typeof raw.total_cost_usd === "number" && Number.isFinite(raw.total_cost_usd)
    ? raw.total_cost_usd
    : undefined;
}

function readSessionId(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as { sessionId?: unknown; session_id?: unknown };
  const id = obj.sessionId ?? obj.session_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function isTerminalStatus(status: string | undefined): boolean {
  if (!status) return false;
  return !TERMINAL_SKIP.has(status);
}

function outputIsError(status: string | undefined, output: unknown): boolean {
  if (status && status !== "completed") return true;
  return Boolean(output && typeof output === "object" && "error" in output);
}

function toolOutput(rawOutput: unknown, content: unknown): string {
  if (rawOutput !== undefined) return stringifyContent(rawOutput);
  if (content !== undefined) return stringifyContent(content);
  return "";
}

/**
 * Map one Grok Build `streaming-json` run onto steamtrain events.
 *
 * Session ids arrive on the terminal `end` line (sometimes earlier). Tool
 * calls open with `tool_call` and finish on `tool_call_update`. Per-response
 * `usage` lines are that response's tokens, not a running total.
 */
export function createGrokMapper(agent: AgentInstanceId = AGENT, model?: string): EventMapper {
  let announcedSession = false;
  const opened = new Set<string>();
  const finished = new Set<string>();
  const names = new Map<string, string>();

  const sessionEvent = (raw: unknown, ts: number): AgentEvent | undefined => {
    if (announcedSession) return undefined;
    const sessionId = readSessionId(raw);
    if (!sessionId) return undefined;
    announcedSession = true;
    return { kind: "session_start", agent, ts, sessionId, ...(model ? { model } : {}) };
  };

  const withSession = (session: AgentEvent | undefined, events: AgentEvent[]): AgentEvent[] =>
    session ? [session, ...events] : events;

  const rememberName = (
    id: string | undefined,
    ...candidates: Array<string | undefined>
  ): string => {
    for (const candidate of candidates) {
      if (candidate && candidate.length > 0) {
        if (id) names.set(id, candidate);
        return candidate;
      }
    }
    if (id && names.has(id)) return names.get(id)!;
    return "tool";
  };

  const toolEvents = (
    ts: number,
    id: string | undefined,
    name: string,
    status: string | undefined,
    input: unknown,
    output: unknown,
  ): AgentEvent[] => {
    const events: AgentEvent[] = [];
    const seen = id ? opened.has(id) : false;
    if (id) opened.add(id);
    if (!seen) {
      events.push({
        kind: "tool_use",
        agent,
        ts,
        id,
        name,
        ...(input !== undefined ? { input } : {}),
        ...(status ? { status } : {}),
      });
    }
    if (!isTerminalStatus(status)) return events;
    if (id && finished.has(id)) return events;
    if (id) finished.add(id);
    const text = toolOutput(output, undefined);
    events.push({
      kind: "tool_result",
      agent,
      ts,
      id,
      name,
      ...(text ? { output: text } : {}),
      isError: outputIsError(status, output),
      ...(status ? { status } : {}),
    });
    return events;
  };

  return (raw: unknown): AgentEvent[] => {
    const ts = Date.now();
    const session = sessionEvent(raw, ts);
    const env = grokEnvelope.safeParse(raw);
    if (!env.success) return withSession(session, [{ kind: "unknown", agent, ts, raw }]);

    const type = env.data.type;
    if (QUIET_TYPES.has(type) || type.startsWith("auto_compact")) return withSession(session, []);

    switch (type) {
      case "text":
      case "thought": {
        const parsed = grokText.safeParse(raw);
        const text = parsed.success ? (parsed.data.data ?? "") : "";
        if (!text) return withSession(session, []);
        return withSession(session, [
          {
            kind: "text_delta",
            agent,
            ts,
            text,
            ...(type === "thought" ? { thinking: true } : {}),
          },
        ]);
      }

      case "tool_call": {
        const parsed = grokToolCall.safeParse(raw);
        if (!parsed.success) {
          return withSession(session, [{ kind: "unknown", agent, ts, rawType: "tool_call", raw }]);
        }
        const data = parsed.data;
        const name = rememberName(data.toolCallId, data.toolName, data.title, data.kind);
        const output = data.rawOutput !== undefined ? data.rawOutput : data.content;
        return withSession(
          session,
          toolEvents(ts, data.toolCallId, name, data.status, data.rawInput, output),
        );
      }

      case "tool_call_update": {
        const parsed = grokToolUpdate.safeParse(raw);
        if (!parsed.success) {
          return withSession(session, [
            { kind: "unknown", agent, ts, rawType: "tool_call_update", raw },
          ]);
        }
        const data = parsed.data;
        const name = rememberName(data.toolCallId, data.toolName, data.title);
        const output = data.rawOutput !== undefined ? data.rawOutput : data.content;
        return withSession(
          session,
          toolEvents(ts, data.toolCallId, name, data.status, undefined, output),
        );
      }

      case "usage": {
        const parsed = grokUsageLine.safeParse(raw);
        if (!parsed.success) {
          return withSession(session, [{ kind: "unknown", agent, ts, rawType: "usage", raw }]);
        }
        const tokens = grokTokens(parsed.data.usage);
        if (!tokens) return withSession(session, []);
        return withSession(session, [{ kind: "usage", agent, ts, tokens }]);
      }

      case "end": {
        const parsed = grokEnd.safeParse(raw);
        if (!parsed.success) {
          return withSession(session, [{ kind: "unknown", agent, ts, rawType: "end", raw }]);
        }
        return withSession(session, endEvents(agent, ts, parsed.data));
      }

      case "error": {
        const parsed = grokError.safeParse(raw);
        if (!parsed.success) {
          return withSession(session, [{ kind: "unknown", agent, ts, rawType: "error", raw }]);
        }
        return withSession(session, errorEvents(agent, ts, parsed.data));
      }

      default:
        return withSession(session, [{ kind: "unknown", agent, ts, rawType: type, raw }]);
    }
  };
}

function endEvents(agent: AgentInstanceId, ts: number, data: GrokEnd): AgentEvent[] {
  const stop = data.stopReason;
  const isError = stop ? ERROR_STOP_REASONS.has(stop) : false;
  const text = data.text ?? data.data;
  const events: AgentEvent[] = [];
  if (isError) {
    events.push({
      kind: "error",
      agent,
      ts,
      message: text && text.length > 0 ? text : (stop ?? "grok error"),
    });
  }
  events.push({
    kind: "result",
    agent,
    ts,
    isError,
    ...(text && text.length > 0 ? { text } : {}),
    ...(stop ? { subtype: stop } : {}),
    costUsd: grokCost(data),
    tokens: grokTokens(data.usage),
  });
  return events;
}

function errorEvents(agent: AgentInstanceId, ts: number, data: GrokError): AgentEvent[] {
  const message = data.message && data.message.length > 0 ? data.message : "grok error";
  const tokens = grokTokens(data.usage);
  const costUsd = grokCost(data);
  const events: AgentEvent[] = [{ kind: "error", agent, ts, message }];
  if (tokens || costUsd !== undefined) {
    events.push({
      kind: "result",
      agent,
      ts,
      isError: true,
      text: message,
      subtype: "error",
      ...(tokens ? { tokens } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    });
  }
  return events;
}

/** Runs the real `grok` CLI in native streaming JSON mode. */
export class GrokAdapter implements AgentAdapter {
  readonly id: AgentId = "grok";
  readonly binary: string;
  readonly defaultModel = "grok-4.7";
  /** `grok --resume <sessionId>` continues a recorded session headlessly and in the TUI. */
  readonly supportsResume = true;

  constructor(binary = "grok") {
    this.binary = binary;
  }

  async *run(opts: AgentRunOptions): AsyncGenerator<AgentEvent> {
    const dir = await mkdtemp(join(tmpdir(), "steamtrain-grok-"));
    const promptFile = join(dir, "prompt.txt");
    try {
      await writeFile(promptFile, opts.prompt, "utf8");
      yield* runAgentProcess({
        id: this.id,
        binary: this.binary,
        args: buildGrokRunArgs(opts, promptFile),
        opts,
        map: createGrokMapper(opts.agentId ?? this.id, opts.model),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
