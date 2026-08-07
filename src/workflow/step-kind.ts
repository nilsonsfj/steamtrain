import type {
  AgentRunFields,
  ConsolidatorStep,
  DistributorStep,
  MergeStep,
  WorkerStep,
  WorkflowStep,
  WorkflowStepKind,
} from "./types";

/**
 * Pure, zod-free step-classification helpers and the nesting constant.
 *
 * These live apart from `types.ts` deliberately: `types.ts` constructs its zod
 * schemas at module load, so anything that imports a *value* from it drags the
 * whole zod runtime along. The browser reducer bundle needs these helpers (for
 * the sub-workflow view + override routing) but must NOT ship zod, so they sit
 * in this leaf module — `types.ts` re-exports them for existing importers, and
 * the browser-facing modules import them from here directly.
 */

/** Hard ceiling on nested `workflow` step call-stack depth (cycle/blast-radius backstop). */
export const MAX_WORKFLOW_NESTING_DEPTH = 5;

/** Step kinds whose `prompt` field a mid-run edit (or a postmortem spec fix) may rewrite. */
export const PROMPT_EDITABLE_KINDS: ReadonlySet<string> = new Set([
  "worker",
  "processor",
  "llm",
  "consolidator",
  "approval",
  "human",
]);

/** The concrete kind of a step, defaulting a bare (kind-less) step to `worker`. */
export function workflowStepKind(step: WorkflowStep): WorkflowStepKind {
  return step.kind ?? "worker";
}

/** A step that carries agent-run fields (an agent/model/effort target). */
export type AgentBackedWorkflowStep = WorkflowStep & AgentRunFields;

/**
 * True when a step actually runs a coding agent (and therefore takes an
 * agent/model/effort target). Deterministic block kinds (gate/approval/human/
 * command/llm/workflow) are never agent-backed; distributor/consolidator/merge
 * are agent-backed only when they pin an agent/model/modelClass (or, for merge,
 * `onConflict: "agent"`).
 */
export function isAgentBackedStep(step: WorkflowStep): step is AgentBackedWorkflowStep {
  const kind = workflowStepKind(step);
  if (
    kind === "gate" ||
    kind === "approval" ||
    kind === "human" ||
    kind === "command" ||
    kind === "llm" ||
    kind === "workflow"
  ) {
    return false;
  }
  if (kind === "merge") {
    const merge = step as MergeStep;
    return (
      merge.onConflict === "agent" ||
      typeof merge.agent === "string" ||
      typeof merge.model === "string" ||
      typeof merge.modelClass === "string"
    );
  }
  if (kind === "distributor" || kind === "consolidator") {
    const block = step as DistributorStep | ConsolidatorStep;
    return (
      typeof block.agent === "string" ||
      typeof block.model === "string" ||
      typeof block.modelClass === "string"
    );
  }
  // worker / processor
  const worker = step as WorkerStep;
  return (
    typeof worker.agent === "string" ||
    typeof worker.model === "string" ||
    typeof worker.modelClass === "string"
  );
}
