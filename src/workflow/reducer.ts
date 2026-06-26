import type { AgentEvent, AgentId } from "../types/events";
import type { WorkflowEvent } from "./events";
import type { RunRecord } from "./history";
import type { GateStep, StepResult, WorkflowItem, WorkflowSpec, WorkflowStepKind } from "./types";

export type StepStatus = "pending" | "running" | "done" | "error";

export interface StepState {
  stepId: string;
  blockKind: WorkflowStepKind;
  agent?: AgentId;
  model?: string;
  effort?: string;
  cwd?: string;
  /** Earlier steps whose outputs feed this step. */
  dependsOn?: string[];
  parentStepId?: string;
  item?: WorkflowItem;
  status: StepStatus;
  /** Accumulated non-thinking text, for the tail / drill-in panel. */
  text: string;
  /** Latest tool line, e.g. "⚙ Bash" or "✓ Read". */
  activity?: string;
  result?: StepResult;
  gate?: { passed: boolean; target?: string; onFalse?: GateStep["onFalse"] };
  cached: boolean;
  /** Total attempts so far when the step is auto-retrying a transient failure. */
  attempts?: number;
  /** A loop-back gate's target phase, when this step is such a gate. */
  loopTo?: string;
  /** The gate's own iteration cap, when this step is a loop-back gate. */
  maxIterations?: number;
  forEach?: string;
}

export interface PhaseState {
  phaseId: string;
  title: string;
  index: number;
  stepCount: number;
  steps: StepState[];
  done: boolean;
  ok: boolean;
  /** Loop iteration (1-based) this phase instance belongs to; omitted ⇒ 1. */
  iteration?: number;
}

export interface LoopMarker {
  gateStepId: string;
  loopTo: string;
  iteration: number;
  maxIterations?: number;
  gatePhaseId?: string;
  gatePhaseIteration?: number;
}

export interface WorkflowState {
  name?: string;
  startedAt?: number;
  phases: PhaseState[];
  results: StepResult[];
  started: boolean;
  done: boolean;
  ok: boolean;
  loopMarkers?: LoopMarker[];
}

