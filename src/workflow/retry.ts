/**
 * Retry policy for auto-retrying transient agent failures. A `RetryPolicy` may
 * be declared at the workflow level (a default for every agent step) and/or per
 * step (an override); both are partial, and unset fields fall back through the
 * workflow default to the built-in {@link DEFAULT_RETRY}.
 *
 * Only *transient, side-effect-free* failures are ever retried — see the engine
 * for the classification. This module is pure: types, resolution, and backoff.
 */

/** A partial, author-supplied retry policy (every field optional). */
export interface RetryPolicy {
  /** Total attempts including the first; `<= 1` disables retry. Default 3. */
  maxAttempts?: number;
  /** Backoff before the second attempt, in ms. Default 1000. */
  initialDelayMs?: number;
  /** Geometric growth factor per attempt. Default 2. */
  factor?: number;
  /** Upper bound on any single backoff wait, in ms. Default 30000. */
  maxDelayMs?: number;
  /** Apply full jitter (scale each wait by a random [0,1)). Default true. */
  jitter?: boolean;
}

/** A retry policy with every field resolved to a concrete value. */
export interface ResolvedRetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  factor: number;
  maxDelayMs: number;
  jitter: boolean;
}

/** Built-in defaults applied when neither the step nor the workflow sets a field. */
export const DEFAULT_RETRY: ResolvedRetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  factor: 2,
  maxDelayMs: 30000,
  jitter: true,
};

/**
 * Resolve a concrete policy from an optional per-step policy and an optional
 * workflow-level default. Each field resolves independently: step ⟶ workflow ⟶
 * built-in default.
 */
export function resolveRetryPolicy(
  step?: RetryPolicy,
  workflow?: RetryPolicy,
): ResolvedRetryPolicy {
  const pick = <K extends keyof ResolvedRetryPolicy>(key: K): ResolvedRetryPolicy[K] => {
    const fromStep = step?.[key];
    if (fromStep !== undefined) return fromStep as ResolvedRetryPolicy[K];
    const fromWorkflow = workflow?.[key];
    if (fromWorkflow !== undefined) return fromWorkflow as ResolvedRetryPolicy[K];
    return DEFAULT_RETRY[key];
  };
  return {
    maxAttempts: pick("maxAttempts"),
    initialDelayMs: pick("initialDelayMs"),
    factor: pick("factor"),
    maxDelayMs: pick("maxDelayMs"),
    jitter: pick("jitter"),
  };
}

/**
 * The backoff wait (ms) to apply after a failed attempt before the next one.
 * `attempt` is 1-based (the attempt that just failed): attempt 1 waits
 * `initialDelayMs`, attempt 2 waits `initialDelayMs * factor`, etc., capped at
 * `maxDelayMs`. With jitter, the capped value is scaled by `rand()` in [0,1)
 * (full jitter), so concurrent fan-out children don't retry in lockstep.
 */
export function backoffDelayMs(
  policy: ResolvedRetryPolicy,
  attempt: number,
  rand: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1);
  const raw = policy.initialDelayMs * policy.factor ** exponent;
  const capped = Math.min(policy.maxDelayMs, raw);
  return policy.jitter ? capped * rand() : capped;
}
