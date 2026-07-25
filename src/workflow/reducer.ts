import {
  type PermissionsSpec,
  effectivePermissions,
  isPermissionProfile,
  resolvePermissions,
} from "../agents/permissions";
import type { AgentEvent, AgentInstanceId } from "../types/events";
import type { ApprovalRejectDisposition } from "./approval";
import type { StepEditPatch } from "./control";
import type { StepPermissionsInfo, WorkflowEvent } from "./events";
import type { RunRecord } from "./history";
import { llmStepApiId } from "./llm";
import type { WorktreeDiff } from "./merge";
import { isAgentBackedStep } from "./step-kind";
import type {
  AgentWorktreeInfo,
  GateStep,
  StepResult,
  WorkflowItem,
  WorkflowSpec,
  WorkflowStepKind,
} from "./types";

export type StepStatus = "pending" | "running" | "done" | "error";

/**
 * Effective permissions for a spec step in a PREVIEW (before any run exists):
 * the step's own declaration, else the workflow's default. The project/user
 * config layer is deliberately absent here — the reducer runs in the browser
 * too and has no config — so a preview badge can only ever under-report, never
 * claim a restriction that isn't there. Live runs get the fully-resolved value
 * from `step_start`.
 */
/**
 * The badge a mid-run clamp should show on a still-pending step row, so the
 * intervention is visible immediately rather than only once the step starts.
 *
 * A cleared profile (`""`) drops the badge even though an inherited workflow /
 * config default may still apply — the reducer cannot see those layers, and for
 * a trust badge under-reporting is the only safe direction. The step's own
 * `step_start` carries the authoritative effective profile a moment later.
 */
function editedPermissions(
  patched: string | undefined,
  current: StepPermissionsInfo | undefined,
): StepPermissionsInfo | undefined {
  if (patched === undefined) return current;
  const resolved = isPermissionProfile(patched) ? resolvePermissions(patched) : undefined;
  if (!resolved) return undefined;
  return {
    profile: resolved.profile,
    ...(resolved.verify ? { verify: true } : {}),
  };
}

function specStepPermissions(
  step: WorkflowSpec["phases"][number]["steps"][number],
  spec: WorkflowSpec,
): StepPermissionsInfo | undefined {
  // Only agent-backed steps have a CLI to restrict, so a workflow-level default
  // must not badge a gate/command/llm step it does not apply to.
  if (!isAgentBackedStep(step)) return undefined;
  const declared = (step as { permissions?: PermissionsSpec }).permissions;
  const perms = effectivePermissions([declared, spec.permissions]);
  if (!perms) return undefined;
  return {
    profile: perms.profile,
    ...(perms.allow.length > 0 ? { allow: perms.allow.length } : {}),
    ...(perms.deny.length > 0 ? { deny: perms.deny.length } : {}),
    ...(perms.verify ? { verify: true } : {}),
  };
}

/**
 * Human-approval checkpoint state attached to an `approval` step / human gate.
 * Mirrors the `approval_pending` / `approval_resolved` events so a UI can render
 * the reviewed output/diff and the decision from the folded tree alone.
 */
export interface StepApprovalState {
  /** True while the run is paused waiting for a decision. */
  pending: boolean;
  /** The decision, once resolved. */
  approved?: boolean;
  /** Who/what decided (e.g. `"human"`, `"auto:approve-all"`). */
  by?: string;
  /** Optional note attached to the decision. */
  note?: string;
  /** The step under review, when the checkpoint references one. */
  reviewStepId?: string;
  /** Human-readable instructions from the spec. */
  message?: string;
  /** The reviewed step's output (capped). */
  output?: string;
  /** The reviewed step's worktree diff, when it ran in one. */
  diff?: WorktreeDiff;
  /** What a rejection does to control flow. */
  onReject?: ApprovalRejectDisposition;
}

/** A checkpoint the run is currently paused on, awaiting an Approve/Reject decision. */
export interface PendingApproval {
  phaseId: string;
  stepId: string;
  iteration: number;
  reviewStepId?: string;
  message?: string;
  output?: string;
  diff?: WorktreeDiff;
  onReject?: ApprovalRejectDisposition;
}

/**
 * Human-input state attached to a `human` step (or a `canAsk` agent step whose
 * question is in flight). Mirrors the `human_input_pending` /
 * `human_input_resolved` events so a UI can render the ask and its answer from
 * the folded tree alone.
 */
