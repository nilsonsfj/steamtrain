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
  ts: number;
}

export interface StepStartEvent {
  kind: "step_start";
  phaseId: string;
  stepId: string;
  blockKind?: WorkflowStepKind;
  agent?: AgentId;
  model?: string;
  cwd?: string;
  /** Parent dynamic `forEach` step, when this is a generated child run. */
  parentStepId?: string;
  /** Work item assigned to this generated child run. */
  item?: WorkflowItem;
  ts: number;
}

/** One normalized agent event, attributed to the step that produced it. */
export interface StepStreamEvent {
  kind: "step_event";
  phaseId: string;
  stepId: string;
  event: AgentEvent;
  ts: number;
}

export interface StepDoneEvent {
  kind: "step_done";
  phaseId: string;
  stepId: string;
  result: StepResult;
  /** True when the result came from the in-session cache (resume), not a run. */
  cached: boolean;
  ts: number;
}

export interface GateEvaluatedEvent {
  kind: "gate_evaluated";
  phaseId: string;
  stepId: string;
  passed: boolean;
  target?: string;
  onFalse?: GateStep["onFalse"];
  ts: number;
}

export interface PhaseDoneEvent {
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

export type WorkflowEvent =
  | WorkflowStartEvent
  | PhaseStartEvent
  | StepStartEvent
  | StepStreamEvent
  | GateEvaluatedEvent
  | StepDoneEvent
  | PhaseDoneEvent
  | WorkflowDoneEvent;

export type WorkflowEventKind = WorkflowEvent["kind"];
