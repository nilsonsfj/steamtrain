/**
 * Where the window's own chrome ends and the page begins.
 *
 * On macOS the app hides the title bar so the UI runs to the top edge of the
 * window — which puts the close/minimise/zoom controls *inside* the page's own
 * top row. Nothing tells the page that: it draws its wordmark hard against the
 * left edge and the window controls land on top of it.
 *
 * The two halves of that arrangement live in different bundles — main decides
 * to hide the title bar, the preload has to tell the page what hiding it costs
 * — so the decision is shared rather than duplicated, and cannot drift.
 */

/** Platforms where the window controls are drawn over the page. */
export function overlaysTitleBar(platform: NodeJS.Platform): boolean {
  return platform === "darwin";
}

/**
 * Room to leave at the left of the page's first row, in CSS pixels.
 *
 * macOS draws three 12px controls on a 20px pitch starting 20px in, so the last
 * one ends at 72; the remainder is the gap before the app's own content, which
 * would otherwise sit flush against the zoom button.
 */
export const TITLE_BAR_INSET_PX = 82;
