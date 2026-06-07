/**
 * The normalized, agent-agnostic event model.
 *
 * Every adapter parses its CLI's raw streaming output and maps it onto this
 * discriminated union (discriminant: `kind`). The TUI renders only these
 * shapes, so adding a new agent never touches the UI.
 */

export type AgentId = "claude" | "opencode" | "codex";

export interface BaseEvent {
  /** Which agent produced this event. */
  agent: AgentId;
  /** Wall-clock timestamp (ms since epoch) stamped at normalization time. */
  ts: number;
}

/** A session/turn has begun. Carries identifiers the agent reports up front. */
export interface SessionStartEvent extends BaseEvent {
  kind: "session_start";
  sessionId?: string;
  model?: string;
  tools?: string[];
}

/** A chunk of assistant output. `thinking` marks reasoning/thinking streams. */
export interface TextDeltaEvent extends BaseEvent {
  kind: "text_delta";
  text: string;
  thinking?: boolean;
}

/** The agent invoked a tool. */
export interface ToolUseEvent extends BaseEvent {
  kind: "tool_use";
  id?: string;
  name: string;
  input?: unknown;
  status?: string;
}

/** A tool produced a result (or failed). */
export interface ToolResultEvent extends BaseEvent {
  kind: "tool_result";
  id?: string;
  name?: string;
  output?: string;
  isError?: boolean;
  status?: string;
}

/** The turn finished with a final answer and (optionally) cost/timing. */
export interface ResultEvent extends BaseEvent {
  kind: "result";
  isError: boolean;
  text?: string;
  subtype?: string;
  durationMs?: number;
  costUsd?: number;
}

/** A process- or protocol-level failure (non-zero exit, timeout, auth, ...). */
export interface ErrorEvent extends BaseEvent {
  kind: "error";
  message: string;
  stderr?: string;
  code?: number | null;
}

/**
 * A raw event we recognized as valid JSON but whose `type` we don't model.
 * Passthrough instead of crashing — forward-compatible with CLI changes.
 */
export interface UnknownEvent extends BaseEvent {
  kind: "unknown";
  rawType?: string;
  raw: unknown;
}

export type AgentEvent =
  | SessionStartEvent
  | TextDeltaEvent
  | ToolUseEvent
  | ToolResultEvent
  | ResultEvent
  | ErrorEvent
  | UnknownEvent;

export type AgentEventKind = AgentEvent["kind"];

/** A function that maps one parsed raw line to zero or more normalized events. */
export type EventMapper = (raw: unknown) => AgentEvent[];
