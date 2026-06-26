import type { AgentEvent, AgentId } from "../types/events";
import type { GateStep, StepResult, WorkflowItem, WorkflowStepKind } from "./types";

/**
 * The workflow-level event stream the TUI consumes. It wraps the per-step
 * `AgentEvent`s (tagged with their step) and adds the phase/step lifecycle, so
 * a reducer can build the live phase → step tree.
 */

/**
 * Loop iteration tag shared by every event emitted from inside a loop body.
 * 1-based; omitted ⇒ 1 (no loop / first pass). Centralized here so the
 * "omitted ⇒ 1" convention and the docstring live in one place instead of
 * being copy-pasted across seven event interfaces.
 */
export interface IterationTagged {
  /** Loop iteration (1-based); omitted ⇒ 1 (no loop / first pass). */
  iteration?: number;
}

export interface WorkflowStartEvent {
  kind: "workflow_start";
  name: string;
  phaseCount: number;
  stepCount: number;
  ts: number;
}

export interface PhaseStartEvent extends IterationTagged {
  kind: "phase_start";
  phaseId: string;
  title: string;
  /** Zero-based position in the spec. */
  index: number;
  stepCount: number;
  ts: number;
}

export interface StepStartEvent extends IterationTagged {
  kind: "step_start";
  phaseId: string;
  stepId: string;
  blockKind?: WorkflowStepKind;
  agent?: AgentId;
  model?: string;
  effort?: string;
  cwd?: string;
  /** Earlier steps whose outputs feed this step (for data-flow display). */
  dependsOn?: string[];
  /** Parent dynamic `forEach` step, when this is a generated child run. */
  parentStepId?: string;
  /** Work item assigned to this generated child run. */
  item?: WorkflowItem;
  /** A loop-back gate's target phase, when this step is such a gate. */
  loopTo?: string;
  /** The gate's own iteration cap, when this step is a loop-back gate. */
  maxIterations?: number;
  ts: number;
}

/**
 * A dynamic `forEach` step has resolved its work items and is about to dispatch
 * `count` child runs. Emitted *before* the children's `step_start`s so consumers
 * know the true fan-out cardinality up front — otherwise a run canceled
 * mid-fan-out would only ever reveal the children that happened to start (the
 * pool dispatches them lazily, bounded by concurrency).
 */
export interface FanOutEvent extends IterationTagged {
  kind: "fan_out";
  phaseId: string;
  /** The `forEach` step expanding into children. */
  parentStepId: string;
  /** Number of child runs this step expands into. */
  count: number;
  ts: number;
}

/** One normalized agent event, attributed to the step that produced it. */
export interface StepStreamEvent extends IterationTagged {
  kind: "step_event";
  phaseId: string;
  stepId: string;
  event: AgentEvent;
  ts: number;
}

export interface StepDoneEvent extends IterationTagged {
  kind: "step_done";
  phaseId: string;
  stepId: string;
  result: StepResult;
  /** True when replayed from memory/disk cache (resume), not a fresh agent run. */
  cached: boolean;
  ts: number;
}

/**
 * A retryable (transient, side-effect-free) agent failure occurred and the step
 * is about to back off and try again. Emitted *after* the failed attempt and
 * *before* the backoff sleep. `attempt` is the 1-based attempt that just failed;
 * `delayMs` is the upcoming wait.
 */
export interface StepRetryEvent extends IterationTagged {
  kind: "step_retry";
  phaseId: string;
  stepId: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
  ts: number;
}

export interface GateEvaluatedEvent extends IterationTagged {
  kind: "gate_evaluated";
  phaseId: string;
  stepId: string;
  passed: boolean;
  target?: string;
  onFalse?: GateStep["onFalse"];
  ts: number;
}

export interface PhaseDoneEvent extends IterationTagged {
  kind: "phase_done";
  phaseId: string;
  ok: boolean;
  ts: number;
}

export interface WorkflowDoneEvent {
  kind: "workflow_done";
  ok: boolean;
  results: StepResult[];
  ts: number;
}

/**
 * A loop-back gate's condition was not met and the iteration budget still
 * remains, so execution is about to jump back to `loopTo` and re-run the body.
 * `iteration` is the iteration that is ABOUT TO START (2 = the first re-run).
 */
export interface LoopIterationEvent {
  kind: "loop_iteration";
  gateStepId: string;
  loopTo: string;
  iteration: number;
  maxIterations: number;
  ts: number;
}

export type WorkflowEvent =
  | WorkflowStartEvent
  | PhaseStartEvent
  | StepStartEvent
  | FanOutEvent
  | StepStreamEvent
  | StepRetryEvent
  | GateEvaluatedEvent
  | StepDoneEvent
  | PhaseDoneEvent
  | WorkflowDoneEvent
  | LoopIterationEvent;

export type WorkflowEventKind = WorkflowEvent["kind"];
