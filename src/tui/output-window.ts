/**
 * Pure line-wrapping + scroll-window math for the live step-output pane.
 * Kept UI-free so the drill-in view and the keyboard handler share one model:
 * the view renders a window over the wrapped lines, the keys move it.
 */

export interface OutputScroll {
  /** First visible wrapped line; ignored while `follow` is true. */
  offset: number;
  /** Stick to the newest output (the bottom) as it streams in. */
  follow: boolean;
}

/** Follow the stream by default — new output stays in view while it runs. */
export const initialOutputScroll: OutputScroll = { offset: 0, follow: true };

/** Start at the top, no following — for finished/recorded output. */
export const staticOutputScroll: OutputScroll = { offset: 0, follow: false };

/**
 * Hard cap on wrapped display lines. A step can stream megabytes; the pane only
 * ever needs the newest lines, and re-wrapping an unbounded transcript every
 * render would hitch the TUI. The oldest lines fall off with a marker.
 */
export const MAX_OUTPUT_LINES = 5000;

/**
 * Split `text` into display lines hard-wrapped at `width` columns. Keeps blank
 * lines (they carry paragraph structure) and never returns an empty array for
 * non-empty text. Capped at {@link MAX_OUTPUT_LINES}, newest lines win.
 */
export function wrapOutputLines(text: string, width: number): string[] {
  const cols = Math.max(4, width);
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    // Tabs render with unpredictable widths in a column budget; normalize.
    const line = raw.replace(/\t/g, "  ");
    if (line.length <= cols) {
      out.push(line);
      continue;
    }
    for (let i = 0; i < line.length; i += cols) out.push(line.slice(i, i + cols));
  }
  if (out.length > MAX_OUTPUT_LINES) {
    const dropped = out.length - MAX_OUTPUT_LINES;
    return [
      `… ${dropped} earlier line${dropped === 1 ? "" : "s"} trimmed …`,
      ...out.slice(dropped),
    ];
  }
  return out;
}

export interface OutputWindow {
  visible: string[];
  /** Index of the first visible line. */
  start: number;
  /** One past the last visible line. */
  end: number;
  total: number;
  /** True when the window is pinned to the newest line. */
  atBottom: boolean;
}

/** The largest valid `offset` for a given total/budget. */
function maxOffset(total: number, budget: number): number {
  return Math.max(0, total - Math.max(1, budget));
}

/** Pick the visible slice of `lines` for the current scroll state. */
export function selectOutputWindow(
  lines: readonly string[],
  scroll: OutputScroll,
  budget: number,
): OutputWindow {
  const total = lines.length;
  const size = Math.max(1, budget);
  const bottom = maxOffset(total, size);
  const start = scroll.follow ? bottom : Math.min(Math.max(0, scroll.offset), bottom);
  const end = Math.min(total, start + size);
  return {
    visible: lines.slice(start, end),
    start,
    end,
    total,
    atBottom: end >= total,
  };
}

/** Relative or absolute scroll motions the keyboard can request. */
export type OutputScrollDelta = number | "top" | "bottom";

/**
 * Apply a scroll motion. Scrolling to (or past) the bottom re-engages follow
 * mode, so streaming output resumes auto-scrolling; any upward motion pins the
 * window where the reader put it.
 */
export function scrollOutputBy(
  scroll: OutputScroll,
  delta: OutputScrollDelta,
  total: number,
  budget: number,
): OutputScroll {
  const bottom = maxOffset(total, budget);
  if (delta === "top") return { offset: 0, follow: false };
  if (delta === "bottom") return { offset: bottom, follow: true };
  const current = scroll.follow ? bottom : Math.min(scroll.offset, bottom);
  const next = Math.min(Math.max(0, current + delta), bottom);
  return { offset: next, follow: next >= bottom };
}
