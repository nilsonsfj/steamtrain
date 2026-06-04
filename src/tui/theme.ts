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
};
