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
}

export interface HistoryPhase {
  phaseId: string;
  title: string;
  index: number;
  stepCount: number;
  steps: HistoryStep[];
  done: boolean;
  ok: boolean;
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

/** Roll up per-step metrics, counting leaf steps only (fan-out parents excluded). */
export function computeRunTotals(phases: HistoryPhase[]): RunTotals {
  const totals: RunTotals = { steps: 0, ok: 0, failed: 0, cached: 0, costUsd: 0, durationMs: 0 };
  for (const phase of phases) {
    for (const step of phase.steps) {
      // A fan-out parent is summarized by its children, which appear as their
      // own steps; counting the parent too would double-count.
      if (step.result?.childResults?.length) continue;
      totals.steps += 1;
      if (step.status === "error") totals.failed += 1;
      else if (step.status === "done") totals.ok += 1;
      if (step.cached) totals.cached += 1;
      if (step.result?.costUsd) totals.costUsd += step.result.costUsd;
      if (step.result?.durationMs) totals.durationMs += step.result.durationMs;
    }
  }
  return totals;
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
        });
        break;
      case "step_start": {
        const phase = this.phaseOf(event.phaseId);
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
        });
        break;
      }
      case "step_event": {
        const step = this.stepOf(event.phaseId, event.stepId);
        if (!step) break;
        if (event.event.kind === "text_delta" && !event.event.thinking) {
          step.text = capText(step.text + event.event.text);
        }
        break;
      }
      case "gate_evaluated": {
        const step = this.stepOf(event.phaseId, event.stepId);
        if (!step) break;
        step.gate = { passed: event.passed, target: event.target, onFalse: event.onFalse };
        break;
      }
      case "step_done": {
        const step = this.stepOf(event.phaseId, event.stepId);
        if (!step) break;
        step.status = event.result.ok ? "done" : "error";
        step.result = event.result;
        step.cached = event.cached;
        if (!step.text) step.text = capText(event.result.output ?? "");
        break;
      }
      case "phase_done": {
        const phase = this.phaseOf(event.phaseId);
        if (phase) {
          phase.done = true;
          phase.ok = event.ok;
        }
        break;
      }
      case "workflow_done":
        this.ok = event.ok;
        break;
    }
  }

  build(opts: { status: RunRecordStatus; error?: string; endedAt?: number }): RunRecord {
    const endedAt = opts.endedAt ?? Date.now();
    return {
      version: RUN_RECORD_VERSION,
      id: this.meta.id,
      workflow: this.name ?? this.meta.workflow,
      input: this.meta.input,
      cwd: this.meta.cwd,
      status: opts.status,
      ok: opts.status === "done" && this.ok,
      startedAt: this.startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - this.startedAt),
      phases: this.phases,
      totals: computeRunTotals(this.phases),
      error: opts.error,
    };
  }

  private phaseOf(phaseId: string): HistoryPhase | undefined {
    return this.phases.find((p) => p.phaseId === phaseId);
  }

  private stepOf(phaseId: string, stepId: string): HistoryStep | undefined {
    return this.phaseOf(phaseId)?.steps.find((s) => s.stepId === stepId);
  }
}
