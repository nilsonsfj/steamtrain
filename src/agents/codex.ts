import type { AgentEvent, AgentId, EventMapper } from "../types/events";
import { type CodexThreadItem, codexEnvelope, codexEvent } from "../types/raw-codex";
import { type AgentAdapter, type AgentRunOptions, runAgentProcess } from "./adapter";
import type { AgentModel } from "./agent-model";
import { stringifyContent } from "./util";

const AGENT: AgentId = "codex";

/** Known Codex models (plain slugs; used by `/model` and autocomplete). */
export const CODEX_MODELS: readonly AgentModel[] = [
  { id: "gpt-5.5", name: "GPT-5.5" },
  { id: "gpt-5.4", name: "GPT-5.4" },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
  { id: "gpt-5.2", name: "GPT-5.2" },
  { id: "codex-auto-review", name: "Codex Auto Review" },
];

const COMMAND_DONE = new Set(["completed", "done", "success", "finished"]);
const COMMAND_FAILED = new Set(["failed", "error", "declined"]);

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "codex error";
}

/**
 * Build a mapper for one Codex run. Like OpenCode, Codex is **stateful**:
 *
 *  - agent_message/reasoning items may stream via `item.updated`, so we diff
 *    cumulative text per item id and emit only the new suffix;
 *  - command/tool items emit `tool_use` once when they start and `tool_result`
 *    once when they complete (dedup by item id).
 *
 * Create a fresh mapper per run so this state never leaks between tasks.
 */
