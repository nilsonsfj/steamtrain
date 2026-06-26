import type { AgentEvent, AgentId } from "../types/events";
import type { GateStep, StepResult, WorkflowItem, WorkflowStepKind } from "./types";

/**
 * The workflow-level event stream the TUI consumes. It wraps the per-step
 * `AgentEvent`s (tagged with their step) and adds the phase/step lifecycle, so
 * a reducer can build the live phase → step tree.
 */

export interface WorkflowStartEvent {
  kind: "workflow_start";
  name: string;
  phaseCount: number;
  stepCount: number;
  ts: number;
}

export interface PhaseStartEvent {
  kind: "phase_start";
  phaseId: string;
  title: string;
  /** Zero-based position in the spec. */
  index: number;
  stepCount: number;
  /** Loop iteration (1-based); omitted ⇒ 1 (no loop). */
  iteration?: number;
  ts: number;
}

export interface StepStartEvent {
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
  /** Loop iteration (1-based); omitted ⇒ 1 (no loop). */
  iteration?: number;
  ts: number;
}

/**
 * A dynamic `forEach` step has resolved its work items and is about to dispatch
 * `count` child runs. Emitted *before* the children's `step_start`s so consumers
 * know the true fan-out cardinality up front — otherwise a run canceled
 * mid-fan-out would only ever reveal the children that happened to start (the
 * pool dispatches them lazily, bounded by concurrency).
 */
export interface FanOutEvent {
  kind: "fan_out";
  phaseId: string;
  /** The `forEach` step expanding into children. */
  parentStepId: string;
  /** Number of child runs this step expands into. */
  count: number;
  /** Loop iteration (1-based); omitted ⇒ 1 (no loop). */
  iteration?: number;
  ts: number;
}

/** One normalized agent event, attributed to the step that produced it. */
export interface StepStreamEvent {
  kind: "step_event";
  phaseId: string;
  stepId: string;
  event: AgentEvent;
  /** Loop iteration (1-based); omitted ⇒ 1 (no loop). */
  iteration?: number;
  ts: number;
}

export interface StepDoneEvent {
  kind: "step_done";
  phaseId: string;
  stepId: string;
  result: StepResult;
  /** True when replayed from memory/disk cache (resume), not a fresh agent run. */
  cached: boolean;
  /** Loop iteration (1-based); omitted ⇒ 1 (no loop). */
  iteration?: number;
  ts: number;
}

/**
 * A retryable (transient, side-effect-free) agent failure occurred and the step
 * is about to back off and try again. Emitted *after* the failed attempt and
 * *before* the backoff sleep. `attempt` is the 1-based attempt that just failed;
 * `delayMs` is the upcoming wait.
 */
export interface StepRetryEvent {
  kind: "step_retry";
  phaseId: string;
  stepId: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
  /** Loop iteration (1-based); omitted ⇒ 1 (no loop). */
  iteration?: number;
  ts: number;
}

export interface GateEvaluatedEvent {
  kind: "gate_evaluated";
  phaseId: string;
  stepId: string;
  passed: boolean;
  target?: string;
  onFalse?: GateStep["onFalse"];
  /** Loop iteration (1-based); omitted ⇒ 1 (no loop). */
  iteration?: number;
  ts: number;
}

export interface PhaseDoneEvent {
  kind: "phase_done";
  phaseId: string;
  ok: boolean;
  /** Loop iteration (1-based); omitted ⇒ 1 (no loop). */
  iteration?: number;
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
