/**
 * Build the live workflow tree rows, collapsing long runs of pending fan-out
 * children so a 30-way distributor does not drown the viewport.
 */

import type { PhaseState, StepState } from "./workflow-state";

export type WorkflowTreeRow =
  | { kind: "phase"; phase: PhaseState }
  | { kind: "step"; phase: PhaseState; step: StepState; flatIndex: number }
  | {
      kind: "collapsed";
      phase: PhaseState;
      /** Shared parent of the collapsed fan-out children. */
      parentStepId: string;
      /** Inclusive flat-index range covered by this summary row. */
      fromFlatIndex: number;
      toFlatIndex: number;
      count: number;
      firstStepId: string;
      lastStepId: string;
    };

/** Collapse a pending fan-out run once it reaches this many consecutive siblings. */
export const FANOUT_COLLAPSE_THRESHOLD = 3;

/**
 * Flatten phases into display rows. Consecutive pending children of the same
 * parent (typical forEach fan-out) collapse into one summary row when the run
 * is long enough and none of them is selected. The selected step always stays
 * expanded so ↑/↓ navigation remains one-step-at-a-time through the group.
 */
export function buildWorkflowTreeRows(
  phases: readonly PhaseState[],
  selectedFlatIndex: number,
  threshold = FANOUT_COLLAPSE_THRESHOLD,
): WorkflowTreeRow[] {
  const out: WorkflowTreeRow[] = [];
  let flatIndex = 0;

  for (const phase of phases) {
    out.push({ kind: "phase", phase });
    let i = 0;
    while (i < phase.steps.length) {
      const step = phase.steps[i]!;
      const parentId = step.parentStepId;
      if (!parentId || step.status !== "pending" || threshold < 2) {
        out.push({ kind: "step", phase, step, flatIndex });
        flatIndex += 1;
        i += 1;
        continue;
      }

      // Gather the longest pending run sharing this parent.
      let j = i;
      while (
        j < phase.steps.length &&
        phase.steps[j]!.parentStepId === parentId &&
        phase.steps[j]!.status === "pending"
      ) {
        j += 1;
      }
      const runLen = j - i;
      if (runLen < threshold) {
        for (let k = i; k < j; k += 1) {
          out.push({ kind: "step", phase, step: phase.steps[k]!, flatIndex });
          flatIndex += 1;
        }
        i = j;
        continue;
      }

      // Split the run around the selection so the focused step stays visible.
      const runStartFlat = flatIndex;
      const runEndFlat = flatIndex + runLen - 1;
      const selectedInRun =
        selectedFlatIndex >= runStartFlat && selectedFlatIndex <= runEndFlat
          ? selectedFlatIndex
          : -1;

      if (selectedInRun < 0) {
        pushCollapsed(out, phase, parentId, phase.steps.slice(i, j), runStartFlat);
        flatIndex += runLen;
        i = j;
        continue;
      }

      const beforeCount = selectedInRun - runStartFlat;
      const afterCount = runEndFlat - selectedInRun;
      if (beforeCount >= threshold) {
        pushCollapsed(out, phase, parentId, phase.steps.slice(i, i + beforeCount), runStartFlat);
      } else {
        for (let k = 0; k < beforeCount; k += 1) {
          out.push({
            kind: "step",
            phase,
            step: phase.steps[i + k]!,
            flatIndex: runStartFlat + k,
          });
        }
      }
      out.push({
        kind: "step",
        phase,
        step: phase.steps[i + beforeCount]!,
        flatIndex: selectedInRun,
      });
      if (afterCount >= threshold) {
        pushCollapsed(
          out,
          phase,
          parentId,
          phase.steps.slice(i + beforeCount + 1, j),
          selectedInRun + 1,
        );
      } else {
        for (let k = 1; k <= afterCount; k += 1) {
          out.push({
            kind: "step",
            phase,
            step: phase.steps[i + beforeCount + k]!,
            flatIndex: selectedInRun + k,
          });
        }
      }
      flatIndex += runLen;
      i = j;
    }
  }

  return out;
}

/**
 * Map a flat step index onto a row index in the (possibly collapsed) tree.
 * Collapsed summaries that cover the selection count as that step's row.
 * Returns -1 when nothing matches (caller should fall back).
 */
export function findTreeRowIndex(rows: readonly WorkflowTreeRow[], flatIndex: number): number {
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (row.kind === "step" && row.flatIndex === flatIndex) return i;
    if (
      row.kind === "collapsed" &&
      flatIndex >= row.fromFlatIndex &&
      flatIndex <= row.toFlatIndex
    ) {
      return i;
    }
  }
  return -1;
}

function pushCollapsed(
  out: WorkflowTreeRow[],
  phase: PhaseState,
  parentStepId: string,
  steps: StepState[],
  fromFlatIndex: number,
): void {
  if (steps.length === 0) return;
  const first = steps[0]!;
  const last = steps[steps.length - 1]!;
  out.push({
    kind: "collapsed",
    phase,
    parentStepId,
    fromFlatIndex,
    toFlatIndex: fromFlatIndex + steps.length - 1,
    count: steps.length,
    firstStepId: first.stepId,
    lastStepId: last.stepId,
  });
}
