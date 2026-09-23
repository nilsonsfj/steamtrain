import type { AgentInstanceId, TokenUsage } from "../types/events";
import type { ApprovalRejectDisposition } from "./approval";
import type { StepEditPatch } from "./control";
import { addTokensInto, emptyTokens, formatTokens, totalTokens } from "./cost";
import type { WorkflowEvent } from "./events";
import type {
  AgentWorktreeInfo,
  GateStep,
  StepResult,
  WorkflowItem,
  WorkflowStepKind,
} from "./types";

/**
 * The history record model: a serializable snapshot of one completed workflow
 * run, built by folding the same {@link WorkflowEvent} stream the TUI and web UI
 * render live. It deliberately mirrors the TUI's phase -> step render tree so a
 * saved run can be replayed into the existing `WorkflowView` components.
 */

/**
 * 2: steps a canceled run took down carry `result.interrupted` (the engine
 * sets it; v1 records are migrated on read, see history-store).
 */
export const RUN_RECORD_VERSION = 2;
/** Cap stored per-step output so a single record can't grow unbounded. */
export const MAX_STEP_TEXT = 20_000;

export type RunStepStatus = "pending" | "running" | "done" | "error";

export interface HistoryStep {
  stepId: string;
  blockKind: WorkflowStepKind;
  agent?: AgentInstanceId;
  /** API instance a direct-inference `llm` step called (agent steps carry `agent` instead). */
  api?: string;
  model?: string;
  effort?: string;
  cwd?: string;
  /** Earlier steps whose outputs fed this step. */
  dependsOn?: string[];
  parentStepId?: string;
  item?: WorkflowItem;
  status: RunStepStatus;
  /** The step's output (final result text, or the streamed tail if unfinished). */
  text: string;
  result?: StepResult;
  gate?: { passed: boolean; target?: string; onFalse?: GateStep["onFalse"] };
  /**
   * Human-approval checkpoint decision, when this step is an `approval` step or
   * a `gate` with `condition.human`. Records who decided and how, so the history
   * viewer can show the checkpoint outcome.
   */
  approval?: {
    approved?: boolean;
    by?: string;
    note?: string;
    reviewStepId?: string;
    onReject?: ApprovalRejectDisposition;
  };
  /**
   * Human-input outcome, when this step is a `human` step or a `canAsk` agent
   * step that asked a clarifying question. Records the ask and who answered,
   * so the history viewer shows the exchange. The `outputSchema` is
   * deliberately NOT recorded: replayed records are terminal (no form to
   * render), and the schema lives in the spec.
   */
  humanInput?: {
    prompt?: string;
    choices?: string[];
    origin?: "human-step" | "agent-question";
    /** The ask attempt the record settled on (>1 ⇒ earlier answers were rejected). */
    attempt?: number;
    /** Why the previous attempt's answer was rejected, when the last ask was a re-ask. */
    retryError?: string;
    value?: string;
    by?: string;
    canceled?: boolean;
  };
  cached: boolean;
  /** Total attempts this step took (auto-retry); omitted/1 means it ran once. */
  attempts?: number;
  /** Isolated worktree metadata for agent-backed steps. */
  worktree?: AgentWorktreeInfo;
  /** A loop-back gate's target phase, when this step is such a gate. */
  loopTo?: string;
  /** The gate's own iteration cap, when this step is a loop-back gate. */
  maxIterations?: number;
  /** True when a mid-run edit (pause → edit → resume) applied to this step. */
  edited?: boolean;
}

/**
 * One mid-run steering action, recorded in order so a steered run stays an
 * honest, auditable record: when it was paused/resumed and exactly what each
 * accepted step edit changed.
 */
