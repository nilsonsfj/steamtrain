/**
 * Pure presentation math for the live workflow execution view. Kept UI-free so
 * the renderer stays a thin layer and the tricky parts (progress-bar cell
 * allocation, fixed-height budgeting, selection follow) are unit-testable.
 */

import type { StepState, WorkflowState } from "./workflow-state";

/** Why a reducer-level running step is currently blocked on the user. */
export type StepWaitKind = "approval" | "input";

export function stepWaitKind(step: StepState): StepWaitKind | undefined {
  if (step.approval?.pending) return "approval";
  if (step.humanInput?.pending) return "input";
  return undefined;
}

/** Step tallies the header, progress bar, and summary lines are built from. */
export interface RunProgress {
  total: number;
  doneOk: number;
  failed: number;
  running: number;
  waiting: number;
  pending: number;
  cached: number;
}

export function summarizeRun(flat: readonly { step: StepState }[]): RunProgress {
  const p: RunProgress = {
    total: flat.length,
    doneOk: 0,
    failed: 0,
    running: 0,
    waiting: 0,
    pending: 0,
    cached: 0,
  };
  for (const { step } of flat) {
    if (step.status === "done") p.doneOk += 1;
    else if (step.status === "error") p.failed += 1;
    else if (stepWaitKind(step)) p.waiting += 1;
    else if (step.status === "running") p.running += 1;
    else p.pending += 1;
    if (step.cached) p.cached += 1;
  }
  return p;
}

/** One colored run of cells in the progress bar. */
export interface BarSegment {
  kind: "done" | "failed" | "running" | "waiting" | "pending";
  cells: number;
}

/**
 * Allocate exactly `width` bar cells across the five display states, proportional
 * to their counts. Cumulative rounding guarantees the cells sum to `width`; a
 * non-zero category is guaranteed at least one cell (a single failure must
 * never round away) by stealing from the largest allocation. When `width` is
 * smaller than the number of non-empty categories that guarantee is impossible;
 * the largest categories then get one cell each.
 */
export function progressBarSegments(progress: RunProgress, width: number): BarSegment[] {
  const kinds = [
    { kind: "done" as const, count: progress.doneOk },
    { kind: "failed" as const, count: progress.failed },
    { kind: "running" as const, count: progress.running },
    { kind: "waiting" as const, count: progress.waiting },
    { kind: "pending" as const, count: progress.pending },
  ];
  if (width <= 0) return [];
  if (progress.total === 0) return [{ kind: "pending", cells: width }];
  const nonEmpty = kinds.map((k, index) => ({ ...k, index })).filter((k) => k.count > 0);
  if (width < nonEmpty.length) {
    const cells = kinds.map(() => 0);
    for (const winner of [...nonEmpty].sort((a, b) => b.count - a.count).slice(0, width)) {
      cells[winner.index] = 1;
    }
    return kinds
      .map((k, i) => ({ kind: k.kind, cells: cells[i]! }))
      .filter((segment) => segment.cells > 0);
  }
  const cells: number[] = [];
  let cum = 0;
  let allocated = 0;
  for (const { count } of kinds) {
    cum += count;
    const upto = Math.round((cum / progress.total) * width);
    cells.push(upto - allocated);
    allocated = upto;
  }
  // Give every non-empty category a visible cell, taking from the largest
  // donor until stable. Converges: with width ≥ non-empty categories, some
  // donor with ≥ 2 cells exists whenever any non-empty category sits at 0
  // (cells sum to width ≥ category count), and each pass fixes at least one
  // zero-category — so the loop runs at most `nonEmpty.length` passes.
  let changed = true;
  while (changed) {
    changed = false;
    for (const { index } of nonEmpty) {
      if (cells[index] !== 0) continue;
      let biggest = 0;
      for (let j = 1; j < cells.length; j += 1) {
        if (cells[j]! > cells[biggest]!) biggest = j;
      }
      if (cells[biggest]! > 1) {
        cells[biggest] = cells[biggest]! - 1;
        cells[index] = 1;
        changed = true;
      }
    }
  }
  return kinds
    .map((k, i) => ({ kind: k.kind, cells: cells[i]! }))
    .filter((segment) => segment.cells > 0);
}