export function createCodexMapper(agent: AgentId = AGENT): EventMapper {
  const textSeen = new Map<string, string>();
  const toolStarted = new Set<string>();
  const toolFinished = new Set<string>();

  const diff = (key: string, full: string): string => {
    const prev = textSeen.get(key) ?? "";
    const delta = full.startsWith(prev) ? full.slice(prev.length) : full;
    textSeen.set(key, full);
    return delta;
  };

  const handleTextItem = (item: CodexThreadItem, ts: number, out: AgentEvent[]): void => {
    const text = item.text ?? "";
    if (!text) return;
    const key = item.id ?? item.type ?? "text";
    const thinking = item.type === "reasoning";
    const delta = diff(key, text);
    if (delta) out.push({ kind: "text_delta", agent, ts, text: delta, thinking });
  };

  const emitCommandResult = (item: CodexThreadItem, ts: number, out: AgentEvent[]): void => {
    const id = item.id ?? item.command ?? "command";
    if (toolFinished.has(id)) return;
    toolFinished.add(id);

    const name = item.command ? "command_execution" : "tool";
    const status = item.status;
    const failed = status !== undefined && COMMAND_FAILED.has(status);
    const output = item.aggregated_output ?? stringifyContent(item.result ?? item.error);
    out.push({
      kind: "tool_result",
      agent,
      ts,
      id,
      name,
      output,
      isError: failed || (item.exit_code != null && item.exit_code !== 0),
      status,
    });
  };

  const handleCommandItem = (
    item: CodexThreadItem,
    ts: number,
    out: AgentEvent[],
    terminal: boolean,
  ): void => {
    const id = item.id ?? item.command ?? "command";
    const name = item.command ? "command_execution" : "tool";
    const status = item.status;

    if (!terminal) {
      if (status !== undefined && (COMMAND_DONE.has(status) || COMMAND_FAILED.has(status))) {
        emitCommandResult(item, ts, out);
        return;
      }
      // undefined, a running status, OR an unrecognized status: surface a tool
      // start. An unknown future status must never be silently dropped — the
      // invocation has to stay visible (e.g. so retry never treats a step that
      // already ran a tool as a clean, retryable transport failure).
      if (!toolStarted.has(id)) {
        toolStarted.add(id);
        out.push({
          kind: "tool_use",
          agent,
          ts,
          id,
          name,
          input: item.command ? { command: item.command } : item.arguments,
          status,
        });
      }
      return;
    }

    emitCommandResult(item, ts, out);
  };

  const emitMcpResult = (item: CodexThreadItem, ts: number, out: AgentEvent[]): void => {
    const id = item.id ?? `${item.server ?? "mcp"}/${item.tool ?? "tool"}`;
    if (toolFinished.has(id)) return;
    toolFinished.add(id);

    const name = item.tool ?? "mcp_tool_call";
    const failed = item.status !== undefined && COMMAND_FAILED.has(item.status);
    out.push({
      kind: "tool_result",
      agent,
      ts,
      id,
      name,
      output: stringifyContent(item.result ?? item.error),
      isError: failed || item.error != null,
      status: item.status,
    });
  };

  const handleMcpItem = (
    item: CodexThreadItem,
    ts: number,
    out: AgentEvent[],
    terminal: boolean,
  ): void => {
    const id = item.id ?? `${item.server ?? "mcp"}/${item.tool ?? "tool"}`;
    const name = item.tool ?? "mcp_tool_call";

    if (!terminal) {
      if (
        item.status !== undefined &&
        (COMMAND_DONE.has(item.status) || COMMAND_FAILED.has(item.status))
      ) {
        emitMcpResult(item, ts, out);
        return;
      }
      // undefined, a running status, OR an unrecognized status: surface a tool
      // start so an unknown future status is never silently dropped.
      if (!toolStarted.has(id)) {
        toolStarted.add(id);
        out.push({
          kind: "tool_use",
          agent,
          ts,
          id,
          name,
          input: item.arguments,
          status: item.status,
        });
      }
      return;
    }

    emitMcpResult(item, ts, out);
  };

  const handleItem = (
    item: CodexThreadItem,
    ts: number,
    out: AgentEvent[],
    phase: "started" | "updated" | "completed",
  ): void => {
    const terminal = phase === "completed";
    switch (item.type) {
      case "agent_message":
      case "reasoning":
        if (phase !== "started") handleTextItem(item, ts, out);
        return;
      case "command_execution":
        handleCommandItem(item, ts, out, terminal);
        return;
      case "mcp_tool_call":
        handleMcpItem(item, ts, out, terminal);
        return;
      case "error":
        if (terminal) {
          out.push({
            kind: "error",
            agent,
            ts,
            message: item.message ?? item.text ?? "codex item error",
          });
        }
        return;
      default:
        return;
    }
  };

  return (raw: unknown): AgentEvent[] => {
    const ts = Date.now();
    const parsed = codexEvent.safeParse(raw);
    if (!parsed.success) {
      const env = codexEnvelope.safeParse(raw);
      return [
        { kind: "unknown", agent, ts, rawType: env.success ? env.data.type : undefined, raw },
      ];
    }

    const e = parsed.data;
    const out: AgentEvent[] = [];

    switch (e.type) {
      case "thread.started":
        out.push({
          kind: "session_start",
          agent,
          ts,
          sessionId: e.thread_id,
        });
        return out;

      case "turn.started":
        return out;

      case "turn.completed": {
        out.push({
          kind: "result",
          agent,
          ts,
          isError: false,
          subtype: "turn.completed",
        });
        return out;
      }

      case "turn.failed": {
        const message = errorMessage(e.error);
        out.push({ kind: "error", agent, ts, message });
        out.push({
          kind: "result",
          agent,
          ts,
          isError: true,
          subtype: "turn.failed",
          text: message,
        });
        return out;
      }

      case "error": {
        out.push({ kind: "error", agent, ts, message: errorMessage(e.error) });
        return out;
      }

      case "item.started":
        if (e.item) handleItem(e.item, ts, out, "started");
        return out;

      case "item.updated":
        if (e.item) handleItem(e.item, ts, out, "updated");
        return out;

      case "item.completed":
        if (e.item) handleItem(e.item, ts, out, "completed");
        return out;

      default:
        if (out.length === 0) out.push({ kind: "unknown", agent, ts, rawType: e.type, raw });
        return out;
    }
  };
}

/** Build argv for `codex exec --json` (shared by the adapter and tests). */
export function buildCodexExecArgs(opts: AgentRunOptions): string[] {
  return [
    "exec",
    "--json",
    "--sandbox",
    "workspace-write",
    "-c",
    'approval_policy="never"',
    "--skip-git-repo-check",
    "--model",
    opts.model,
    ...(opts.effort ? ["-c", `model_reasoning_effort="${opts.effort}"`] : []),
    ...(opts.extraArgs ?? []),
    opts.prompt,
  ];
}

/** Runs the real `codex` CLI in JSON event mode. */
export class CodexAdapter implements AgentAdapter {
  readonly id: AgentId = AGENT;
  readonly binary: string;

  constructor(binary = "codex") {
    this.binary = binary;
  }

  run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
    return runAgentProcess({
      id: this.id,
      binary: this.binary,
      args: buildCodexExecArgs(opts),
      opts,
      map: createCodexMapper(this.id),
    });
  }
}