export interface RunIntervention {
  kind: "paused" | "resumed" | "step-edited" | "step-killed" | "takeover";
  /** The affected step (kinds `"step-edited"`, `"step-killed"` and `"takeover"`). */
  stepId?: string;
  /** The accepted patch (kind `"step-edited"` only). */
  patch?: StepEditPatch;
  /** Who acted (e.g. `"human:tui"`, `"human:web"`, `"human:cli"`). */
  by?: string;
  ts: number;
  /** Interactive-takeover details (kind `"takeover"` only). */
  takeover?: {
    /** The recorded agent session that was resumed, when one existed. */
    sessionId?: string;
    /** True when the session was resumed (vs. a fresh interactive session). */
    resumed?: boolean;
    /** When the interactive session ended. */
    endedAt?: number;
    /** The interactive CLI's exit code, when it exited normally. */
    exitCode?: number;
  };
}

export interface HistoryPhase {
  phaseId: string;
  title: string;
  index: number;
  stepCount: number;
  steps: HistoryStep[];
  done: boolean;
  ok: boolean;
  /** Loop iteration (1-based) this phase instance belongs to; omitted ⇒ 1. */
  iteration?: number;
}

/** Terminal outcome of a run (mirrors the web run manager, minus "running"). */
export type RunRecordStatus = "done" | "error" | "canceled" | "budget-exceeded";

export interface RunTotals {
  steps: number;
  ok: number;
  /** Steps that broke on their own; a step the run's cancel took down is not one. */
  failed: number;
  /** Steps the run's cancel or timeout took down mid-flight (absent on older records). */
  interrupted?: number;
  cached: number;
  costUsd: number;
  /** Aggregate token usage across all leaf steps (fan-out children, not parents). */
  tokens: Required<TokenUsage>;
  durationMs: number;
}

export interface RunRecord {
  version: number;
  id: string;
  workflow: string;
  input: string;
  cwd: string;
  /** Hash of the workflow spec at run time; enables drift-safe retry-failed. */
  specHash?: string;
  /** Resolved input params; stored so --from reruns can reproduce them. */
  params?: Record<string, string | number | boolean>;
  status: RunRecordStatus;
  ok: boolean;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  phases: HistoryPhase[];
  totals: RunTotals;
  error?: string;
  /**
   * Set on a canceled run its whole-workflow timeout stopped, not a person;
   * `status` stays "canceled" for both.
   */
  timedOut?: boolean;
  /** Set when a cost budget stopped the run; drives the "budget-exceeded" status. */
  budget?: RunBudgetInfo;
  /** What happened to this run's step worktrees after the run (CLI apply/prune). */
  harvest?: RunHarvestInfo;
  /** Mid-run steering actions (pause/resume/step edits), in order. */
  interventions?: RunIntervention[];
}

/** Post-run worktree harvesting status, recorded by `workflow history apply/prune`. */
export interface RunHarvestInfo {
  /** Steps whose worktree changes were delivered (applied / branched / PR'd). */
  appliedSteps?: string[];
  appliedAt?: number;
  /** Branch the merged state was left on, when harvested with mode "branch"/"pr". */
  branch?: string;
  /** Pull request opened for the merged state, when harvested with mode "pr". */
  prUrl?: string;
  /** Set once the run's worktrees/branches were pruned (discarded). */
  prunedAt?: number;
}

/** The cost-budget breach that ended a run (workflow- or step-level `maxCostUsd`). */
export interface RunBudgetInfo {
  scope: "workflow" | "step";
  stepId?: string;
  limitUsd: number;
  spentUsd: number;
}

/** The lightweight shape used for history list views (record minus the tree). */
export type RunRecordSummary = Omit<RunRecord, "phases">;

export function runRecordSummary(record: RunRecord): RunRecordSummary {
  const { phases: _phases, ...summary } = record;
  return summary;
}

