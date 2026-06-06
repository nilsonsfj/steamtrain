import type { AgentEvent, AgentId, EventMapper } from "../types/events";
import { type OpenCodePart, opencodeEnvelope, opencodeEvent } from "../types/raw-opencode";
import { type AgentAdapter, type AgentRunOptions, runAgentProcess } from "./adapter";
import { stringifyContent } from "./util";

const AGENT: AgentId = "opencode";

/** Known OpenCode model ids (provider/model; used by `/model` and autocomplete). */
export const OPENCODE_MODELS = [
  "openai/gpt-5.4-mini",
  "openai/gpt-5.4",
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-opus-4-8",
] as const;

const TOOL_RUNNING = new Set(["pending", "running", "queued", "in_progress"]);
const TOOL_DONE = new Set(["completed", "done", "success", "finished"]);
const TOOL_FAILED = new Set(["error", "failed", "cancelled", "aborted"]);

/**
 * Build a mapper for one OpenCode run. Unlike Claude, OpenCode is **stateful**:
 *
 *  - text/reasoning parts ship the *cumulative* text each update, so we diff
 *    against the last value per part id and emit only the new suffix;
 *  - tool parts stream status transitions, so we emit `tool_use` once when a
 *    tool starts and `tool_result` once when it ends (dedup by call/part id);
 *  - the first event carrying a `ses_…` id yields a single `session_start`.
 *
 * Create a fresh mapper per run so this state never leaks between tasks.
 */
export function createOpenCodeMapper(agent: AgentId = AGENT): EventMapper {
  let sessionStarted = false;
  const textSeen = new Map<string, string>();
  const toolStarted = new Set<string>();
  const toolFinished = new Set<string>();

  const diff = (key: string, full: string): string => {
    const prev = textSeen.get(key) ?? "";
    const delta = full.startsWith(prev) ? full.slice(prev.length) : full;
    textSeen.set(key, full);
    return delta;
  };

  const handlePart = (part: OpenCodePart, ts: number, out: AgentEvent[]): void => {
    const ptype = part.type;

    if (ptype === "text") {
      const delta = diff(part.id ?? "text", part.text ?? "");
      if (delta) out.push({ kind: "text_delta", agent, ts, text: delta });
      return;
    }
    if (ptype === "reasoning" || ptype === "thinking") {
      const delta = diff(part.id ?? "reasoning", part.text ?? "");
      if (delta) out.push({ kind: "text_delta", agent, ts, text: delta, thinking: true });
      return;
    }
    if (ptype === "tool" || part.tool) {
      const id = part.callID ?? part.id ?? part.tool ?? "tool";
      const name = part.tool ?? "tool";
      const status = part.state?.status;

      if (status === undefined || TOOL_RUNNING.has(status)) {
        if (!toolStarted.has(id)) {
          toolStarted.add(id);
          out.push({ kind: "tool_use", agent, ts, id, name, input: part.state?.input, status });
        }
        return;
      }
      if (TOOL_FAILED.has(status)) {
        if (!toolFinished.has(id)) {
          toolFinished.add(id);
          out.push({
            kind: "tool_result",
            agent,
            ts,
            id,
            name,
            output: stringifyContent(part.state?.error ?? part.state?.output),
            isError: true,
            status,
          });
        }
        return;
      }
      if (TOOL_DONE.has(status)) {
        if (!toolFinished.has(id)) {
          toolFinished.add(id);
          out.push({
            kind: "tool_result",
            agent,
            ts,
            id,
            name,
            output: stringifyContent(
              part.state?.output ?? part.state?.metadata ?? part.state?.title,
            ),
            isError: false,
            status,
          });
        }
        return;
      }
    }
    // step-start / step-finish parts and other shapes carry no displayable text.
  };

  return (raw: unknown): AgentEvent[] => {
    const ts = Date.now();
    const parsed = opencodeEvent.safeParse(raw);
    if (!parsed.success) {
      const env = opencodeEnvelope.safeParse(raw);
      return [
        { kind: "unknown", agent, ts, rawType: env.success ? env.data.type : undefined, raw },
      ];
    }

    const e = parsed.data;
    const part = e.part ?? e.properties?.part;
    const out: AgentEvent[] = [];

    const sessionId = e.sessionID ?? part?.sessionID;
    if (!sessionStarted && sessionId && e.type !== "error") {
      sessionStarted = true;
      out.push({ kind: "session_start", agent, ts, sessionId });
    }

    switch (e.type) {
      case "error": {
        const message =
          e.error?.data?.message ?? e.error?.message ?? e.error?.name ?? "opencode error";
        out.push({ kind: "error", agent, ts, message, code: null });
        return out;
      }
      case "step_finish":
      case "step.finish": {
        out.push({
          kind: "result",
          agent,
          ts,
          isError: false,
          subtype: "step_finish",
          costUsd: e.cost,
        });
        return out;
      }
      case "step_start":
      case "step.start": {
        // session_start (above) already covers the meaningful signal.
        return out;
      }
      default: {
        if (part) {
          handlePart(part, ts, out);
          return out;
        }
        if (out.length === 0) out.push({ kind: "unknown", agent, ts, rawType: e.type, raw });
        return out;
      }
    }
  };
}

/** Runs the real `opencode` CLI in JSON event mode. */
export class OpenCodeAdapter implements AgentAdapter {
  readonly id: AgentId = AGENT;
  readonly binary: string;

  constructor(binary = "opencode") {
    this.binary = binary;
  }

  run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
    // NOTE: `--format json` (NOT `--command`, which suppresses JSON output).
    const args = [
      "run",
      "--format",
      "json",
      "--model",
      opts.model,
      ...(opts.extraArgs ?? []),
      opts.prompt,
    ];
    return runAgentProcess({
      id: this.id,
      binary: this.binary,
      args,
      opts,
      map: createOpenCodeMapper(this.id),
    });
  }
}
