/**
 * The normalized, agent-agnostic event model.
 *
 * Every adapter parses its CLI's raw streaming output and maps it onto this
 * discriminated union (discriminant: `kind`). The TUI renders only these
 * shapes, so adding a new agent never touches the UI.
 */

export type AgentProviderId =
  | "claude"
  | "opencode"
  | "codex"
  | "amp"
  | "kiro"
  | "mimo"
  | "kimi"
  | "cursor"
  | "antigravity";

/** Built-in provider identity used by adapters and binary config. */
export type AgentId = AgentProviderId;

/** A configured runnable agent instance id (e.g. opencode-fork). Built-in zero-config ids match providers. */
export type AgentInstanceId = string;

/**
 * API dialect a direct-inference `llm` step speaks: the Anthropic Messages API
 * or the OpenAI chat-completions wire format (which Groq / Together / Ollama /
 * vLLM and most proxies also speak).
 */
export type ApiProviderId = "anthropic" | "openai";

/** A configured API endpoint instance id (e.g. groq). Built-in zero-config ids match providers. */
export type ApiInstanceId = string;

export interface BaseEvent {
  /** Which configured agent instance produced this event. */
  agent: AgentInstanceId;
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

/**
 * Normalized token usage for one agent turn. Every adapter maps its CLI's own
 * usage shape onto these categories so the engine, history, and every UI report
 * tokens the same way regardless of which agent produced them. All fields are
 * optional — an adapter only sets what its CLI reports.
 *
 *  - `input`      uncached prompt/input tokens (cache reads/writes excluded)
 *  - `output`     completion tokens (includes reasoning where the provider bills
 *                 reasoning as output, e.g. Codex — so `reasoning` is a subset,
 *                 not an addition)
 *  - `cacheRead`  input tokens served from the prompt cache (cheaper)
 *  - `cacheWrite` input tokens written to the prompt cache (cache creation)
 *  - `reasoning`  reasoning/thinking tokens, when the provider reports them
 *                 separately (may overlap `output`; never summed into `total`
 *                 on its own)
 */
export interface TokenUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

/**
 * Usage billed *so far* in a turn that is still running — the mid-flight
 * counterpart to {@link ResultEvent}'s totals, so a live UI can show a step's
 * spend while it works instead of only after it finishes.
 *
 * **Increments, not totals.** Each event carries what was billed since the
 * previous one, so a consumer accumulates them (a CLI that reports a running
 * total re-states the same number every message, which would triple-count if
 * summed — an adapter emitting from such a source must difference it first).
 * A `result` event later re-states the whole turn: consumers should let its
 * totals replace what they accumulated rather than add to them, since the two
 * describe the same spend.
 *
 * Adapters only emit this when their CLI reports usage before the end of the
 * turn (Claude Code's per-message `usage`). Everyone else stays terminal-only,
 * and the field is simply absent live — never a zero that reads as "free".
 */
export interface UsageEvent extends BaseEvent {
  kind: "usage";
  /** Tokens billed since the previous `usage` event of this turn. */
  tokens?: TokenUsage;
  /** USD billed since the previous `usage` event, when the CLI prices mid-turn. */
  costUsd?: number;
}

/** The turn finished with a final answer and (optionally) cost/timing/tokens. */
export interface ResultEvent extends BaseEvent {
  kind: "result";
  isError: boolean;
  text?: string;
  subtype?: string;
  durationMs?: number;
  costUsd?: number;
  /** Normalized token usage for this turn, when the agent reports it. */
  tokens?: TokenUsage;
}

/**
 * How the engine / adapters classify an agent failure for retry and mid-flight
 * model failover. Adapters may tag {@link ErrorEvent.category}; otherwise the
 * engine classifies from message / stderr heuristics.
 */
export type AgentFailureKind =
  | "quota"
  | "rate_limit"
  | "auth"
  | "transient"
  | "permanent"
  | "unknown";

/**
 * Alias kept for {@link ErrorEvent.category} call sites — same union as
 * {@link AgentFailureKind}. Prefer `AgentFailureKind` in new code.
 */
export type AgentFailureCategory = AgentFailureKind;

/** A process- or protocol-level failure (non-zero exit, timeout, auth, ...). */
export interface ErrorEvent extends BaseEvent {
  kind: "error";
  message: string;
  stderr?: string;
  code?: number | null;
  /**
   * Optional classification hint from the adapter (e.g. Amp "no credits" →
   * `quota`). The engine falls back to message heuristics when unset.
   */
  category?: AgentFailureKind;
  /**
   * True when the adapter killed the child for a wall-clock (or idle) timeout.
   * The engine uses this to allow mid-flight model failover even after tool
   * use - the process is dead, and declared `fallbackModels` should recover.
   */
  timedOut?: boolean;
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
  | UsageEvent
  | ResultEvent
  | ErrorEvent
  | UnknownEvent;

export type AgentEventKind = AgentEvent["kind"];

/** A function that maps one parsed raw line to zero or more normalized events. */
export type EventMapper = (raw: unknown) => AgentEvent[];