/** Roll up per-step metrics, counting leaf steps that actually ran. */
export function computeRunTotals(phases: HistoryPhase[]): RunTotals {
  const totals: RunTotals = {
    steps: 0,
    ok: 0,
    failed: 0,
    interrupted: 0,
    cached: 0,
    costUsd: 0,
    tokens: emptyTokens(),
    durationMs: 0,
  };
  for (const phase of phases) {
    let phaseMaxDuration = 0;
    for (const step of phase.steps) {
      // A fan-out parent is summarized by its children, which appear as their
      // own steps; counting the parent too would double-count.
      if (step.result?.childResults?.length) continue;
      // Steps that never dispatched (the run ended early) are recorded as
      // placeholders so the tree shows them as not-run — but they didn't
      // execute, so they don't contribute to the executed-step totals.
      if (step.status === "pending") continue;
      totals.steps += 1;
      if (step.status === "error") {
        if (step.result?.interrupted) totals.interrupted = (totals.interrupted ?? 0) + 1;
        else totals.failed += 1;
      } else if (step.status === "done") totals.ok += 1;
      if (step.cached) totals.cached += 1;
      // A cached replay was billed to the run that produced it, not this one.
      else {
        if (step.result?.costUsd) totals.costUsd += step.result.costUsd;
        addTokensInto(totals.tokens, step.result?.tokens);
      }
      if (step.result?.durationMs)
        phaseMaxDuration = Math.max(phaseMaxDuration, step.result.durationMs);
    }
    totals.durationMs += phaseMaxDuration;
  }
  return totals;
}

/** How many recorded runs each runner took part in (settings' Runs column). */
export interface RunnerUsage {
  /** Runs scanned, so a count can be read as "N of these". */
  runs: number;
  /** Runner id → runs it ran at least one step in. */
  counts: Record<string, number>;
}

/**
 * Tally which runners actually did work, per run rather than per step: the
 * question the settings table asks is "how much is this runner used", and a
 * fan-out of thirty steps onto one agent is still one run's worth of evidence.
 * A runner that appears twice in the same run is therefore counted once.
 */
export function tallyRunnerUsage(records: Iterable<RunRecord>): RunnerUsage {
  const usage: RunnerUsage = { runs: 0, counts: {} };
  for (const record of records) {
    usage.runs += 1;
    const seen = new Set<string>();
    for (const phase of record.phases ?? []) {
      for (const step of phase.steps ?? []) {
        // Cached steps replayed a previous run's work; the runner did not run
        // this time, and counting it would inflate a busy-looking agent.
        if (step.cached || step.status === "pending" || !step.agent) continue;
        seen.add(step.agent);
      }
    }
    for (const agent of seen) usage.counts[agent] = (usage.counts[agent] ?? 0) + 1;
  }
  return usage;
}

/**
 * The canonical one-line run summary ("X/Y ok · N failed · …") shared by the
 * CLI, TUI, and (mirrored in JS) the web UI, so all three surfaces format the
 * same totals identically. Duration is opt-in because list views show the run's
 * wall-clock time while detail views render it separately.
 */
export function formatRunTotals(
  totals: RunTotals,
  opts?: { durationMs?: number; cached?: boolean; tokens?: boolean },
): string {
  const parts = [`${totals.ok}/${totals.steps} ok`];
  if (totals.failed > 0) parts.push(`${totals.failed} failed`);
  if (totals.interrupted) parts.push(`${totals.interrupted} interrupted`);
  if (opts?.cached && totals.cached > 0) parts.push(`${totals.cached} cached`);
  if (typeof opts?.durationMs === "number") parts.push(`${(opts.durationMs / 1000).toFixed(1)}s`);
  if (totals.costUsd > 0) parts.push(`$${totals.costUsd.toFixed(4)}`);
  if (opts?.tokens) {
    const tok = totalTokens(totals.tokens);
    if (tok > 0) parts.push(`${formatTokens(tok)} tok`);
  }
  return parts.join(" · ");
}

function capText(text: string): string {
  if (text.length <= MAX_STEP_TEXT) return text;
  return `${text.slice(0, MAX_STEP_TEXT)}\n… [truncated ${text.length - MAX_STEP_TEXT} chars]`;
}

