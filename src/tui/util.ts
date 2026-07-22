import stringWidth from "string-width";

/**
 * Extracts the message from an error object, falling back to string coercion.
 */
export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Truncate `text` to at most `max` terminal columns (Ink / string-width),
 * appending an ellipsis when anything is dropped. Used to pre-fit TUI rows so
 * Ink never soft-wraps them past a fixed frame (wrap overflow bleeds borders
 * onto the next line and flickers the whole screen).
 */
export function truncateToWidth(text: string, max: number): string {
  if (max <= 0) return "";
  if (stringWidth(text) <= max) return text;
  if (max === 1) return "…";
  let out = "";
  for (const ch of text) {
    if (stringWidth(`${out}${ch}…`) > max) break;
    out += ch;
  }
  return `${out}…`;
}

/**
 * Rows the fixed chrome around the event stream always occupies: the status
 * bar (one content line, plus its top and bottom border), the project identity
 * strip beneath it, the task-selector legend, the bordered prompt input, and
 * the hint line. When the status bar shows a second line (its API row), that
 * extra row is reserved separately — see `statusApiLine` below.
 */
const BASE_RESERVED_ROWS = 10;

/**
 * How many terminal rows a run of text occupies once wrapped into `width`
 * columns. Always at least one row for non-empty content.
 */
export function wrappedLines(textLength: number, width: number): number {
  const w = Math.max(1, width);
  return Math.max(1, Math.ceil(Math.max(1, textLength) / w));
}

/**
 * Height available to the scrolling event-stream / picker region.
 *
 * Every row rendered outside this region must be reserved here, otherwise the
 * total frame exceeds the terminal height and Ink falls back from in-place
 * diffing to full-screen redraws — which shows up as flicker on every keypress.
 * In particular the red workflow notice line is only present sometimes, so its
 * (possibly wrapped) height has to be subtracted when it is showing.
 */
export function computeStreamHeight(opts: {
  rows: number;
  columns: number;
  promptValueLength: number;
  notice?: string | null;
  /** The status bar renders a second (API) line, occupying one extra row. */
  statusApiLine?: boolean;
}): number {
  const { rows, columns, promptValueLength, notice, statusApiLine } = opts;
  // Prompt wrapping: border(2) + padding(2) + prefix("❯ " = 2) = 6 columns overhead.
  const promptAreaWidth = Math.max(1, columns - 6);
  const promptTextLen = promptValueLength + 1; // +1 for cursor
  const promptExtraLines = wrappedLines(promptTextLen, promptAreaWidth) - 1;
  // Notice renders inside a `paddingX={1}` box, so it wraps at columns - 2.
  const noticeLines = notice ? wrappedLines(notice.length, Math.max(1, columns - 2)) : 0;
  const statusApiLines = statusApiLine ? 1 : 0;
  return Math.max(6, rows - BASE_RESERVED_ROWS - promptExtraLines - noticeLines - statusApiLines);
}