export const initialWorkflowState: WorkflowState = {
  phases: [],
  results: [],
  started: false,
  done: false,
  ok: true,
  loopMarkers: [],
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

/**
 * Seed a complete WorkflowState from a WorkflowSpec so the visual layout
 * shows all phases and steps in their initial pending state.
 */
export function workflowStateFromSpec(spec: WorkflowSpec): WorkflowState {
  return {
    name: spec.name,
    phases: spec.phases.map((p, idx) => ({
      phaseId: p.id,
      title: p.title || p.id,
      index: idx,
      stepCount: p.steps.length,
      done: false,
      ok: true,
      iteration: 1,
      steps: p.steps.map((st) => ({
        stepId: st.id,
        blockKind: st.kind ?? "worker",
        agent: "agent" in st ? st.agent : undefined,
        model: "model" in st ? st.model : undefined,
        effort: "effort" in st ? st.effort : undefined,
        cwd: "cwd" in st ? st.cwd : undefined,
        dependsOn: st.dependsOn,
        status: "pending",
        text: "",
        cached: false,
        loopTo: "loopTo" in st ? st.loopTo : undefined,
        maxIterations: "maxIterations" in st ? st.maxIterations : undefined,
        forEach: "forEach" in st ? st.forEach : undefined,
      })),
    })),
    results: [],
    started: false,
    done: false,
    ok: true,
    loopMarkers: [],
  };
}

/**
 * Rebuild a render-ready {@link WorkflowState} from a saved run record, so the
 * history viewer can reuse the live `WorkflowView` / `WorkflowStepDetails`
 * components. The record's phase/step shapes mirror the live tree, so phases map
 * across directly (a recorded step has no transient `activity`).
 */
export function workflowStateFromRecord(record: RunRecord): WorkflowState {
  return {
    name: record.workflow,
    startedAt: record.startedAt,
    phases: record.phases.map((phase) => ({
      phaseId: phase.phaseId,
      title: phase.title,
      index: phase.index,
      stepCount: phase.stepCount,
      done: phase.done,
      ok: phase.ok,
      iteration: phase.iteration,
      steps: phase.steps.map((step) => ({
        ...step,
        status: parseStepStatus(step.status),
        blockKind: step.blockKind,
      })),
    })),
    results: [],
    started: true,
    done: record.phases.every((phase) => phase.done),
    ok: record.ok,
    loopMarkers: [],
  };
}

function parseStepStatus(status: string): StepStatus {
  if (status === "pending" || status === "running" || status === "done" || status === "error") {
    return status;
  }
  return "pending";
}

/** Matches a phase to a specific loop iteration instance; omitted iteration ⇒ 1. */
function sameInstance(p: PhaseState, phaseId: string, iteration?: number): boolean {
  return p.phaseId === phaseId && (p.iteration ?? 1) === (iteration ?? 1);
}

/** Phase id of the instance (any iteration) that holds `stepId`, or undefined. */
function phaseOfStep(state: WorkflowState, stepId: string): string | undefined {
  for (const p of state.phases) {
    if (p.steps.some((s) => s.stepId === stepId)) return p.phaseId;
  }
  return undefined;
}

function updateStep(
  state: WorkflowState,
  phaseId: string,
  stepId: string,
  iteration: number | undefined,
  fn: (s: StepState) => StepState,
): WorkflowState {
  return {
    ...state,
    phases: state.phases.map((p) =>
      sameInstance(p, phaseId, iteration)
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
        ...state,
        name: e.name,
        startedAt: e.ts,
        // Preserve prior phases if seeded (e.g., from the spec in the web client).
        // The TUI resets state via a separate "reset" action before workflow_start,
        // so it does not contain stale phase state.
        phases: state.phases.length > 0 ? state.phases : [],
        results: [],
        started: true,
        done: false,
        ok: true,
        loopMarkers: [],
      };
    case "phase_start": {
      const iter = e.iteration ?? 1;
      const existing = state.phases.find((p) => sameInstance(p, e.phaseId, iter));
      if (existing) {
        return state;
      }
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
            iteration: iter,
          },
        ],
      };
    }
    case "fan_out":
      return {
        ...state,
        phases: state.phases.map((p) => {
          if (!sameInstance(p, e.phaseId, e.iteration)) return p;
          const updatedSteps = [...p.steps];
          for (let fi = 0; fi < e.count; fi++) {
            const childId = `${e.parentStepId}[${fi}]`;
            if (!updatedSteps.some((s) => s.stepId === childId)) {
              updatedSteps.push({
                stepId: childId,
                blockKind: "worker",
                status: "pending",
                text: "",
                cached: false,
                parentStepId: e.parentStepId,
              });
            }
          }
          return {
            ...p,
            steps: updatedSteps,
            stepCount: Math.max(p.stepCount, updatedSteps.length),
          };
        }),
      };
    case "step_start":
      return {
        ...state,
        phases: state.phases.map((p) => {
          if (!sameInstance(p, e.phaseId, e.iteration)) return p;

          const stepExists = p.steps.some((s) => s.stepId === e.stepId);
          const newStep: StepState = {
            stepId: e.stepId,
            blockKind: e.blockKind ?? "worker",
            agent: e.agent,
            model: e.model,
            effort: e.effort,
            cwd: e.cwd,
            dependsOn: e.dependsOn,
            parentStepId: e.parentStepId,
            item: e.item,
            status: "running",
            text: "",
            cached: false,
            loopTo: e.loopTo,
            maxIterations: e.maxIterations,
          };

          return {
            ...p,
            stepCount:
              e.parentStepId && !stepExists
                ? Math.max(p.stepCount, p.steps.length + 1)
                : p.stepCount,
            steps: stepExists
              ? p.steps.map((s) => (s.stepId === e.stepId ? { ...s, ...newStep } : s))
              : [...p.steps, newStep],
          };
        }),
      };
    case "step_event":
      return updateStep(state, e.phaseId, e.stepId, e.iteration, (s) =>
        applyAgentEvent(s, e.event),
      );
    case "step_retry":
      return updateStep(state, e.phaseId, e.stepId, e.iteration, (s) => ({
        ...s,
        attempts: e.attempt + 1,
        activity: `↻ retrying ${e.attempt + 1}/${e.maxAttempts} (${Math.round(e.delayMs)}ms)`,
      }));
    case "gate_evaluated":
      return updateStep(state, e.phaseId, e.stepId, e.iteration, (s) => ({
        ...s,
        gate: { passed: e.passed, target: e.target, onFalse: e.onFalse },
        activity: e.passed ? `gate passed${e.target ? ` → ${e.target}` : ""}` : "gate blocked",
      }));
    case "step_done":
      return updateStep(state, e.phaseId, e.stepId, e.iteration, (s) => ({
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
          sameInstance(p, e.phaseId, e.iteration) ? { ...p, done: true, ok: e.ok } : p,
        ),
      };
    case "workflow_done":
      return { ...state, done: true, ok: e.ok, results: e.results };
    case "loop_iteration": {
      const gatePhaseId = phaseOfStep(state, e.gateStepId);
      if (gatePhaseId) {
        const instance = state.phases.find((p) => p.phaseId === gatePhaseId && p.done);
        console.assert(
          instance,
          "loop_iteration for gate %s arrived without a completed phase instance",
          e.gateStepId,
        );
      }
      let gatePhaseIteration = 0;
      if (gatePhaseId) {
        for (let i = state.phases.length - 1; i >= 0; i--) {
          const p = state.phases[i]!;
          if (p.phaseId === gatePhaseId && p.iteration && p.done) {
            gatePhaseIteration = p.iteration;
            break;
          }
        }
      }
      return {
        ...state,
        loopMarkers: [
          ...(state.loopMarkers ?? []),
          {
            gateStepId: e.gateStepId,
            loopTo: e.loopTo,
            iteration: e.iteration,
            maxIterations: e.maxIterations,
            gatePhaseId,
            gatePhaseIteration,
          },
        ],
      };
    }
  }
}
