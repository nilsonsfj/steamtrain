import { hashWorkflowSpec } from "./cache-store";
import type { RunRecord } from "./history";
import type { StepResult, WorkflowSpec } from "./types";

/** Re-run a past run fresh, or replay successes and re-run only failures. */
export type RerunMode = "rerun" | "retry-failed";

export interface RerunPlan {
  workflow: string;
  input: string;
  /** Steps to seed into the engine cache; empty for a full re-run. */
  seedCache: Map<string, StepResult>;
  /** Set when retry-failed could not safely seed and fell back to a full run. */
  downgraded?: "spec-changed" | "no-spec-hash";
}

export interface RerunError {
  error: string;
}

export function isRerunError(plan: RerunPlan | RerunError): plan is RerunError {
  return "error" in plan;
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
 * Decide what a re-run / retry-failed should actually launch. The workflow and
 * input always come from the record; cwd is the caller's current cwd. For
 * retry-failed, the seed is only trusted when the recorded `specHash` matches
 * the current spec — otherwise replaying old outputs against a changed
 * definition could be wrong, so we downgrade to a full re-run.
 */
export function planRerun(
  record: RunRecord,
  mode: RerunMode,
  currentSpec: WorkflowSpec | undefined,
): RerunPlan | RerunError {
  if (!currentSpec) return { error: `workflow '${record.workflow}' no longer exists` };

  const base = { workflow: record.workflow, input: record.input };
  if (mode === "rerun") return { ...base, seedCache: new Map() };

  if (!record.specHash) return { ...base, seedCache: new Map(), downgraded: "no-spec-hash" };
  if (record.specHash !== hashWorkflowSpec(currentSpec)) {
    return { ...base, seedCache: new Map(), downgraded: "spec-changed" };
  }
  return { ...base, seedCache: seedCacheFromRecord(record) };
}
