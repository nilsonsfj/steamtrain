import type { AgentEvent, AgentId } from "../types/events";
import type { GateStep, StepResult, WorkflowEvent, WorkflowStepKind } from "../workflow";

/**
 * The render model for a workflow run: a phase → step tree built by folding the
 * `WorkflowEvent` stream. Each step accumulates its streamed text (for a live
 * tail) and its current tool activity, and lands a `StepResult` when done.
 */

export type StepStatus = "pending" | "running" | "done" | "error";

export interface StepState {
  stepId: string;
  blockKind: WorkflowStepKind;
  agent?: AgentId;
  model?: string;
  cwd?: string;
  status: StepStatus;
  /** Accumulated non-thinking text, for the tail / drill-in panel. */
  text: string;
  /** Latest tool line, e.g. "⚙ Bash" or "✓ Read". */
  activity?: string;
  result?: StepResult;
  gate?: { passed: boolean; target?: string; onFalse?: GateStep["onFalse"] };
  cached: boolean;
}

export interface PhaseState {
  phaseId: string;
  title: string;
  index: number;
  stepCount: number;
  steps: StepState[];
  done: boolean;
  ok: boolean;
}

export interface WorkflowState {
  name?: string;
  startedAt?: number;
  phases: PhaseState[];
  results: StepResult[];
  started: boolean;
  done: boolean;
  ok: boolean;
}

export const initialWorkflowState: WorkflowState = {
  phases: [],
  results: [],
  started: false,
  done: false,
  ok: true,
};

export type WorkflowStateAction = { type: "event"; event: WorkflowEvent } | { type: "reset" };

/** Flatten the tree to an ordered list of steps (for selection by index). */
export function flattenSteps(state: WorkflowState): { phase: PhaseState; step: StepState }[] {
  const out: { phase: PhaseState; step: StepState }[] = [];
  for (const phase of state.phases) {
    for (const step of phase.steps) out.push({ phase, step });
  }
  return out;
}

function updateStep(
  state: WorkflowState,
  phaseId: string,
  stepId: string,
  fn: (s: StepState) => StepState,
): WorkflowState {
  return {
    ...state,
    phases: state.phases.map((p) =>
      p.phaseId === phaseId
        ? { ...p, steps: p.steps.map((s) => (s.stepId === stepId ? fn(s) : s)) }
        : p,
    ),
  };
}

function applyAgentEvent(step: StepState, event: AgentEvent): StepState {
  switch (event.kind) {
    case "text_delta":
      return event.thinking ? step : { ...step, text: step.text + event.text };
    case "tool_use":
      return { ...step, activity: `⚙ ${event.name}` };
    case "tool_result":
      return {
        ...step,
        activity: `${event.isError ? "✗" : "✓"} ${event.name ?? "tool"}`,
      };
    default:
      return step;
  }
}

export function workflowReducer(state: WorkflowState, action: WorkflowStateAction): WorkflowState {
  if (action.type === "reset") return initialWorkflowState;

  const e = action.event;
  switch (e.kind) {
    case "workflow_start":
      return {
        name: e.name,
        startedAt: e.ts,
        phases: [],
        results: [],
        started: true,
        done: false,
        ok: true,
      };
    case "phase_start":
      return {
        ...state,
        phases: [
          ...state.phases,
          {
            phaseId: e.phaseId,
            title: e.title,
            index: e.index,
            stepCount: e.stepCount,
            steps: [],
            done: false,
            ok: true,
          },
        ],
      };
    case "step_start":
      return {
        ...state,
        phases: state.phases.map((p) =>
          p.phaseId === e.phaseId
            ? {
                ...p,
                steps: [
                  ...p.steps,
                  {
                    stepId: e.stepId,
                    blockKind: e.blockKind ?? "worker",
                    agent: e.agent,
                    model: e.model,
                    cwd: e.cwd,
                    status: "running",
                    text: "",
                    cached: false,
                  },
                ],
              }
            : p,
        ),
      };
    case "step_event":
      return updateStep(state, e.phaseId, e.stepId, (s) => applyAgentEvent(s, e.event));
    case "gate_evaluated":
      return updateStep(state, e.phaseId, e.stepId, (s) => ({
        ...s,
        gate: { passed: e.passed, target: e.target, onFalse: e.onFalse },
        activity: e.passed ? `gate passed${e.target ? ` → ${e.target}` : ""}` : "gate blocked",
      }));
    case "step_done":
      return updateStep(state, e.phaseId, e.stepId, (s) => ({
        ...s,
        status: e.result.ok ? "done" : "error",
        result: e.result,
        cached: e.cached,
        text: s.text || e.result.output,
      }));
    case "phase_done":
      return {
        ...state,
        phases: state.phases.map((p) =>
          p.phaseId === e.phaseId ? { ...p, done: true, ok: e.ok } : p,
        ),
      };
    case "workflow_done":
      return { ...state, done: true, ok: e.ok, results: e.results };
  }
}
