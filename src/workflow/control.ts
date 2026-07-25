import type { StepEditedEvent } from "./events";

/**
 * Mid-run steering: the pause / edit / resume control channel between a run's
 * driver (TUI keypress, web endpoint, CLI command via the live-run store) and
 * the engine's schedulers.
 *
 * The contract is deliberately narrow — the smallest thing that turns "wrong
 * step 7 of 9, restart the run" into a 30-second correction:
 *
 *  - **Pause** stops the engine scheduling NEW steps; in-flight steps run to
 *    completion. The engine emits `run_paused` when it acknowledges.
 *  - **Edit** stages a patch (`prompt` / `cmd` / `model` / `effort`) for a step
 *    that has *not started yet* in this run. Accepted only while a pause is
 *    requested, validated against the live spec by the engine, and recorded as
 *    a `step_edited` event so a steered run stays an auditable record. There
 *    is no rewind: steps that already ran keep their results.
 *  - **Resume** lets the schedulers continue; edited steps execute with their
 *    patches applied.
 */

/** The step fields a mid-run edit may change (never the graph shape). */
export interface StepEditPatch {
  /** New prompt text, for prompt-bearing steps (worker/processor/llm/…). */
  prompt?: string;
  /** New shell command, for `command` steps. */
  cmd?: string;
  /** New model id, for agent-backed and `llm` steps. */
  model?: string;
  /** New reasoning effort, for agent-backed and `llm` steps. */
  effort?: string;
  /**
   * New tool-permission profile for an agent-backed step: `"read-only"` /
   * `"edit"` / `"full"`, or `""` to clear it (back to the workflow/config
   * default). The point of editing this mid-run is the moment you notice a
   * step is about to run unrestricted on a repository you care about: pause,
   * clamp it, resume — no restart, and the intervention lands in the record.
   */
  permissions?: string;
}

export type StepEditResult = { ok: true } | { ok: false; error: string };

/** Engine-side hooks bound once a run starts (see `attachRun`). */
export interface RunControlHooks {
  /** Why `stepId` cannot take `patch` right now, or undefined when it can. */
  stepEditIssue(stepId: string, patch: StepEditPatch): string | undefined;
  /** Invalidate stale cached state for a just-accepted edit. */
  onEditAccepted(stepId: string, patch: StepEditPatch): void;
}

/**
 * One run's steering handle. Drivers call {@link pause}/{@link resume}/
 * {@link editStep}; the engine consumes the state via the remaining members
 * (`attachRun`, `takeEvents`, `stepEdit`, `waitForWake`).
 */
export interface WorkflowRunControl {
  /** Ask the engine to stop scheduling new steps (in-flight steps finish). */
  pause(by?: string): void;
  /** Ask a paused run to continue scheduling. */
  resume(by?: string): void;
  /** Whether a pause is currently requested (not necessarily acknowledged yet). */
  isPauseRequested(): boolean;
  /**
   * Whether the engine has drained to a standstill while paused — every
   * in-flight step has finished and nothing new is scheduled, so the run is
   * parked. This is the signal a driver waits for before handing a paused run
   * off to a background process (mid-run detach): once idle, no step is
   * executing, so aborting the local engine cannot kill live work. Cleared the
   * moment scheduling resumes.
   */
  isIdle(): boolean;
  /** Who asked for the current pause / the latest resume. */
  pauseRequestedBy(): string | undefined;
  resumeRequestedBy(): string | undefined;
  /**
   * Stage an edit for a not-yet-started step. Requires a requested pause and a
   * started run (the engine binds validation at run start); the patch merges
   * over any earlier edit to the same step and applies when the step executes.
   */
  editStep(stepId: string, patch: StepEditPatch, by?: string): StepEditResult;
  /** The accepted (merged) patch for a step, if any. Non-consuming. */
  stepEdit(stepId: string): StepEditPatch | undefined;
  /** All accepted edits so far, keyed by step id. */
  stepEdits(): ReadonlyMap<string, StepEditPatch>;

  // ── engine-facing ──────────────────────────────────────────────────────
  /**
   * The engine calls this each time its scheduler parks with no in-flight
   * steps because a pause is in effect. Latches {@link isIdle} true until the
   * next resume; drivers poll `isIdle` to know a paused run has fully quiesced.
   */
  notifyIdle(): void;
  /** Bind run-scoped validation/invalidation hooks (once per run start). */
  attachRun(hooks: RunControlHooks): void;
  /** Drain events (accepted `step_edited`s) for the engine to emit in-stream. */
  takeEvents(): StepEditedEvent[];
  /** Resolve on the next control change (pause/resume/edit) or signal abort. */
  waitForWake(signal?: AbortSignal): Promise<void>;
}

export function createWorkflowRunControl(): WorkflowRunControl {
  let pauseRequested = false;
  let pausedBy: string | undefined;
  let resumedBy: string | undefined;
  // Latched true once the engine parks with nothing in flight while paused;
  // any resume (or a fresh pause that will schedule again) clears it.
  let idle = false;
  let hooks: RunControlHooks | undefined;
  const edits = new Map<string, StepEditPatch>();
  const pendingEvents: StepEditedEvent[] = [];
  let wakeWaiters: (() => void)[] = [];

  const wake = (): void => {
    const waiters = wakeWaiters;
    wakeWaiters = [];
    for (const resolve of waiters) resolve();
  };

  return {
    pause(by) {
      if (pauseRequested) return;
      pauseRequested = true;
      pausedBy = by;
      wake();
    },
    resume(by) {
      if (!pauseRequested) return;
      pauseRequested = false;
      // Scheduling is about to continue, so the run is no longer quiesced.
      idle = false;
      resumedBy = by;
      wake();
    },
    isPauseRequested: () => pauseRequested,
    isIdle: () => idle,
    notifyIdle() {
      idle = true;
    },
    pauseRequestedBy: () => pausedBy,
    resumeRequestedBy: () => resumedBy,
    editStep(stepId, patch, by) {
      const fields = Object.entries(patch).filter(([, v]) => v !== undefined);
      if (fields.length === 0) {
        return { ok: false, error: "edit contains no changes" };
      }
      if (!hooks) {
        return { ok: false, error: "the run has not started yet" };
      }
      if (!pauseRequested) {
        return { ok: false, error: "pause the run before editing steps" };
      }
      const cleaned = Object.fromEntries(fields) as StepEditPatch;
      const issue = hooks.stepEditIssue(stepId, cleaned);
      if (issue) return { ok: false, error: issue };
      edits.set(stepId, { ...edits.get(stepId), ...cleaned });
      hooks.onEditAccepted(stepId, cleaned);
      pendingEvents.push({ kind: "step_edited", stepId, patch: cleaned, by, ts: Date.now() });
      wake();
      return { ok: true };
    },
    stepEdit: (stepId) => edits.get(stepId),
    stepEdits: () => edits,
    attachRun(next) {
      hooks = next;
    },
    takeEvents() {
      if (pendingEvents.length === 0) return [];
      return pendingEvents.splice(0, pendingEvents.length);
    },
    waitForWake(signal) {
      if (signal?.aborted) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const onAbort = (): void => {
          wakeWaiters = wakeWaiters.filter((w) => w !== onWake);
          resolve();
        };
        const onWake = (): void => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        wakeWaiters.push(onWake);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}