export interface StepHumanInputState {
  /** True while the run waits for an answer. */
  pending: boolean;
  /** Rendered instructions / the agent's question (capped). */
  prompt?: string;
  /** Pick-one choices, when declared. */
  choices?: string[];
  /** JSON schema the reply must satisfy, when declared. */
  outputSchema?: Record<string, unknown>;
  /** Spec-declared `human` step vs. an agent's clarifying question. */
  origin?: "human-step" | "agent-question";
  /** 1-based ask attempt; >1 means the previous answer was rejected. */
  attempt?: number;
  /** Why the previous attempt's answer was rejected. */
  retryError?: string;
  /** The accepted value (capped), once resolved. */
  value?: string;
  /** Who answered. */
  by?: string;
  /** True when the ask ended without an accepted answer. */
  canceled?: boolean;
}

/** An input request the run is currently waiting on, awaiting a human answer. */
export interface PendingHumanInput {
  phaseId: string;
  stepId: string;
  iteration: number;
  attempt: number;
  prompt: string;
  choices?: string[];
  outputSchema?: Record<string, unknown>;
  origin: "human-step" | "agent-question";
  retryError?: string;
}

export interface StepState {
  stepId: string;
  blockKind: WorkflowStepKind;
  agent?: AgentInstanceId;
  /** API instance a direct-inference `llm` step calls (agent steps carry `agent` instead). */
  api?: string;
  model?: string;
  effort?: string;
  cwd?: string;
  /**
   * Effective tool permissions (`read-only` / `edit` / `full`) the step runs
   * under. Lands from `step_start` for a live run and from the spec for a
   * preview, so every surface can badge a locked-down step.
   */
  permissions?: StepPermissionsInfo;
  /** For a `workflow` (sub-workflow) step, the name of the workflow it invokes. */
  workflow?: string;
  /** Earlier steps whose outputs feed this step. */
  dependsOn?: string[];
  parentStepId?: string;
  item?: WorkflowItem;
  status: StepStatus;
  /** Epoch ms the step started running (its `step_start` timestamp). */
  startedAt?: number;
  /** Epoch ms the step finished (its `step_done` timestamp). */
  endedAt?: number;
  /**
   * Isolated git worktree the step is working in. Lands live from the
   * `step_workspace` event (right after the workspace is allocated), and again
   * from the final result — so replayed records show it too.
   */
  worktree?: AgentWorktreeInfo;
  /** Accumulated non-thinking text, for the tail / drill-in panel. */
  text: string;
  /** Latest tool line, e.g. "⚙ Bash" or "✓ Read". */
  activity?: string;
  result?: StepResult;
  gate?: { passed: boolean; target?: string; onFalse?: GateStep["onFalse"] };
  /**
   * Human-approval checkpoint state, when this step is an `approval` step or a
   * `gate` with `condition.human`. `pending` is true while the run waits for a
   * decision; `approved`/`by`/`note` land once it resolves.
   */
  approval?: StepApprovalState;
  /**
   * Human-input state, when this step is a `human` step or a `canAsk` agent
   * step whose clarifying question is (or was) in flight. `pending` is true
   * while the run waits for an answer; `value`/`by` land once it resolves.
   */
  humanInput?: StepHumanInputState;
  cached: boolean;
  /** Total attempts so far when the step is auto-retrying a transient failure. */
  attempts?: number;
  /** A loop-back gate's target phase, when this step is such a gate. */
  loopTo?: string;
  /** The gate's own iteration cap, when this step is a loop-back gate. */
  maxIterations?: number;
  forEach?: string;
  /** True when a mid-run edit (pause → edit → resume) applies to this step. */
  edited?: boolean;
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

/** A cost budget breach surfaced live, so UIs can badge the run/step. */
export interface BudgetState {
  scope: "workflow" | "step";
  stepId?: string;
  limitUsd: number;
  spentUsd: number;
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
  /** Set once a cost budget stopped the run scheduling new steps. */
  budget?: BudgetState;
  /**
   * Checkpoints the run is currently paused on, awaiting Approve/Reject. UIs
   * render an interactive card for each; entries clear as decisions arrive.
   */
  pendingApprovals?: PendingApproval[];
  /**
   * Input requests the run is currently waiting on (human steps / agent
   * questions). UIs render an answer form for each; entries clear (or are
   * superseded by a re-ask) as answers arrive.
   */
  pendingInputs?: PendingHumanInput[];
  /**
   * True while the engine has acknowledged a pause (no new steps launch;
   * in-flight steps drain). Cleared by `run_resumed` and at `workflow_done`.
   */
  paused?: boolean;
  /** Who requested the current pause, when known. */
  pausedBy?: string;
  /** Accepted mid-run step edits (latest patch per step id). */
  editedSteps?: Record<string, StepEditPatch>;
}

export const initialWorkflowState: WorkflowState = {
  phases: [],
  results: [],
  started: false,
  done: false,
  ok: true,
  loopMarkers: [],
  pendingApprovals: [],
  pendingInputs: [],
};

export type WorkflowStateAction =
  | { type: "event"; event: WorkflowEvent }
  | { type: "reset" }
  /**
   * Seed the full phase → step tree from the spec (every step pending), so a
   * live view shows not-yet-started steps too — required for mid-run editing,
   * which targets exactly those steps. `workflow_start` preserves seeded
   * phases instead of clearing them.
   */
  | { type: "seed"; spec: WorkflowSpec };

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
        api: st.kind === "llm" ? llmStepApiId(st) : undefined,
        model: "model" in st ? st.model : undefined,
        effort: "effort" in st ? st.effort : undefined,
        cwd: "cwd" in st ? st.cwd : undefined,
        permissions: specStepPermissions(st, spec),
        workflow: st.kind === "workflow" ? st.workflow : undefined,
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
  const results: StepResult[] = [];
  for (const phase of record.phases) {
    for (const step of phase.steps) {
      if (step.result) results.push(step.result);
    }
  }
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
        // HistoryStep.approval/humanInput omit the live-only `pending` flag; a
        // replayed record is always terminal, so pending is false.
        approval: step.approval ? { pending: false, ...step.approval } : undefined,
        humanInput: step.humanInput ? { pending: false, ...step.humanInput } : undefined,
      })),
    })),
    results,
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
  return "error";
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
  if (action.type === "seed") return workflowStateFromSpec(action.spec);

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
        budget: undefined,
        pendingApprovals: [],
        pendingInputs: [],
        paused: false,
        pausedBy: undefined,
        editedSteps: undefined,
      };
    case "phase_start": {
      const iter = e.iteration ?? 1;
      const existing = state.phases.find((p) => sameInstance(p, e.phaseId, iter));
      if (existing) {
        return {
          ...state,
          phases: state.phases.map((p) =>
            sameInstance(p, e.phaseId, iter)
              ? { ...p, title: e.title, index: e.index, stepCount: e.stepCount }
              : p,
          ),
        };
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
            api: e.api,
            model: e.model,
            effort: e.effort,
            cwd: e.cwd,
            permissions: e.permissions,
            dependsOn: e.dependsOn,
            parentStepId: e.parentStepId,
            item: e.item,
            status: "running",
            startedAt: e.ts,
            text: "",
            cached: false,
            loopTo: e.loopTo,
            maxIterations: e.maxIterations,
            edited: state.editedSteps?.[e.stepId] ? true : undefined,
          };

          return {
            ...p,
            stepCount:
              e.parentStepId && !stepExists
                ? Math.max(p.stepCount, p.steps.length + 1)
                : p.stepCount,
            steps: stepExists
              ? p.steps.map((s) => {
                  if (s.stepId !== e.stepId) return s;
                  const updates = Object.fromEntries(
                    Object.entries(newStep).filter(([, v]) => v !== undefined),
                  );
                  return { ...s, ...updates };
                })
              : [...p.steps, newStep],
          };
        }),
      };
    case "step_event":
      return updateStep(state, e.phaseId, e.stepId, e.iteration, (s) =>
        applyAgentEvent(s, e.event),
      );
    case "step_workspace":
      return updateStep(state, e.phaseId, e.stepId, e.iteration, (s) => ({
        ...s,
        cwd: e.cwd,
        worktree: e.worktree ?? s.worktree,
      }));
    case "step_retry":
      return updateStep(state, e.phaseId, e.stepId, e.iteration, (s) => {
        const nextAgent = e.failover?.toAgent ?? s.agent;
        const nextModel = e.failover?.toModel ?? s.model;
        const nextEffort = e.failover?.toEffort ?? s.effort;
        const activity = e.failover
          ? `↻ failover → ${e.failover.toAgent}/${e.failover.toModel} (${e.attempt + 1}/${e.maxAttempts})`
          : `↻ retrying ${e.attempt + 1}/${e.maxAttempts} (${Math.round(e.delayMs)}ms)`;
        return {
          ...s,
          attempts: e.attempt + 1,
          agent: nextAgent,
          model: nextModel,
          effort: nextEffort,
          activity,
        };
      });
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
        endedAt: e.ts,
        result: e.result,
        worktree: e.result.worktree ?? s.worktree,
        cached: e.cached,
        text: s.text || e.result.output,
        edited: s.edited || e.result.edited || undefined,
      }));
    case "phase_done":
      return {
        ...state,
        phases: state.phases.map((p) =>
          sameInstance(p, e.phaseId, e.iteration) ? { ...p, done: true, ok: e.ok } : p,
        ),
      };
    case "budget_exceeded":
      return {
        ...state,
        budget: {
          scope: e.scope,
          stepId: e.stepId,
          limitUsd: e.limitUsd,
          spentUsd: e.spentUsd,
        },
      };
    case "workflow_done":
      return { ...state, done: true, ok: e.ok, results: e.results, paused: false };
    case "run_paused":
      return { ...state, paused: true, pausedBy: e.by };
    case "run_resumed":
      return { ...state, paused: false, pausedBy: undefined };
    case "step_edited": {
      // Track the accepted patch at run level (the step may not have a
      // rendered StepState yet — the TUI only materializes steps as they
      // start), and badge any already-materialized pending instance (the web
      // client seeds the full tree from the spec).
      const editedSteps = {
        ...state.editedSteps,
        [e.stepId]: { ...state.editedSteps?.[e.stepId], ...e.patch },
      };
      return {
        ...state,
        editedSteps,
        phases: state.phases.map((p) => ({
          ...p,
          steps: p.steps.map((s) =>
            s.stepId === e.stepId && s.status === "pending"
              ? {
                  ...s,
                  edited: true,
                  model: e.patch.model ?? s.model,
                  effort: e.patch.effort !== undefined ? e.patch.effort || undefined : s.effort,
                  permissions: editedPermissions(e.patch.permissions, s.permissions),
                }
              : s,
          ),
        })),
      };
    }
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
    case "approval_pending": {
      const withStep = updateStep(state, e.phaseId, e.stepId, e.iteration, (s) => ({
        ...s,
        activity: "⏳ awaiting approval",
        approval: {
          pending: true,
          reviewStepId: e.reviewStepId,
          message: e.message,
          output: e.output,
          diff: e.diff,
          onReject: e.onReject,
        },
      }));
      const pending: PendingApproval = {
        phaseId: e.phaseId,
        stepId: e.stepId,
        iteration: e.iteration ?? 1,
        reviewStepId: e.reviewStepId,
        message: e.message,
        output: e.output,
        diff: e.diff,
        onReject: e.onReject,
      };
      const others = (withStep.pendingApprovals ?? []).filter(
        (p) => !(p.stepId === e.stepId && p.iteration === (e.iteration ?? 1)),
      );
      return { ...withStep, pendingApprovals: [...others, pending] };
    }
    case "approval_resolved": {
      const withStep = updateStep(state, e.phaseId, e.stepId, e.iteration, (s) => ({
        ...s,
        activity: e.approved ? "approved" : "rejected",
        approval: {
          ...(s.approval ?? { pending: false }),
          pending: false,
          approved: e.approved,
          by: e.by,
          note: e.note,
        },
      }));
      return {
        ...withStep,
        pendingApprovals: (withStep.pendingApprovals ?? []).filter(
          (p) => !(p.stepId === e.stepId && p.iteration === (e.iteration ?? 1)),
        ),
      };
    }
    case "human_input_pending": {
      const withStep = updateStep(state, e.phaseId, e.stepId, e.iteration, (s) => ({
        ...s,
        activity:
          e.origin === "agent-question" ? "✎ agent asked a question" : "✎ awaiting human input",
        humanInput: {
          pending: true,
          prompt: e.prompt,
          choices: e.choices,
          outputSchema: e.outputSchema,
          origin: e.origin,
          attempt: e.attempt,
          retryError: e.retryError,
        },
      }));
      const pending: PendingHumanInput = {
        phaseId: e.phaseId,
        stepId: e.stepId,
        iteration: e.iteration ?? 1,
        attempt: e.attempt,
        prompt: e.prompt,
        choices: e.choices,
        outputSchema: e.outputSchema,
        origin: e.origin,
        retryError: e.retryError,
      };
      // A re-ask (attempt > 1) supersedes the same step's previous entry.
      const others = (withStep.pendingInputs ?? []).filter(
        (p) => !(p.stepId === e.stepId && p.iteration === (e.iteration ?? 1)),
      );
      return { ...withStep, pendingInputs: [...others, pending] };
    }
    case "human_input_resolved": {
      const withStep = updateStep(state, e.phaseId, e.stepId, e.iteration, (s) => ({
        ...s,
        activity: e.canceled ? "input canceled" : "answered",
        humanInput: {
          ...(s.humanInput ?? { pending: false }),
          pending: false,
          value: e.value,
          by: e.by,
          canceled: e.canceled,
        },
      }));
      return {
        ...withStep,
        pendingInputs: (withStep.pendingInputs ?? []).filter(
          (p) => !(p.stepId === e.stepId && p.iteration === (e.iteration ?? 1)),
        ),
      };
    }
    default: {
      const _exhaustive: never = e;
      void _exhaustive;
      return state;
    }
  }
}
