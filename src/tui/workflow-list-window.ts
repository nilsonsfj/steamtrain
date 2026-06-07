export interface VisibleWindow<T> {
  visible: T[];
  start: number;
  hiddenBefore: number;
  hiddenAfter: number;
}

/**
 * Pick a bounded window that keeps the selected row visible. The budget includes
 * optional hidden-row markers, so callers can render without overflowing.
 */
export function selectVisibleWindow<T>(
  items: readonly T[],
  selectedIndex: number,
  budget: number,
): VisibleWindow<T> {
  if (items.length === 0 || budget <= 0) {
    return { visible: [], start: 0, hiddenBefore: 0, hiddenAfter: 0 };
  }

  const selected = Math.min(Math.max(0, selectedIndex), items.length - 1);
  const totalBudget = Math.max(1, budget);
  let itemBudget = totalBudget;
  let window = computeWindow(items, selected, itemBudget);

  for (let i = 0; i < 2; i += 1) {
    const markerRows = (window.hiddenBefore > 0 ? 1 : 0) + (window.hiddenAfter > 0 ? 1 : 0);
    itemBudget = Math.max(1, totalBudget - markerRows);
    window = computeWindow(items, selected, itemBudget);
  }

  return window;
}

function computeWindow<T>(
  items: readonly T[],
  selectedIndex: number,
  budget: number,
): VisibleWindow<T> {
  const clampedBudget = Math.max(1, Math.min(budget, items.length));
  let start = Math.max(0, selectedIndex - Math.floor(clampedBudget / 2));
  let end = Math.min(items.length, start + clampedBudget);
  start = Math.max(0, end - clampedBudget);
  end = Math.min(items.length, start + clampedBudget);

  return {
    visible: items.slice(start, end),
    start,
    hiddenBefore: start,
    hiddenAfter: items.length - end,
  };
}
