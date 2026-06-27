import type { AgentId } from "../types/events";
import type { WorkflowEvent } from "./events";
import type { GateStep, StepResult, WorkflowItem, WorkflowStepKind } from "./types";

/**
 * The history record model: a serializable snapshot of one completed workflow
 * run, built by folding the same {@link WorkflowEvent} stream the TUI and web UI
 * render live. It deliberately mirrors the TUI's phase -> step render tree so a
 * saved run can be replayed into the existing `WorkflowView` components.
 */

export const RUN_RECORD_VERSION = 1;
/** Cap stored per-step output so a single record can't grow unbounded. */
export const MAX_STEP_TEXT = 20_000;

export type RunStepStatus = "pending" | "running" | "done" | "error";

export interface HistoryStep {
  stepId: string;
  blockKind: WorkflowStepKind;
  agent?: AgentId;
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
  cached: boolean;
  /** Total attempts this step took (auto-retry); omitted/1 means it ran once. */
  attempts?: number;
  /** A loop-back gate's target phase, when this step is such a gate. */
  loopTo?: string;
  /** The gate's own iteration cap, when this step is a loop-back gate. */
  maxIterations?: number;
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
export type RunRecordStatus = "done" | "error" | "canceled";

export interface RunTotals {
  steps: number;
  ok: number;
  failed: number;
  cached: number;
  costUsd: number;
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
  status: RunRecordStatus;
  ok: boolean;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  phases: HistoryPhase[];
  totals: RunTotals;
  error?: string;
}

/** The lightweight shape used for history list views (record minus the tree). */
export interface RunRecordSummary {
  version: number;
  id: string;
  workflow: string;
  input: string;
  cwd: string;
  status: RunRecordStatus;
  ok: boolean;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  totals: RunTotals;
  error?: string;
}

export function runRecordSummary(record: RunRecord): RunRecordSummary {
  const { phases: _phases, ...summary } = record;
  return summary;
}

/** Roll up per-step metrics, counting leaf steps that actually ran. */
export function computeRunTotals(phases: HistoryPhase[]): RunTotals {
  const totals: RunTotals = { steps: 0, ok: 0, failed: 0, cached: 0, costUsd: 0, durationMs: 0 };
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
      if (step.status === "error") totals.failed += 1;
      else if (step.status === "done") totals.ok += 1;
      if (step.cached) totals.cached += 1;
      if (step.result?.costUsd) totals.costUsd += step.result.costUsd;
      if (step.result?.durationMs) phaseMaxDuration = Math.max(phaseMaxDuration, step.result.durationMs);
    }
    totals.durationMs += phaseMaxDuration;
  }
  return totals;
}

/**
 * The canonical one-line run summary ("X/Y ok · N failed · …") shared by the
 * CLI, TUI, and (mirrored in JS) the web UI, so all three surfaces format the
 * same totals identically. Duration is opt-in because list views show the run's
 * wall-clock time while detail views render it separately.
 */
export function formatRunTotals(
  totals: RunTotals,
  opts?: { durationMs?: number; cached?: boolean },
): string {
  const parts = [`${totals.ok}/${totals.steps} ok`];
  if (totals.failed > 0) parts.push(`${totals.failed} failed`);
  if (opts?.cached && totals.cached > 0) parts.push(`${totals.cached} cached`);
  if (typeof opts?.durationMs === "number") parts.push(`${(opts.durationMs / 1000).toFixed(1)}s`);
  if (totals.costUsd > 0) parts.push(`$${totals.costUsd.toFixed(4)}`);
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
  private ok = true;

  constructor(meta: RunRecordMeta, startedAt: number = Date.now()) {
    this.meta = meta;
    this.startedAt = startedAt;
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
        this.startedAt = event.ts;
        this.phases = [];
        this.ok = true;
        break;
      case "phase_start":
        this.phases.push({
          phaseId: event.phaseId,
          title: event.title,
          index: event.index,
          stepCount: event.stepCount,
          steps: [],
          done: false,
          ok: true,
          iteration: event.iteration,
        });
        break;
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
        break;
      }
      case "gate_evaluated": {
        const step = this.stepOf(event.phaseId, event.stepId, event.iteration);
        if (!step) break;
        step.gate = { passed: event.passed, target: event.target, onFalse: event.onFalse };
        break;
      }
      case "step_done": {
        const step = this.stepOf(event.phaseId, event.stepId, event.iteration);
        if (!step) break;
        step.status = event.result.ok ? "done" : "error";
        step.result = event.result;
        step.cached = event.cached;
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
      case "workflow_done":
        this.ok = event.ok;
        break;
      case "loop_iteration":
        // Marker only; the phase/step events around the jump already update
        // the tree.
        break;
    }
  }

  build(opts: { status: RunRecordStatus; error?: string; endedAt?: number }): RunRecord {
    const endedAt = opts.endedAt ?? Date.now();
    const phases = this.finalizePhases();
    return {
      version: RUN_RECORD_VERSION,
      id: this.meta.id,
      workflow: this.name ?? this.meta.workflow,
      input: this.meta.input,
      cwd: this.meta.cwd,
      specHash: this.meta.specHash,
      status: opts.status,
      ok: opts.status === "done" && this.ok,
      startedAt: this.startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - this.startedAt),
      phases,
      totals: computeRunTotals(phases),
      error: opts.error,
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
    return this.phases.find(
      (p) => p.phaseId === phaseId && (p.iteration ?? 1) === (iteration ?? 1),
    );
  }

  private stepOf(phaseId: string, stepId: string, iteration?: number): HistoryStep | undefined {
    return this.phaseOf(phaseId, iteration)?.steps.find((s) => s.stepId === stepId);
  }
}