export interface RunRecordMeta {
  id: string;
  workflow: string;
  input: string;
  cwd: string;
  specHash?: string;
  /** Resolved input params; stored so --from reruns can reproduce them. */
  params?: Record<string, string | number | boolean>;
}

/**
 * Folds a workflow's {@link WorkflowEvent} stream into a {@link RunRecord}. Each
 * driver (CLI, web run manager, TUI) feeds events as they arrive, then calls
 * {@link build} once the run settles. Streamed assistant text is accumulated so
 * a cancelled/failed step still shows its partial output.
 */
export class RunRecordBuilder {
  private readonly meta: RunRecordMeta;
  private name?: string;
  private startedAt: number;
  private phases: HistoryPhase[] = [];
  private phaseIndex = new Map<string, HistoryPhase>();
  private ok = true;
  private budget?: RunBudgetInfo;
  private interventions: RunIntervention[] = [];
  /** Set by {@link continueFrom}: the next `workflow_start` keeps the tree. */
  private continuing = false;

  constructor(meta: RunRecordMeta, startedAt: number = Date.now()) {
    this.meta = meta;
    this.startedAt = startedAt;
  }

  /**
   * Fold a previous owner's events before this process takes over the run
   * (a mid-run detach). The new owner re-runs the workflow from the top, so
   * its `workflow_start` would wipe the tree; after this call it does not.
   * A phase pass the new owner emits again (a replayed phase, or the pass
   * the handoff cut short) replaces the earlier copy in place, and the loop
   * passes the previous owner finished stay in the record with their spend.
   */
  continueFrom(events: Iterable<WorkflowEvent>): void {
    for (const event of events) this.handle(event);
    this.continuing = this.phases.length > 0;
  }

