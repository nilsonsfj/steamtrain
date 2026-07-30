import type { WorkflowEvent } from "./events";
import type { PhaseState, StepState, WorkflowState } from "./reducer";

/**
 * One narration line — a pure UI projection of a WorkflowEvent. Never load-bearing:
 * turning narration off must not hide any run state.
 */
export interface NarrationLine {
  /** Stable id for list keys / dedupe (event kind + phase/iteration + step + ts). */
  id: string;
  /** Past-tense, one-clause copy. */
  text: string;
  ts: number;
  stepId?: string;
  phaseId?: string;
  /** Loop iteration of the referenced phase; omitted implies the first pass. */
  iteration?: number;
}

/** Max lines kept in the live ticker (UI may show fewer). */
export const NARRATION_CAP = 40;

/**
 * Project a single workflow event into at most one narration line.
 * Returns null for noisy / non-story events (stream chunks, workspace, etc.).
 */
export function narrateEvent(ev: WorkflowEvent): NarrationLine | null {
  switch (ev.kind) {
    case "workflow_start":
      return line(ev, `Started ${ev.name} — ${ev.stepCount} step${ev.stepCount === 1 ? "" : "s"}.`);
    case "phase_start":
      return line(ev, `Entered ${phaseName(ev.title)}.`, { phaseId: ev.phaseId });
    case "step_start":
      return line(ev, stepStartCopy(ev), { phaseId: ev.phaseId, stepId: ev.stepId });
    case "fan_out":
      return line(
        ev,
        `${ev.count} step${ev.count === 1 ? "" : "s"} branched from '${ev.parentStepId}'.`,
        { phaseId: ev.phaseId, stepId: ev.parentStepId },
      );
    case "gate_evaluated":
      return line(ev, gateCopy(ev), { phaseId: ev.phaseId, stepId: ev.stepId });
    case "step_done":
      return line(ev, stepDoneCopy(ev), { phaseId: ev.phaseId, stepId: ev.stepId });
    case "phase_done":
      // phase_done carries only phaseId (no title) — keep the id, which matches
      // the phase labels users already saw on phase_start.
      return line(ev, ev.ok ? `Finished ${ev.phaseId}.` : `Held at ${ev.phaseId}.`, {
        phaseId: ev.phaseId,
      });
    case "workflow_done":
      return line(
        ev,
        ev.ok
          ? "Run complete — arrival report ready."
          : ev.budgetExceeded
            ? "Stopped — cost budget reached."
            : "Stopped before finishing.",
      );
    case "step_retry":
      return line(
        ev,
        ev.failover
          ? `Step '${ev.stepId}' failing over ${ev.failover.fromAgent}/${ev.failover.fromModel} → ${ev.failover.toAgent}/${ev.failover.toModel} (${ev.failover.failureKind}).`
          : `Step '${ev.stepId}' will try again (${ev.attempt}/${ev.maxAttempts}).`,
        {
          phaseId: ev.phaseId,
          stepId: ev.stepId,
        },
      );
    default:
      return null;
  }
}

/** Append a narration line for `ev`, capped at {@link NARRATION_CAP}. */
export function appendNarration(lines: NarrationLine[], ev: WorkflowEvent): NarrationLine[] {
  const next = narrateEvent(ev);
  if (!next) return lines;
  // Keep every visible line addressable: loop/retry events can legitimately
  // produce the same base id even when they are not adjacent.
  let suffix = lines.length;
  while (lines.some((line) => line.id === next.id)) {
    next.id = `${next.id}-${suffix++}`;
  }
  const out =
    lines.length >= NARRATION_CAP ? lines.slice(lines.length - NARRATION_CAP + 1) : [...lines];
  out.push(next);
  return out;
}

/**
 * Reconstruct a compact narration from a folded run state (history / late join).
 * Prefer live {@link appendNarration} during streaming — this is a fallback.
 */
