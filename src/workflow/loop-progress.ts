import type { StepResult } from "./types";

/** Where a run's loops are: the passes each phase looped back from, and each gate's pass. */
export interface LoopProgress {
  /** Per phase id, how many of its passes finished and were looped back from. */
  phaseRuns: Record<string, number>;
  /** Per loop gate id, the pass it was on. */
  gateIterations: Record<string, number>;
}

/**
 * The loop progress that goes with each step cache map. A cache map is what
 * a canceled, resumed or handed-off run continues from, and without its loop
 * progress a loop restarts at pass 1: its pass tags, `{{iteration}}` and its
 * gate's `maxIterations` budget all start over. The engine records it on
 * every loop jump; the cache store saves and loads it with the entries.
 */
const progressByCache = new WeakMap<Map<string, StepResult>, LoopProgress>();

export function cacheLoopProgress(cache: Map<string, StepResult>): LoopProgress | undefined {
  return progressByCache.get(cache);
}

export function setCacheLoopProgress(
  cache: Map<string, StepResult>,
  progress: LoopProgress | undefined,
): void {
  if (progress) progressByCache.set(cache, progress);
  else progressByCache.delete(cache);
}

/** Read back loop progress from untrusted JSON; `undefined` when it is malformed. */
export function parseLoopProgress(value: unknown): LoopProgress | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const phaseRuns = countsOf(raw.phaseRuns);
  const gateIterations = countsOf(raw.gateIterations);
  if (!phaseRuns || !gateIterations) return undefined;
  return { phaseRuns, gateIterations };
}

function countsOf(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    if (typeof count === "number" && Number.isInteger(count) && count >= 1) out[key] = count;
  }
  return out;
}