  /**
   * Fold one event into the record tree. This deliberately mirrors the live
   * `workflowReducer` (src/tui/workflow-state.ts) so a replayed record matches
   * what was shown during the run — the same fan-out `stepCount` bump and the
   * same non-thinking text accumulation. The two folds are kept in lockstep by
   * `tests/workflow-history.test.ts` ("builder tree matches the live reducer"),
   * which fails if they diverge; unifying them into one shared, UI-agnostic
   * reducer is tracked as the run-fold half of TUI-WEBUI-DIFFERENCES.md §5.1.
   */
  handle(event: WorkflowEvent): void {
    switch (event.kind) {
      case "workflow_start":
        this.name = event.name;
        if (this.continuing) {
          this.continuing = false;
          break;
        }
        this.startedAt = event.ts;
        this.phases = [];
        this.phaseIndex.clear();
        this.ok = true;
        this.budget = undefined;
        this.interventions = [];
        break;
      case "phase_start": {
        const phase: HistoryPhase = {
          phaseId: event.phaseId,
          title: event.title,
          index: event.index,
          stepCount: event.stepCount,
          steps: [],
          done: false,
          ok: true,
          iteration: event.iteration,
        };
        const key = `${event.phaseId}:${event.iteration ?? 1}`;
        // Only a run handed to a new owner repeats a pass (see continueFrom).
        const earlier = this.phaseIndex.get(key);
        if (earlier) this.phases[this.phases.indexOf(earlier)] = phase;
        else this.phases.push(phase);
        this.phaseIndex.set(key, phase);
        break;
      }
      case "fan_out": {
        const phase = this.phaseOf(event.phaseId, event.iteration);
        if (!phase) break;
        // The parent step is already counted; reserve room for its children so a
        // run canceled mid-fan-out still knows how many were expected.
        phase.stepCount = Math.max(phase.stepCount, phase.steps.length + event.count);
        break;
      }
      case "step_start": {
        const phase = this.phaseOf(event.phaseId, event.iteration);
        if (!phase) break;
        if (event.parentStepId) {
          phase.stepCount = Math.max(phase.stepCount, phase.steps.length + 1);
        }
        phase.steps.push({
          stepId: event.stepId,
          blockKind: event.blockKind ?? "worker",
          agent: event.agent,
          api: event.api,
          model: event.model,
          effort: event.effort,
          cwd: event.cwd,
          dependsOn: event.dependsOn,
          parentStepId: event.parentStepId,
          item: event.item,
          status: "running",
          text: "",
          cached: false,
          loopTo: event.loopTo,
          maxIterations: event.maxIterations,
        });
        break;
      }
      case "step_workspace": {
        const step = this.stepOf(event.phaseId, event.stepId, event.iteration);
        if (!step) break;
        // Record the live workspace so a run canceled mid-step still shows
        // where the step was working; step_done overwrites with the result's
        // authoritative copy when the step finishes.
        step.cwd = event.cwd;
        if (event.worktree) step.worktree = event.worktree;
        break;
      }
      case "step_event": {
        const step = this.stepOf(event.phaseId, event.stepId, event.iteration);
        if (!step) break;
        if (event.event.kind === "text_delta" && !event.event.thinking) {
          step.text = capText(step.text + event.event.text);
        }
        break;
      }
      case "step_retry": {
        const step = this.stepOf(event.phaseId, event.stepId, event.iteration);
        if (!step) break;
        // The failed attempt just completed; the next one is about to start.
        step.attempts = event.attempt + 1;
        // Failover updates the live binding here. `step_done` does not carry
        // agent/model — by the final attempt these fields already reflect the
        // model that actually ran (or the original, when no failover occurred).
        if (event.failover) {
          step.agent = event.failover.toAgent;
          step.model = event.failover.toModel;
          if (event.failover.toEffort !== undefined) step.effort = event.failover.toEffort;
        }
        break;
      }
      case "gate_evaluated": {
        const step = this.stepOf(event.phaseId, event.stepId, event.iteration);
        if (!step) break;
        step.gate = { passed: event.passed, target: event.target, onFalse: event.onFalse };
        break;
      }
      case "approval_pending": {
        const step = this.stepOf(event.phaseId, event.stepId, event.iteration);
        if (!step) break;
        step.approval = {
          ...step.approval,
          reviewStepId: event.reviewStepId,
          onReject: event.onReject,
        };
        break;
      }
      case "approval_resolved": {
        const step = this.stepOf(event.phaseId, event.stepId, event.iteration);
        if (!step) break;
        step.approval = {
          ...step.approval,
          approved: event.approved,
          by: event.by,
          note: event.note,
        };
        break;
      }
      case "human_input_pending": {
        const step = this.stepOf(event.phaseId, event.stepId, event.iteration);
        if (!step) break;
        step.humanInput = {
          ...step.humanInput,
          prompt: event.prompt,
          choices: event.choices,
          origin: event.origin,
          attempt: event.attempt,
          retryError: event.retryError,
        };
        break;
      }
      case "human_input_resolved": {
        const step = this.stepOf(event.phaseId, event.stepId, event.iteration);
        if (!step) break;
        step.humanInput = {
          ...step.humanInput,
          value: event.value,
          by: event.by,
          canceled: event.canceled,
        };
        break;
      }
      case "step_done": {
        const step = this.stepOf(event.phaseId, event.stepId, event.iteration);
        if (!step) break;
        step.status = event.result.ok ? "done" : "error";
        step.result = event.result;
        step.worktree = event.result.worktree;
        step.cached = event.cached;
        if (event.result.edited) step.edited = true;
        if (!step.text) step.text = capText(event.result.output ?? "");
        // Prefer the authoritative count from the result; fall back to any
        // count accrued from step_retry events.
        if (event.result.attempts !== undefined) step.attempts = event.result.attempts;
        break;
      }
      case "phase_done": {
        const phase = this.phaseOf(event.phaseId, event.iteration);
        if (phase) {
          phase.done = true;
          phase.ok = event.ok;
        }
        break;
      }
      case "budget_exceeded":
        // Keep the first breach (the one that stopped scheduling).
        this.budget ??= {
          scope: event.scope,
          stepId: event.stepId,
          limitUsd: event.limitUsd,
          spentUsd: event.spentUsd,
        };
        break;
      case "workflow_done":
        this.ok = event.ok;
        break;
      case "run_paused":
        this.interventions.push({ kind: "paused", by: event.by, ts: event.ts });
        break;
      case "run_resumed":
        this.interventions.push({ kind: "resumed", by: event.by, ts: event.ts });
        break;
      case "step_edited":
        this.interventions.push({
          kind: "step-edited",
          stepId: event.stepId,
          patch: event.patch,
          by: event.by,
          ts: event.ts,
        });
        break;
      case "step_killed":
        this.interventions.push({
          kind: "step-killed",
          stepId: event.stepId,
          by: event.by,
          ts: event.ts,
        });
        break;
      case "loop_iteration":
        // Marker only; the phase/step events around the jump already update
        // the tree.
        break;
    }
  }

