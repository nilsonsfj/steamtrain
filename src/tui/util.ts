/**
 * Extracts the message from an error object, falling back to string coercion.
 */
export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Rows the fixed chrome around the event stream always occupies: status bar,
 * task-selector legend, the bordered prompt input, and the hint line.
 */
const BASE_RESERVED_ROWS = 9;

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
}): number {
  const { rows, columns, promptValueLength, notice } = opts;
  // Prompt wrapping: border(2) + padding(2) + prefix("❯ " = 2) = 6 columns overhead.
  const promptAreaWidth = Math.max(1, columns - 6);
  const promptTextLen = promptValueLength + 1; // +1 for cursor
  const promptExtraLines = wrappedLines(promptTextLen, promptAreaWidth) - 1;
  // Notice renders inside a `paddingX={1}` box, so it wraps at columns - 2.
  const noticeLines = notice ? wrappedLines(notice.length, Math.max(1, columns - 2)) : 0;
  return Math.max(6, rows - BASE_RESERVED_ROWS - promptExtraLines - noticeLines);
}
