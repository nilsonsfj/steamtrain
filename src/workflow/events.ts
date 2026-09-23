import type { PermissionProfile } from "../agents/permissions";
import type { AgentEvent, AgentFailureKind, AgentInstanceId, ApiInstanceId } from "../types/events";
import type { ApprovalRejectDisposition } from "./approval";
import type { StepEditPatch } from "./control";
import type { WorktreeDiff } from "./merge";
import type {
  AgentWorktreeInfo,
  GateStep,
  StepResult,
  WorkflowItem,
  WorkflowStepKind,
} from "./types";

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

/**
 * The tool-permission profile a step will run under, as known at dispatch time
 * (the declared/effective profile — how much of it the CLI actually enforces is
 * only knowable at spawn time and lands on {@link StepResult.permissions}).
 * Carried on `step_start` so live views can badge a locked-down step from the
 * moment it starts, not after it finishes.
 */
export interface StepPermissionsInfo {
  profile: PermissionProfile;
  /** Count of extra allowed tool patterns (`allow`), when any. */
  allow?: number;
  /** Count of denied tool patterns (`deny`), when any. */
  deny?: number;
  /** Post-run workspace verification is armed for this step. */
  verify?: boolean;
}

export interface StepStartEvent extends IterationTagged {
  kind: "step_start";
  phaseId: string;
  stepId: string;
  blockKind?: WorkflowStepKind;
  agent?: AgentInstanceId;
  /** Effective tool permissions for this step, when any profile applies. */
  permissions?: StepPermissionsInfo;
  /** API instance a direct-inference `llm` step calls (agent steps carry `agent` instead). */
  api?: ApiInstanceId;
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
 * A worker/processor/command step's workspace has been allocated and its
 * process is about to launch. Carries the directory the step actually runs in
 * and, when the run is inside a git repository, the isolated worktree's
 * metadata — so live views can show *where* a step is working while it works,
 * instead of only learning the worktree from the final {@link StepDoneEvent}
 * result. Emitted between the step's `step_start` and its first `step_event`.
 */
export interface StepWorkspaceEvent extends IterationTagged {
  kind: "step_workspace";
  phaseId: string;
  stepId: string;
  /** Directory the step's subprocess runs in (the worktree cwd when isolated). */
  cwd: string;
  /** Isolated git worktree metadata, when the step runs in one. */
  worktree?: AgentWorktreeInfo;
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
  /**
   * Set on a mid-run handoff's replay of the previous owner's own step, which
   * is reported as this run's work (`cached: false`). Its spend was already
   * counted where the step ran, so a later handoff must not count it again.
   */
  claimed?: boolean;
  ts: number;
}

/**
 * A retryable (transient, side-effect-free) agent failure occurred and the step
 * is about to back off and try again. Emitted *after* the failed attempt and
 * *before* the backoff sleep. `attempt` is the 1-based attempt that just failed;
 * `delayMs` is the upcoming wait.
 *
 * When the engine walks the model failover chain (quota / rate-limit / …),
 * `failover` carries the from→to binding so UIs can update the live step
 * target instead of only showing a generic "retrying…" activity line.
 */
export interface StepRetryEvent extends IterationTagged {
  kind: "step_retry";
  phaseId: string;
  stepId: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
  /**
   * Present when this retry switches agent and/or model. UIs should update the
   * live step's `agent`/`model`/`effort` from `to*` fields.
   */
  failover?: {
    fromAgent: string;
    fromModel: string;
    toAgent: string;
    toModel: string;
    toEffort?: string;
    /** Classified failure that triggered the switch (quota, rate_limit, …). */
    failureKind: AgentFailureKind;
  };
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
  /**
   * The run stopped scheduling new steps because a cost budget (workflow- or
   * step-level `maxCostUsd`) was reached. The run is resumable: raise the cap
   * and re-run, and completed steps replay from cache. `ok` is false when set.
   */
  budgetExceeded?: boolean;
  ts: number;
}

/**
 * A cost budget (workflow- or step-level `maxCostUsd`) was reached. Emitted once,
 * when the engine first decides to stop scheduling new steps; in-flight steps
 * still finish. Consumers surface this as a distinct "budget-exceeded" outcome.
 */
export interface BudgetExceededEvent extends IterationTagged {
  kind: "budget_exceeded";
  /** Whether the whole-workflow budget or a single step's budget was hit. */
  scope: "workflow" | "step";
  /** The step whose `maxCostUsd` was hit (scope "step" only). */
  stepId?: string;
  /** The configured cap in USD. */
  limitUsd: number;
  /** Accumulated spend (USD) at the moment the cap was hit. */
  spentUsd: number;
  ts: number;
}

/**
 * A loop-back gate's condition was not met and the iteration budget still
 * remains, so execution is about to jump back to `loopTo` and re-run the body.
 * `iteration` is the iteration that is ABOUT TO START (2 = the first re-run).
 */
export interface LoopIterationEvent extends IterationTagged {
  kind: "loop_iteration";
  gateStepId: string;
  loopTo: string;
  /** The iteration that is ABOUT TO START (2 = the first re-run). Always defined. */
  iteration: number;
  maxIterations: number;
  ts: number;
}

/**
 * A human-approval checkpoint (`approval` step or `gate` with
 * `condition.human`) has paused the run and is waiting for a decision. Carries
 * everything a UI needs to render the checkpoint: the reviewed step's id,
 * capped output, and (when it ran in a worktree) its diff. Emitted right before
 * the engine awaits the injected approval provider; a matching
 * {@link ApprovalResolvedEvent} follows once the decision arrives.
 */
export interface ApprovalPendingEvent extends IterationTagged {
  kind: "approval_pending";
  phaseId: string;
  stepId: string;
  /** The step under review, when the checkpoint references one. */
  reviewStepId?: string;
  /** Human-readable instructions from the spec (`prompt`), when provided. */
  message?: string;
  /** The reviewed step's output text (capped for transport/rendering). */
  output?: string;
  /** The reviewed step's worktree diff, when it ran in one with changes. */
  diff?: WorktreeDiff;
  /** The reviewed step's worktree metadata, when it ran in one. */
  worktree?: AgentWorktreeInfo;
  /** What a rejection will do to control flow. */
  onReject: ApprovalRejectDisposition;
  ts: number;
}

/** A pending approval checkpoint was decided (approved or rejected). */
export interface ApprovalResolvedEvent extends IterationTagged {
  kind: "approval_resolved";
  phaseId: string;
  stepId: string;
  approved: boolean;
  /** Who/what decided (e.g. `"human"`, `"auto:approve-all"`). */
  by?: string;
  /** Optional free-text note the decider attached. */
  note?: string;
  ts: number;
}

/**
 * A `human` step — or a `canAsk` agent step that emitted a clarifying
 * question — has paused and is waiting for a person to answer. Carries
 * everything a UI needs to render the ask: the rendered prompt/question,
 * pick-one `choices` when declared, and the `outputSchema` when the reply
 * must be JSON. Emitted right before the engine awaits the injected
 * human-input provider; a matching {@link HumanInputResolvedEvent} follows.
 * A rejected answer (wrong choice, schema mismatch) re-emits this event with
 * `attempt` incremented and `retryError` explaining what to fix.
 */
export interface HumanInputPendingEvent extends IterationTagged {
  kind: "human_input_pending";
  phaseId: string;
  stepId: string;
  /** 1-based ask attempt; >1 means the previous answer was rejected. */
  attempt: number;
  /** Rendered instructions / the agent's question (capped for transport). */
  prompt: string;
  /** Pick-one choices, when the step declares them. */
  choices?: string[];
  /** JSON schema the reply must satisfy, when the step declares `output`. */
  outputSchema?: Record<string, unknown>;
  /** Whether this is a spec-declared `human` step or an agent's question. */
  origin: "human-step" | "agent-question";
  /** Why the previous attempt's answer was rejected (attempt > 1 only). */
  retryError?: string;
  ts: number;
}

/** A pending human-input request was answered (or canceled). */
export interface HumanInputResolvedEvent extends IterationTagged {
  kind: "human_input_resolved";
  phaseId: string;
  stepId: string;
  /** The accepted value (capped for transport); absent when canceled. */
  value?: string;
  /** Who answered (e.g. `"human:web"`, `"headless:--human"`). */
  by?: string;
  /** True when no value arrived (run canceled, headless without a value). */
  canceled?: boolean;
  /** Whether this answered a `human` step or an agent's question. */
  origin: "human-step" | "agent-question";
  ts: number;
}

/**
 * The engine acknowledged a pause request and stopped scheduling new steps.
 * In-flight steps still run to completion; the run stays parked until a
 * matching {@link RunResumedEvent}. In loop workflows the acknowledgement
 * lands at the next phase boundary (a phase is the scheduling unit there).
 */
export interface RunPausedEvent {
  kind: "run_paused";
  /** Who requested the pause (e.g. `"human:tui"`, `"human:web"`). */
  by?: string;
  ts: number;
}

/** A paused run resumed scheduling steps. */
export interface RunResumedEvent {
  kind: "run_resumed";
  /** Who requested the resume. */
  by?: string;
  ts: number;
}

/**
 * A mid-run edit to a not-yet-started step was accepted while the run was
 * paused. The patch applies when the step executes; recording it here keeps a
 * steered run an honest, auditable record.
 */
export interface StepEditedEvent {
  kind: "step_edited";
  stepId: string;
  /**
   * The accepted field changes. This IS `StepEditPatch` — the control pushes the
   * cleaned patch straight into this event, so the two must never drift (a
   * field added to the patch and forgotten here would be carried at runtime and
   * invisible to every consumer and to the recorded interventions). The import
   * is type-only in both directions, so the cycle with control.ts is erased.
   */
  patch: StepEditPatch;
  /** Who made the edit (e.g. `"human:tui"`, `"human:web"`, `"human:cli"`). */
  by?: string;
  ts: number;
}

/**
 * A running step was killed on request. The step fails with `killed` set on
 * its result and the run carries on scheduling — that is the whole point of
 * killing one step rather than cancelling the run. Emitted the moment the
 * abort is delivered; the step's own `step_done` follows once it unwinds.
 */
export interface StepKilledEvent {
  kind: "step_killed";
  stepId: string;
  /** Who killed it (e.g. `"human:web"`, `"human:tui"`). */
  by?: string;
  ts: number;
}

export type WorkflowEvent =
  | WorkflowStartEvent
  | PhaseStartEvent
  | StepStartEvent
  | StepWorkspaceEvent
  | FanOutEvent
  | StepStreamEvent
  | StepRetryEvent
  | GateEvaluatedEvent
  | StepDoneEvent
  | PhaseDoneEvent
  | WorkflowDoneEvent
  | LoopIterationEvent
  | BudgetExceededEvent
  | ApprovalPendingEvent
  | ApprovalResolvedEvent
  | HumanInputPendingEvent
  | HumanInputResolvedEvent
  | RunPausedEvent
  | RunResumedEvent
  | StepEditedEvent
  | StepKilledEvent;

export type WorkflowEventKind = WorkflowEvent["kind"];
