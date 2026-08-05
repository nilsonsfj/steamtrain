/**
 * Live-pane output resolution for nested / sub-workflow steps.
 *
 * A `kind: "workflow"` step (and each of its forEach children) stays `running`
 * until every nested child finishes, but agent `text_delta` / tool activity
 * land on the namespaced leaves (`babysit[4]::prepare`), never on the
 * container itself. Without bubbling, the Live pane stuck on the container
 * forever shows "no output yet" while the CLI prints continuous agent text.
 */

import { SUBWORKFLOW_STEP_SEPARATOR } from "./overrides";
import { type StepState, type WorkflowState, flattenSteps } from "./reducer";
import { MAX_WORKFLOW_NESTING_DEPTH } from "./step-kind";

/** Steps that own nested work but do not stream their own agent text. */
export function isLiveOutputContainer(step: Pick<StepState, "blockKind">): boolean {
  return step.blockKind === "workflow";
}

/**
 * Nested steps belonging to a workflow-call step. Ids are namespaced as
 * `${parentStepId}::<childId>` (and deeper `::` chains for recursive calls).
 * Also matches direct `parentStepId` links for robustness.
 */
export function nestedStepsOf(state: WorkflowState, parentStepId: string): StepState[] {
  const prefix = `${parentStepId}${SUBWORKFLOW_STEP_SEPARATOR}`;
  const out: StepState[] = [];
  for (const { step } of flattenSteps(state)) {
    if (step.stepId.startsWith(prefix) || step.parentStepId === parentStepId) {
      out.push(step);
    }
  }
  return out;
}

function hasLiveBody(step: StepState): boolean {
  const body = ((step.result?.output ?? step.text) || "").trim();
  return body.length > 0 || Boolean(step.activity);
}

function isActiveLeaf(step: StepState): boolean {
  return step.status === "running" && !isLiveOutputContainer(step);
}

/**
 * The step whose text/activity should fill the Live pane for `step`.
 *
 * Workflow containers resolve to their most relevant nested leaf: prefer a
 * running non-container with output, then any running leaf, then the newest
 * nested step that already produced text/activity. Falls back to `step` when
 * nothing nested has started (or `step` is not a container).
 *
 * Recursion into nested workflow containers is capped at
 * {@link MAX_WORKFLOW_NESTING_DEPTH} (same limit the engine enforces).
 */
export function resolveLiveOutputStep(state: WorkflowState, step: StepState, depth = 0): StepState {
  if (!isLiveOutputContainer(step)) return step;
  if (depth >= MAX_WORKFLOW_NESTING_DEPTH) return step;
  const nested = nestedStepsOf(state, step.stepId);
  if (nested.length === 0) return step;

  const runningWithBody = nested.find((s) => isActiveLeaf(s) && hasLiveBody(s));
  if (runningWithBody) return runningWithBody;

  const runningLeaf = nested.find(isActiveLeaf);
  if (runningLeaf) return runningLeaf;

  for (let i = nested.length - 1; i >= 0; i -= 1) {
    const s = nested[i]!;
    if (!isLiveOutputContainer(s) && hasLiveBody(s)) return s;
  }

  // Nested workflow containers may themselves need another hop (workflow
  // calling a workflow). Prefer the deepest active resolution.
  for (let i = nested.length - 1; i >= 0; i -= 1) {
    const s = nested[i]!;
    if (isLiveOutputContainer(s) && s.status === "running") {
      const deeper = resolveLiveOutputStep(state, s, depth + 1);
      if (deeper !== s) return deeper;
    }
  }

  return step;
}

/**
 * Body shown in the Live / output pane: finished `result.output`, else streamed
 * `text`, else the latest tool `activity` line. Empty string when nothing yet.
 */
export function liveOutputBody(step: StepState): string {
  const body = ((step.result?.output ?? step.text) || "").trim();
  if (body) return body;
  return (step.activity || "").trim();
}
