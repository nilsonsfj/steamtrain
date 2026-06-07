export type PromptHistoryByMode = Map<string, string[]>;

export interface PromptHistoryBrowse {
  /** null = live prompt; otherwise index into the mode's history (oldest = 0). */
  browseIndex: number | null;
  /** Input saved when browsing up from the live prompt. */
  draft: string;
}

export const initialPromptHistoryBrowse: PromptHistoryBrowse = {
  browseIndex: null,
  draft: "",
};

/** Append a submitted command to the given tab's history (skips empty and adjacent duplicates). */
export function pushPromptHistory(
  byMode: PromptHistoryByMode,
  mode: string,
  raw: string,
  limit: number,
): PromptHistoryByMode {
  const entry = raw.trim();
  if (entry.length === 0) return byMode;

  const list = byMode.get(mode) ?? [];
  if (list[list.length - 1] === entry) return byMode;

  const next = new Map(byMode);
  const updated = [...list, entry];
  while (updated.length > limit) updated.shift();
  next.set(mode, updated);
  return next;
}

export interface HistoryNavigateResult {
  value: string;
  browseIndex: number | null;
  draft: string;
}

/** Move up/down through history like a terminal. Returns null when nothing changes. */
export function navigatePromptHistory(
  byMode: PromptHistoryByMode,
  browse: PromptHistoryBrowse,
  mode: string,
  currentValue: string,
  direction: "up" | "down",
): HistoryNavigateResult | null {
  const entries = byMode.get(mode) ?? [];
  if (entries.length === 0) return null;

  if (direction === "up") {
    if (browse.browseIndex === null) {
      const idx = entries.length - 1;
      return {
        value: entries[idx]!,
        browseIndex: idx,
        draft: currentValue,
      };
    }
    if (browse.browseIndex > 0) {
      const idx = browse.browseIndex - 1;
      return { value: entries[idx]!, browseIndex: idx, draft: browse.draft };
    }
    return null;
  }

  if (browse.browseIndex === null) return null;
  if (browse.browseIndex < entries.length - 1) {
    const idx = browse.browseIndex + 1;
    return { value: entries[idx]!, browseIndex: idx, draft: browse.draft };
  }
  return { value: browse.draft, browseIndex: null, draft: browse.draft };
}

export interface PromptArrowContext {
  /** When true, ↑/↓ serve a list above the prompt unless the user is editing it. */
  deferToListNavigation: boolean;
  promptEditing: boolean;
}

/** Whether the prompt owns ↑/↓ instead of a list above it. */
export function isPromptArrowActive(
  ctx: PromptArrowContext | undefined,
  _value: string,
  _browse: PromptHistoryBrowse,
): boolean {
  if (!ctx?.deferToListNavigation) return true;
  return ctx.promptEditing;
}

/** Whether ↑ should navigate prompt history instead of other UI (e.g. workflow picker). */
export function shouldPromptHistoryCaptureUp(
  byMode: PromptHistoryByMode,
  mode: string,
  value: string,
  browse: PromptHistoryBrowse,
  ctx?: PromptArrowContext,
): boolean {
  if (!isPromptArrowActive(ctx, value, browse)) return false;
  if (browse.browseIndex !== null) return true;
  if (value.length > 0) return true;
  return (byMode.get(mode)?.length ?? 0) > 0;
}

/** Whether prompt ↑/↓ history navigation is active for the current surface. */
export function shouldPromptHistoryArrows(
  ctx: PromptArrowContext | undefined,
  value = "",
  browse: PromptHistoryBrowse = initialPromptHistoryBrowse,
): boolean {
  return isPromptArrowActive(ctx, value, browse);
}

/** Whether ↓ should navigate prompt history instead of other UI. */
export function shouldPromptHistoryCaptureDown(
  browse: PromptHistoryBrowse,
  ctx?: PromptArrowContext,
  value = "",
): boolean {
  if (!isPromptArrowActive(ctx, value, browse)) return false;
  return browse.browseIndex !== null;
}
