import type { AgentEvent, AgentId, EventMapper } from "../types/events";
import { type OpenCodePart, opencodeEnvelope, opencodeEvent } from "../types/raw-opencode";
import { type AgentAdapter, type AgentRunOptions, runAgentProcess } from "./adapter";
import type { AgentModel } from "./agent-model";
import { stringifyContent } from "./util";

const AGENT: AgentId = "opencode";

/** Known OpenCode models (provider/model; used by `/model` and autocomplete). */
export const OPENCODE_MODELS: readonly AgentModel[] = [
  // OpenCode Zen (https://opencode.ai/zen/v1/models)
  { id: "opencode/gpt-5.4-mini", name: "GPT 5.4 Mini" },
  { id: "opencode/gpt-5.4", name: "GPT 5.4" },
  { id: "opencode/gpt-5.4-pro", name: "GPT 5.4 Pro" },
  { id: "opencode/gpt-5.4-nano", name: "GPT 5.4 Nano" },
  { id: "opencode/gpt-5.5", name: "GPT 5.5" },
  { id: "opencode/gpt-5.5-pro", name: "GPT 5.5 Pro" },
  { id: "opencode/gpt-5.3-codex", name: "GPT 5.3 Codex" },
  { id: "opencode/gpt-5.3-codex-spark", name: "GPT 5.3 Codex Spark" },
  { id: "opencode/gpt-5.2", name: "GPT 5.2" },
  { id: "opencode/gpt-5.2-codex", name: "GPT 5.2 Codex" },
  { id: "opencode/gpt-5.1", name: "GPT 5.1" },
  { id: "opencode/gpt-5.1-codex", name: "GPT 5.1 Codex" },
  { id: "opencode/gpt-5.1-codex-max", name: "GPT 5.1 Codex Max" },
  { id: "opencode/gpt-5.1-codex-mini", name: "GPT 5.1 Codex Mini" },
  { id: "opencode/gpt-5", name: "GPT 5" },
  { id: "opencode/gpt-5-codex", name: "GPT 5 Codex" },
  { id: "opencode/gpt-5-nano", name: "GPT 5 Nano" },
  { id: "opencode/claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { id: "opencode/claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
  { id: "opencode/claude-sonnet-4", name: "Claude Sonnet 4" },
  { id: "opencode/claude-opus-4-8", name: "Claude Opus 4.8" },
  { id: "opencode/claude-opus-4-7", name: "Claude Opus 4.7" },
  { id: "opencode/claude-opus-4-6", name: "Claude Opus 4.6" },
  { id: "opencode/claude-opus-4-5", name: "Claude Opus 4.5" },
  { id: "opencode/claude-opus-4-1", name: "Claude Opus 4.1" },
  { id: "opencode/claude-haiku-4-5", name: "Claude Haiku 4.5" },
  { id: "opencode/gemini-3.5-flash", name: "Gemini 3.5 Flash" },
  { id: "opencode/gemini-3.1-pro", name: "Gemini 3.1 Pro" },
  { id: "opencode/gemini-3-flash", name: "Gemini 3 Flash" },
  { id: "opencode/grok-build-0.1", name: "Grok Build 0.1" },
  { id: "opencode/glm-5.1", name: "GLM 5.1" },
  { id: "opencode/glm-5", name: "GLM 5" },
  { id: "opencode/kimi-k2.6", name: "Kimi K2.6" },
  { id: "opencode/kimi-k2.5", name: "Kimi K2.5" },
  { id: "opencode/minimax-m2.7", name: "MiniMax M2.7" },
  { id: "opencode/minimax-m2.5", name: "MiniMax M2.5" },
  { id: "opencode/qwen3.6-plus", name: "Qwen 3.6 Plus" },
  { id: "opencode/qwen3.5-plus", name: "Qwen 3.5 Plus" },
  { id: "opencode/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
  { id: "opencode/big-pickle", name: "Big Pickle" },
  { id: "opencode/deepseek-v4-flash-free", name: "DeepSeek V4 Flash Free" },
  { id: "opencode/mimo-v2.5-free", name: "MiMo V2.5 Free" },
  { id: "opencode/nemotron-3-ultra-free", name: "Nemotron 3 Ultra Free" },
  { id: "opencode/north-mini-code-free", name: "North Mini Code Free" },
  // OpenCode Go (https://opencode.ai/zen/go/v1/models)
  { id: "opencode-go/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
  { id: "opencode-go/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
  { id: "opencode-go/glm-5.1", name: "GLM 5.1" },
  { id: "opencode-go/glm-5", name: "GLM 5" },
  { id: "opencode-go/kimi-k2.6", name: "Kimi K2.6" },
  { id: "opencode-go/kimi-k2.5", name: "Kimi K2.5" },
  { id: "opencode-go/mimo-v2.5", name: "MiMo V2.5" },
  { id: "opencode-go/mimo-v2.5-pro", name: "MiMo V2.5 Pro" },
  { id: "opencode-go/mimo-v2-pro", name: "MiMo V2 Pro" },
  { id: "opencode-go/mimo-v2-omni", name: "MiMo V2 Omni" },
  { id: "opencode-go/minimax-m3", name: "MiniMax M3" },
  { id: "opencode-go/minimax-m2.7", name: "MiniMax M2.7" },
  { id: "opencode-go/minimax-m2.5", name: "MiniMax M2.5" },
  { id: "opencode-go/qwen3.7-max", name: "Qwen 3.7 Max" },
  { id: "opencode-go/qwen3.7-plus", name: "Qwen 3.7 Plus" },
  { id: "opencode-go/qwen3.6-plus", name: "Qwen 3.6 Plus" },
  { id: "opencode-go/qwen3.5-plus", name: "Qwen 3.5 Plus" },
  { id: "opencode-go/hy3-preview", name: "Hy3 Preview" },
];

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
      ...(opts.effort ? ["--variant", opts.effort] : []),
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
