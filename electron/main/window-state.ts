import type { WindowStateShape } from "./store";

/**
 * Restoring window geometry safely.
 *
 * Saved bounds are a claim about a display arrangement that may no longer
 * exist: an external monitor gets unplugged, a laptop is docked somewhere else,
 * a display's resolution changes. Restoring blindly puts the window off-screen,
 * where it cannot be moved back without resetting state the user can't see.
 *
 * So position is only honoured when it still lands on an attached display, and
 * size is always clamped to something that fits.
 */

export const DEFAULT_WIDTH = 1400;
export const DEFAULT_HEIGHT = 900;
export const MIN_WIDTH = 900;
export const MIN_HEIGHT = 600;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How much of the window must be on a display for the position to be kept. */
const VISIBLE_MARGIN = 80;

/**
 * Is enough of `bounds` inside `area` to grab with the pointer?
 *
 * Not containment: a window deliberately hanging off the edge of a screen is
 * fine, and demanding full containment would reject positions the user chose.
 * The test is whether a usable strip of the window overlaps the display.
 */
function sufficientlyVisible(bounds: Rect, area: Rect): boolean {
  const overlapX =
    Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
  const overlapY =
    Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
  return (
    overlapX >= Math.min(VISIBLE_MARGIN, bounds.width) &&
    overlapY >= Math.min(VISIBLE_MARGIN, bounds.height)
  );
}

export interface RestoredWindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

/**
 * Turn saved state plus the current displays into bounds worth opening.
 *
 * With no saved state, or none that still fits, the result has no `x`/`y` —
 * Electron then centres the window, which is the right first-launch behaviour.
 */
export function restoreWindowState(
  saved: WindowStateShape | undefined,
  displays: readonly Rect[],
): RestoredWindowState {
  if (!saved) {
    return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, maximized: false };
  }

  // The largest display bounds the size: a window restored from a 4K monitor
  // onto a laptop screen has to shrink or it cannot be resized back.
  const widest = Math.max(...displays.map((d) => d.width), MIN_WIDTH);
  const tallest = Math.max(...displays.map((d) => d.height), MIN_HEIGHT);
  const width = Math.min(Math.max(saved.width, MIN_WIDTH), widest);
  const height = Math.min(Math.max(saved.height, MIN_HEIGHT), tallest);

  const { x, y } = saved;
  const position =
    typeof x === "number" &&
    typeof y === "number" &&
    displays.some((area) => sufficientlyVisible({ x, y, width, height }, area))
      ? { x, y }
      : {};

  return { ...position, width, height, maximized: saved.maximized };
}
