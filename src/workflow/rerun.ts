import { hashWorkflowSpec } from "./cache-store";
import type { RunRecord } from "./history";
import type { StepResult, WorkflowSpec } from "./types";

/** Re-run a past run fresh, or replay successes and re-run only failures. */
export type RerunMode = "rerun" | "retry-failed";

/**
 * Why a retry-failed could not safely seed the cache and fell back to a full
 * re-run. Seeding replays a past run's step outputs verbatim, so it is only safe
 * when the workflow definition, input, and working directory all match the run
 * that produced them.
 */
export type RerunDowngrade = "no-spec-hash" | "spec-changed" | "input-changed" | "cwd-changed";

export interface RerunPlan {
  workflow: string;
  input: string;
  /** Steps to seed into the engine cache; empty for a full re-run. */
  seedCache: Map<string, StepResult>;
  /** Set when retry-failed could not safely seed and fell back to a full run. */
  downgraded?: RerunDowngrade;
}

export interface RerunError {
  error: string;
}

export function isRerunError(plan: RerunPlan | RerunError): plan is RerunError {
  return "error" in plan;
}

/** A human-readable note for a downgrade, shared across the CLI, TUI, and web. */
export function rerunDowngradeMessage(reason: RerunDowngrade): string {
  switch (reason) {
    case "no-spec-hash":
      return "this run predates spec tracking; doing a full re-run";
    case "spec-changed":
      return "the workflow changed since this run; doing a full re-run";
    case "input-changed":
      return "the input differs from the recorded run; doing a full re-run";
    case "cwd-changed":
      return "the working directory differs from the recorded run; doing a full re-run";
  }
}

/**
 * Build an engine cache seed from a record's completed steps. Every step that
 * finished `done` with a stored result is replayable, keyed by its stepId — this
 * covers both fan-out parents (which the engine replays wholesale via
 * `result.childResults`) and individual done children of a partially-failed
 * fan-out (which the engine replays one-by-one while re-running failed siblings).
 * Pending / error / running steps are omitted so they re-execute.
 */
export function seedCacheFromRecord(record: RunRecord): Map<string, StepResult> {
  const seed = new Map<string, StepResult>();
  for (const phase of record.phases) {
    for (const step of phase.steps) {
      if (step.status === "done" && step.result) seed.set(step.stepId, step.result);
    }
  }
  return seed;
}

/**
 * Decide what a re-run / retry-failed should actually launch. The workflow comes
 * from the record; the input is the record's unless `ctx.input` overrides it.
 *
 * For retry-failed, the record's succeeded steps are only seeded when it is safe
 * to replay them — the workflow spec (`record.specHash`), the input, and the
 * working directory must all match the run that produced them. Any mismatch
 * downgrades to a full fresh re-run rather than replaying stale outputs.
 */
export function planRerun(
  record: RunRecord,
  mode: RerunMode,
  currentSpec: WorkflowSpec | undefined,
  ctx?: { input?: string; cwd?: string },
): RerunPlan | RerunError {
  if (!currentSpec) return { error: `workflow '${record.workflow}' no longer exists` };

  const input = ctx?.input ?? record.input;
  const base = { workflow: record.workflow, input };
  if (mode === "rerun") return { ...base, seedCache: new Map() };

  let downgraded: RerunDowngrade | undefined;
  if (!record.specHash) downgraded = "no-spec-hash";
  else if (record.specHash !== hashWorkflowSpec(currentSpec)) downgraded = "spec-changed";
  else if (ctx?.input !== undefined && ctx.input.trim() !== record.input.trim())
    downgraded = "input-changed";
  else if (ctx?.cwd !== undefined && ctx.cwd !== record.cwd) downgraded = "cwd-changed";

  if (downgraded) return { ...base, seedCache: new Map(), downgraded };
  return { ...base, seedCache: seedCacheFromRecord(record) };
}
