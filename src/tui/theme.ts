import type { DoctorStatus } from "../doctor";

/** Color + glyph for each agent-readiness status in the top status bar. */
export const STATUS_STYLE: Record<DoctorStatus, { color: string; symbol: string; label: string }> =
  {
    ok: { color: "green", symbol: "●", label: "ready" },
    binary_missing: { color: "red", symbol: "●", label: "missing" },
    not_authenticated: { color: "yellow", symbol: "●", label: "auth" },
    unknown_error: { color: "red", symbol: "●", label: "error" },
  };

/** Glyph + color per normalized event/display kind in the stream. */
export const EVENT_STYLE = {
  session_start: { color: "gray", symbol: "▸" },
  text: { color: "white", symbol: "" },
  thinking: { color: "gray", symbol: "💭" },
  tool_use: { color: "yellow", symbol: "⚙" },
  tool_result_ok: { color: "green", symbol: "✓" },
  tool_result_err: { color: "red", symbol: "✗" },
  result_ok: { color: "cyan", symbol: "■" },
  result_err: { color: "red", symbol: "■" },
  error: { color: "red", symbol: "✖" },
  unknown: { color: "gray", symbol: "·" },
  notice_info: { color: "cyan", symbol: "»" },
  notice_warn: { color: "yellow", symbol: "»" },
  notice_error: { color: "red", symbol: "»" },
} as const;

export const AGENT_COLOR: Record<string, string> = {
  claude: "magenta",
  opencode: "blue",
  codex: "green",
  amp: "yellow",
};

/** Ink color for workflow catalog source labels in the picker and preview. */
export const WORKFLOW_SOURCE_COLOR = {
  bundled: "gray",
  user: "blue",
  project: "yellow",
} as const;

/** Solid backdrop for the slash-command completion popup (overlays content above the prompt). */
export const SUGGESTION_MENU_BG = "#1a1a1a";
export const SUGGESTION_MENU_ACTIVE_BG = "#2a2a2a";

/** Active workspace tab name in the event stream header. */
export const TAB_LABEL_COLOR = "#FFFFE0";

/** Standard braille spinner frames for TUI waiting indicators. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
