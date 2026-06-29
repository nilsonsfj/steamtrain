import type { AgentEvent, AgentInstanceId } from "../types/events";

/**
 * The display model. It mirrors the normalized events but coalesces a run of
 * `text_delta` events into a single growing `text` item, so streaming output
 * renders as one paragraph that grows in place instead of one row per token.
 */
export type DisplayItem =
  | {
      id: number;
      kind: "session_start";
      agent: AgentInstanceId;
      sessionId?: string;
      model?: string;
      toolCount?: number;
    }
  | { id: number; kind: "text"; agent: AgentInstanceId; text: string; thinking: boolean }
  | {
      id: number;
      kind: "tool_use";
      agent: AgentInstanceId;
      name: string;
      input?: unknown;
      status?: string;
    }
  | {
      id: number;
      kind: "tool_result";
      agent: AgentInstanceId;
      name?: string;
      output?: string;
      isError?: boolean;
    }
  | {
      id: number;
      kind: "result";
      agent: AgentInstanceId;
      isError: boolean;
      text?: string;
      subtype?: string;
      durationMs?: number;
      costUsd?: number;
    }
  | { id: number; kind: "error"; agent: AgentInstanceId; message: string }
  | { id: number; kind: "notice"; level: "info" | "warn" | "error"; text: string }
  | { id: number; kind: "unknown"; agent: AgentInstanceId; rawType?: string };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type DisplayItemData = DistributiveOmit<DisplayItem, "id">;

export interface TranscriptState {
  items: DisplayItem[];
  nextId: number;
}

export type TranscriptAction =
  | { type: "event"; event: AgentEvent }
  | { type: "notice"; level: "info" | "warn" | "error"; text: string }
  | { type: "reset" };

export const initialTranscript: TranscriptState = { items: [], nextId: 0 };

const MAX_TRANSCRIPT_ITEMS = 2000;

function push(state: TranscriptState, data: DisplayItemData): TranscriptState {
  const item = { id: state.nextId, ...data } as DisplayItem;
  const items = [...state.items, item];
  const trimmed =
    items.length > MAX_TRANSCRIPT_ITEMS ? items.slice(items.length - MAX_TRANSCRIPT_ITEMS) : items;
  return { items: trimmed, nextId: state.nextId + 1 };
}

function applyEvent(state: TranscriptState, e: AgentEvent): TranscriptState {
  if (e.kind === "text_delta") {
    const last = state.items[state.items.length - 1];
    const thinking = Boolean(e.thinking);
    if (last && last.kind === "text" && last.thinking === thinking && last.agent === e.agent) {
      const merged: DisplayItem = { ...last, text: last.text + e.text };
      return { ...state, items: [...state.items.slice(0, -1), merged] };
    }
    return push(state, { kind: "text", agent: e.agent, text: e.text, thinking });
  }

  switch (e.kind) {
    case "session_start":
      return push(state, {
        kind: "session_start",
        agent: e.agent,
        sessionId: e.sessionId,
        model: e.model,
        toolCount: e.tools?.length,
      });
    case "tool_use":
      return push(state, {
        kind: "tool_use",
        agent: e.agent,
        name: e.name,
        input: e.input,
        status: e.status,
      });
    case "tool_result":
      return push(state, {
        kind: "tool_result",
        agent: e.agent,
        name: e.name,
        output: e.output,
        isError: e.isError,
      });
    case "result":
      return push(state, {
        kind: "result",
        agent: e.agent,
        isError: e.isError,
        text: e.text,
        subtype: e.subtype,
        durationMs: e.durationMs,
        costUsd: e.costUsd,
      });
    case "error":
      return push(state, { kind: "error", agent: e.agent, message: e.message });
    case "unknown":
      return push(state, { kind: "unknown", agent: e.agent, rawType: e.rawType });
    default:
      return state;
  }
}

export function transcriptReducer(
  state: TranscriptState,
  action: TranscriptAction,
): TranscriptState {
  switch (action.type) {
    case "reset":
      return initialTranscript;
    case "notice":
      return push(state, { kind: "notice", level: action.level, text: action.text });
    case "event":
      return applyEvent(state, action.event);
    default:
      return state;
  }
}