export function narrateFromState(state: WorkflowState): NarrationLine[] {
  const lines: NarrationLine[] = [];
  if (state.started && state.name) {
    const stepCount = state.phases.reduce((n, p) => n + p.steps.length, 0);
    lines.push({
      id: `workflow_start-${state.name}`,
      text: `Started ${state.name} — ${stepCount} step${stepCount === 1 ? "" : "s"}.`,
      ts: 0,
    });
  }
  for (const phase of state.phases) {
    lines.push({
      id: `phase_start-${phase.phaseId}-${phase.iteration ?? 1}`,
      text: `Entered ${phaseName(phase.title)}.`,
      ts: 0,
      phaseId: phase.phaseId,
      iteration: phase.iteration ?? 1,
    });
    for (const step of phase.steps) {
      const done = narrateStepFromState(phase, step);
      if (done) lines.push(done);
    }
  }
  if (state.done) {
    lines.push({
      id: `workflow_done-${state.ok ? "ok" : "fail"}`,
      text: state.ok
        ? "Run complete — arrival report ready."
        : state.budget
          ? "Stopped — cost budget reached."
          : "Stopped before finishing.",
      ts: 0,
    });
  }
  return lines.slice(-NARRATION_CAP);
}

function narrateStepFromState(phase: PhaseState, step: StepState): NarrationLine | null {
  if (step.status === "pending") return null;
  if (step.status === "running") {
    return {
      id: `step_start-${phase.phaseId}-${phase.iteration ?? 1}-${step.stepId}`,
      text: stepStartCopy({
        stepId: step.stepId,
        blockKind: step.blockKind,
        agent: step.agent,
      }),
      ts: step.startedAt ?? 0,
      phaseId: phase.phaseId,
      stepId: step.stepId,
      iteration: phase.iteration ?? 1,
    };
  }
  return {
    id: `step_done-${phase.phaseId}-${phase.iteration ?? 1}-${step.stepId}`,
    text: stepDoneCopy({
      stepId: step.stepId,
      result: step.result ?? {
        stepId: step.stepId,
        ok: step.status === "done",
        output: step.text,
        durationMs: 0,
      },
      cached: step.cached,
    }),
    ts: step.endedAt ?? 0,
    phaseId: phase.phaseId,
    stepId: step.stepId,
    iteration: phase.iteration ?? 1,
  };
}

function stepStartCopy(ev: {
  stepId: string;
  blockKind?: string;
  agent?: string;
}): string {
  const kind = ev.blockKind;
  if (kind === "gate") return `Gate '${ev.stepId}' is watching.`;
  if (kind === "distributor") return `Distributor '${ev.stepId}' is fanning out work.`;
  if (kind === "consolidator") return `Merge '${ev.stepId}' is writing the report.`;
  if (kind === "approval") return `Checkpoint '${ev.stepId}' awaits a decision.`;
  if (kind === "human") return `Step '${ev.stepId}' needs an answer.`;
  if (kind === "command") return `Step '${ev.stepId}' started.`;
  if (kind === "llm") return `Step '${ev.stepId}' called the model.`;
  if (kind === "issues") return `Reporter '${ev.stepId}' is filing findings.`;
  if (ev.agent) return `Step '${ev.stepId}' (${ev.agent}) is underway.`;
  return `Step '${ev.stepId}' is underway.`;
}

function stepDoneCopy(ev: {
  stepId: string;
  result: { ok: boolean; skipped?: boolean; output?: string };
  cached: boolean;
}): string {
  if (ev.result.skipped) return `Step '${ev.stepId}' was skipped.`;
  if (!ev.result.ok) return `Step '${ev.stepId}' failed.`;
  if (ev.cached) return `Step '${ev.stepId}' finished (from cache).`;
  return `Step '${ev.stepId}' finished.`;
}

function gateCopy(ev: {
  stepId: string;
  passed: boolean;
  onFalse?: string;
}): string {
  if (ev.passed) return `Gate '${ev.stepId}' cleared.`;
  // Loop-backs use onFalse: "continue" — the run holds for another iteration.
  if (ev.onFalse === "continue") return `Gate '${ev.stepId}' held for another iteration.`;
  return `Gate '${ev.stepId}' diverted the run.`;
}

/** Strip leading "Phase N —" / ordinal noise; keep the phase title. */
function phaseName(title: string): string {
  const cleaned = title.replace(/^\s*\d+\s*[.:)—-]\s*/, "").trim();
  return cleaned || title;
}

function line(
  ev: { kind: string; ts: number; stepId?: string; phaseId?: string; iteration?: number },
  text: string,
  ids: { phaseId?: string; stepId?: string } = {},
): NarrationLine {
  const phaseId = ids.phaseId ?? ev.phaseId;
  const stepId = ids.stepId ?? ev.stepId;
  const iteration = ev.iteration ?? 1;
  return {
    id: `${ev.kind}-${phaseId ?? ""}-${iteration}-${stepId ?? ""}-${ev.ts}`,
    text,
    ts: ev.ts,
    phaseId,
    stepId,
    iteration,
  };
}