  build(opts: {
    status: RunRecordStatus;
    error?: string;
    endedAt?: number;
    timedOut?: boolean;
  }): RunRecord {
    const endedAt = opts.endedAt ?? Date.now();
    const phases = this.finalizePhases();
    return {
      version: RUN_RECORD_VERSION,
      id: this.meta.id,
      workflow: this.name ?? this.meta.workflow,
      input: this.meta.input,
      cwd: this.meta.cwd,
      specHash: this.meta.specHash,
      params: this.meta.params,
      status: opts.status,
      ok: opts.status === "done" && this.ok,
      startedAt: this.startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - this.startedAt),
      phases,
      totals: computeRunTotals(phases),
      error: opts.error,
      timedOut: opts.status === "canceled" && opts.timedOut ? true : undefined,
      budget: this.budget,
      interventions: this.interventions.length > 0 ? this.interventions : undefined,
    };
  }

  /**
   * Reconcile the recorded tree into a self-consistent terminal snapshot. The
   * run is over by the time {@link build} is called, so no phase or step may be
   * left mid-flight:
   *  - a step still `"running"` (the run was canceled/crashed before its
   *    `step_done`) is recorded as `"error"` — it never completed;
   *  - steps that were scheduled but never dispatched (the run ended before the
   *    pool reached them) are added as `"pending"` placeholders so the tree
   *    shows them as not-run rather than silently dropping them;
   *  - every started phase is marked `done`, with `ok` reflecting whether all of
   *    its steps actually succeeded.
   * This guarantees the history viewer never renders an "impossible" live state
   * (e.g. a finished run with a spinning step) when it replays the record.
   */
  private finalizePhases(): HistoryPhase[] {
    return this.phases.map((phase) => {
      const steps: HistoryStep[] = phase.steps.map((step) =>
        step.status === "running" ? { ...step, status: "error" as const } : step,
      );
      // Steps reserved but never dispatched (the run ended before the pool
      // reached them) show as not-run placeholders. `phase.stepCount` carries
      // the full expected count: static steps from `phase_start`, and fan-out
      // (`forEach`) children from the `fan_out` event, so canceling mid-fan-out
      // still records the children that were queued but never started.
      const missing = Math.max(0, phase.stepCount - steps.length);
      for (let i = 0; i < missing; i++) {
        steps.push({
          stepId: `${phase.phaseId}::unstarted-${i}`,
          blockKind: "worker",
          status: "pending",
          text: "",
          cached: false,
        });
      }
      const ok = phase.done ? phase.ok : steps.every((step) => step.status === "done");
      return { ...phase, steps, done: true, ok };
    });
  }

  private phaseOf(phaseId: string, iteration?: number): HistoryPhase | undefined {
    return this.phaseIndex.get(`${phaseId}:${iteration ?? 1}`);
  }

  private stepOf(phaseId: string, stepId: string, iteration?: number): HistoryStep | undefined {
    return this.phaseOf(phaseId, iteration)?.steps.find((s) => s.stepId === stepId);
  }
}