export interface ViewLayoutInput {
  /** Total component height, including its top/bottom border. */
  height: number;
  /** Single-line sections above the tree (header, progress, notices, …). */
  fixedLines: number;
  /** Minimum phase/step-tree rows. Set to 0 only for the final compact fallback. */
  minimumListLines?: number;
  /** Lines an attention card (approval / human input) occupies, or 0. */
  cardLines: number;
  /** Detail-panel lines that always render when a step is selected (rule + meta). */
  detailFixedLines: number;
  /** Preferred number of output-preview lines in the detail panel. */
  desiredPreviewLines: number;
}

export interface ViewLayout {
  /** Rows available to the phase/step tree (normally ≥ 1; 0 in the final compact fallback). */
  listBudget: number;
  /** Output-preview lines the detail panel may render. */
  previewLines: number;
  /** True when even the minimum layout overflows `height` (terminal too short). */
  cramped: boolean;
}

/** Minimum tree rows before the detail preview starts giving lines back. */
const MIN_LIST_ROWS = 4;

/**
 * Cap the phase/step tree so a tall terminal with a large fan-out cannot turn
 * the viewport into a wall of pending rows. Surplus height returns to the
 * detail preview (or sits as slack under overflow:hidden), matching the
 * balanced split WorkflowPreview already uses.
 */
const MAX_LIST_FRACTION = 0.55;

/**
 * Split the fixed component height between the step tree and the detail
 * preview. The preview shrinks first (down to zero) to keep the tree usable;
 * the tree normally keeps one row, but callers may explicitly allow zero for
 * a final compact fallback that preserves blocking controls instead.
 *
 * On tall terminals the tree is also capped at {@link MAX_LIST_FRACTION} of
 * the inner height so scrolling markers stay meaningful and the detail panel
 * retains a usable share.
 */
export function planViewLayout(input: ViewLayoutInput): ViewLayout {
  const inner = input.height - 2; // top + bottom border
  const minimumListLines = Math.max(0, input.minimumListLines ?? 1);
  const available = inner - input.fixedLines - input.cardLines - input.detailFixedLines;
  const preview = Math.max(0, Math.min(input.desiredPreviewLines, available - MIN_LIST_ROWS));
  const listCap = Math.max(minimumListLines, Math.floor(inner * MAX_LIST_FRACTION));
  const listBudget = Math.max(minimumListLines, Math.min(listCap, available - preview));
  // Any rows the tree cannot take (because of the cap) go back to the preview
  // so the detail panel grows instead of leaving a dead gap above the footer.
  const previewLines = Math.max(preview, available - listBudget);
  return {
    listBudget,
    previewLines,
    cramped: available - preview < minimumListLines,
  };
}

/**
 * The step the view should keep in focus while a run streams: the first
 * running step that is not waiting on the user, else the first user-blocked
 * step, else the last step that has progressed past pending, else the current
 * selection. Drives selection auto-follow (until the user navigates).
 */
export function pickFollowIndex(flat: readonly { step: StepState }[], fallback: number): number {
  if (flat.length === 0) return fallback;
  const running = flat.findIndex(
    (f) => f.step.status === "running" && stepWaitKind(f.step) === undefined,
  );
  if (running >= 0) return running;
  const waiting = flat.findIndex((f) => stepWaitKind(f.step) !== undefined);
  if (waiting >= 0) return waiting;
  for (let i = flat.length - 1; i >= 0; i -= 1) {
    if (flat[i]!.step.status !== "pending") return i;
  }
  return fallback;
}

/** The run-level status word + accent color for the header and border. */
export function runStatus(
  state: WorkflowState,
  runningSteps: number,
): {
  word: string;
  color: string;
} {
  if (state.budget) return { word: "budget-exceeded", color: "yellow" };
  if (state.done) {
    return state.ok ? { word: "done", color: "green" } : { word: "failed", color: "red" };
  }
  if ((state.pendingApprovals?.length ?? 0) > 0 || (state.pendingInputs?.length ?? 0) > 0) {
    return { word: "waiting on you", color: "yellow" };
  }
  if (state.paused) {
    return { word: runningSteps > 0 ? "pausing" : "paused", color: "yellow" };
  }
  return { word: "running", color: "cyan" };
}
