export interface VisibleWindow<T> {
  visible: T[];
  start: number;
  hiddenBefore: number;
  hiddenAfter: number;
}

export interface WeightedItem<T> {
  data: T;
  /** Content height in terminal rows (excluding leading spacer). */
  height: number;
}

/** Blank line rendered between consecutive list items. */
export const LIST_ITEM_SPACER = 1;

/**
 * Pick a bounded window that keeps the selected row visible. The budget includes
 * optional hidden-row markers, so callers can render without overflowing.
 *
 * Unit-height lists (workflow tree, history, managers) render rows back-to-back
 * with no blank spacer, so this path must not charge {@link LIST_ITEM_SPACER} —
 * otherwise the fixed-height host box under-fills and shows a dead gap under
 * "↓ N later rows" while more rows could still fit.
 */
export function selectVisibleWindow<T>(
  items: readonly T[],
  selectedIndex: number,
  budget: number,
): VisibleWindow<T> {
  return selectVisibleWindowWeighted(
    items.map((data) => ({ data, height: 1 })),
    selectedIndex,
    budget,
    0,
  );
}

/**
 * Variable-height windowing: each item contributes its content height, plus an
 * optional spacer between consecutive visible items (default
 * {@link LIST_ITEM_SPACER}, used by the workflow picker). Markers cost one row
 * each. Keeps the selection on-screen and grows outward until the budget is full.
 */
export function selectVisibleWindowWeighted<T>(
  items: readonly WeightedItem<T>[],
  selectedIndex: number,
  budget: number,
  itemSpacer: number = LIST_ITEM_SPACER,
): VisibleWindow<T> {
  if (items.length === 0 || budget <= 0) {
    return { visible: [], start: 0, hiddenBefore: 0, hiddenAfter: 0 };
  }

  const selected = Math.min(Math.max(0, selectedIndex), items.length - 1);
  const totalBudget = Math.max(1, budget);
  const spacer = Math.max(0, itemSpacer);

  // Grow from the selection outward, preferring the side with more remaining
  // items when both fit, otherwise the side that still fits.
  let start = selected;
  let end = selected + 1;

  const rangeCost = (from: number, to: number, hideBefore: boolean, hideAfter: boolean): number => {
    let cost = (hideBefore ? 1 : 0) + (hideAfter ? 1 : 0);
    for (let i = from; i < to; i += 1) {
      cost += items[i]!.height;
      if (i > from) cost += spacer;
    }
    return cost;
  };

  // Always include the selection; if it alone (with needed markers) exceeds the
  // budget, still show it — the caller chose a too-small frame.
  while (start > 0 || end < items.length) {
    const hideBefore = start > 0;
    const hideAfter = end < items.length;
    const canGrowUp = start > 0;
    const canGrowDown = end < items.length;

    const costIfUp = canGrowUp
      ? rangeCost(start - 1, end, start - 1 > 0, hideAfter)
      : Number.POSITIVE_INFINITY;
    const costIfDown = canGrowDown
      ? rangeCost(start, end + 1, hideBefore, end + 1 < items.length)
      : Number.POSITIVE_INFINITY;

    const upFits = costIfUp <= totalBudget;
    const downFits = costIfDown <= totalBudget;

    if (!upFits && !downFits) break;

    // Prefer expanding toward the larger remaining side so the window stays
    // roughly centered on the selection when both directions fit.
    if (upFits && downFits) {
      const remainingBefore = start;
      const remainingAfter = items.length - end;
      if (remainingBefore > remainingAfter) {
        start -= 1;
      } else if (remainingAfter > remainingBefore) {
        end += 1;
      } else {
        // Tie: prefer the cheaper expansion, then downward (reading order).
        if (costIfDown <= costIfUp) end += 1;
        else start -= 1;
      }
    } else if (upFits) {
      start -= 1;
    } else {
      end += 1;
    }
  }

  let hiddenBefore = start;
  let hiddenAfter = items.length - end;

  // Tiny-budget guard: if markers push us over, drop the smaller side first.
  let cost = rangeCost(start, end, hiddenBefore > 0, hiddenAfter > 0);
  while (cost > totalBudget && (hiddenBefore > 0 || hiddenAfter > 0)) {
    if (hiddenBefore > 0 && (hiddenAfter === 0 || hiddenBefore <= hiddenAfter)) {
      hiddenBefore = 0;
    } else {
      hiddenAfter = 0;
    }
    cost = rangeCost(start, end, hiddenBefore > 0, hiddenAfter > 0);
  }

  // If still over budget (selection taller than frame), shrink neighbors first.
  while (cost > totalBudget && end - start > 1) {
    if (selected > start && (selected >= end - 1 || start - selected <= end - 1 - selected)) {
      start += 1;
      if (start > 0) hiddenBefore = start;
    } else if (end - 1 > selected) {
      end -= 1;
      hiddenAfter = items.length - end;
    } else {
      break;
    }
    cost = rangeCost(start, end, hiddenBefore > 0, hiddenAfter > 0);
  }

  return {
    visible: items.slice(start, end).map((item) => item.data),
    start,
    hiddenBefore,
    hiddenAfter,
  };
}
