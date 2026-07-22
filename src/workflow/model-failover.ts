/**
 * Configurable mid-flight model / agent failover policy.
 *
 * When an agent step hits a capacity failure (quota, rate limit) or another
 * configured trigger, the engine walks the step's candidate chain
 * (`fallbackModels`, same-family remaps, model-class preferences) instead of
 * burning retries on the same binding — so a quota run-out does not ruin the
 * workflow run.
 *
 * Resolution order for each field: per-step `modelFailover` ⟶ workflow
 * `modelFailover` ⟶ project/user config `modelFailover` ⟶ built-in defaults.
 */

import type { AgentFailureKind } from "../agents/failure-classify";
import { isCapacityFailure } from "../agents/failure-classify";

/** Failure kinds that may trigger walking the model failover chain. */
export type ModelFailoverTrigger = "quota" | "rate_limit" | "transient" | "auth" | "any";

/** Author-supplied (partial) failover policy. */
export interface ModelFailoverPolicy {
  /**
   * Enable mid-flight agent/model failover. Default `true`.
   * Set `false` to keep classic same-binding auto-retry only.
   */
  enabled?: boolean;
  /**
   * Failure kinds that walk the failover chain.
   * Default: `["quota", "rate_limit", "transient"]`.
   * `"any"` matches every classified failure (still gated by side-effect rules).
   */
  on?: ModelFailoverTrigger[];
  /**
   * For capacity failures (`quota` / `rate_limit`), treat a completed error
   * `result` as failover-eligible. Providers often report exhausted quota as a
   * failed turn rather than a transport error. Default `true`.
   */
  onCapacityResult?: boolean;
  /**
   * Allow failover after the agent already invoked a tool (possible side
   * effects in the worktree). Default `false` — capacity failures before any
   * tool still fail over. Opt in when you accept continuing from a partially
   * edited worktree on a different model.
   */
  allowAfterToolUse?: boolean;
  /**
   * On capacity failures, skip re-trying the same agent/model (it will usually
   * fail again) and jump straight to the next candidate when one exists.
   * Default `true`. Rate limits without a next candidate still use normal
   * same-binding backoff retries.
   */
  preferNextModel?: boolean;
  /**
   * Backoff before a failover attempt that switches agent/model, in ms.
   * Default `250` (short — switching providers rarely needs a long wait).
   * Same-binding retries still use the step/workflow {@link RetryPolicy}.
   */
  failoverDelayMs?: number;
}

/** Fully resolved failover policy. */
export interface ResolvedModelFailoverPolicy {
  enabled: boolean;
  on: ModelFailoverTrigger[];
  onCapacityResult: boolean;
  allowAfterToolUse: boolean;
  preferNextModel: boolean;
  failoverDelayMs: number;
}

export const DEFAULT_MODEL_FAILOVER: ResolvedModelFailoverPolicy = {
  enabled: true,
  on: ["quota", "rate_limit", "transient"],
  onCapacityResult: true,
  allowAfterToolUse: false,
  preferNextModel: true,
  failoverDelayMs: 250,
};

/**
 * Resolve a concrete policy from optional step / workflow / config layers.
 * Each field resolves independently: step ⟶ workflow ⟶ config ⟶ default.
 */
export function resolveModelFailoverPolicy(
  step?: ModelFailoverPolicy,
  workflow?: ModelFailoverPolicy,
  config?: ModelFailoverPolicy,
): ResolvedModelFailoverPolicy {
  const pick = <K extends keyof ResolvedModelFailoverPolicy>(
    key: K,
  ): ResolvedModelFailoverPolicy[K] => {
    const fromStep = step?.[key];
    if (fromStep !== undefined) return fromStep as ResolvedModelFailoverPolicy[K];
    const fromWorkflow = workflow?.[key];
    if (fromWorkflow !== undefined) return fromWorkflow as ResolvedModelFailoverPolicy[K];
    const fromConfig = config?.[key];
    if (fromConfig !== undefined) return fromConfig as ResolvedModelFailoverPolicy[K];
    return DEFAULT_MODEL_FAILOVER[key];
  };
  return {
    enabled: pick("enabled"),
    on: pick("on"),
    onCapacityResult: pick("onCapacityResult"),
    allowAfterToolUse: pick("allowAfterToolUse"),
    preferNextModel: pick("preferNextModel"),
    failoverDelayMs: pick("failoverDelayMs"),
  };
}

/** Whether `kind` is listed in the policy's `on` triggers. */
export function failoverTriggerMatches(
  policy: ResolvedModelFailoverPolicy,
  kind: AgentFailureKind,
): boolean {
  if (!policy.enabled) return false;
  if (policy.on.includes("any")) return true;
  if (kind === "quota" && policy.on.includes("quota")) return true;
  if (kind === "rate_limit" && policy.on.includes("rate_limit")) return true;
  if (kind === "transient" && policy.on.includes("transient")) return true;
  if (kind === "auth" && policy.on.includes("auth")) return true;
  // Unknown / permanent never match unless `any` was set.
  return false;
}

/**
 * Decide whether this attempt's failure may continue the retry/failover loop.
 *
 * - Classic transient (no result, no tools) → always eligible for retry when
 *   the retry policy still has attempts.
 * - Capacity reported as a completed error result → eligible when
 *   `onCapacityResult` and the kind is a configured trigger.
 * - Tool use blocks unless `allowAfterToolUse`.
 */
export function isFailoverEligibleFailure(
  policy: ResolvedModelFailoverPolicy,
  opts: {
    kind: AgentFailureKind;
    cancelled: boolean;
    sawResult: boolean;
    sawToolUse: boolean;
    /** Classic transport retryable (error/throw, no result, no tools). */
    classicRetryable: boolean;
  },
): boolean {
  if (opts.cancelled) return false;
  if (opts.sawToolUse && !policy.allowAfterToolUse) return false;

  // Clean transport failures remain retryable regardless of failover config —
  // failover itself is gated separately by {@link shouldAdvanceFailover}.
  if (opts.classicRetryable) return true;

  // Capacity reported as a completed error turn (Amp credits, Codex
  // turn.failed, Claude result.is_error with a quota message, …).
  if (!policy.enabled) return false;
  if (!failoverTriggerMatches(policy, opts.kind)) return false;
  if (!opts.sawResult) {
    // Errored without a result but not classicRetryable ⇒ tools blocked us
    // above, or cancellation. Nothing left to do.
    return false;
  }
  if (!isCapacityFailure(opts.kind)) return false;
  return policy.onCapacityResult;
}

/**
 * Whether the engine should advance to the next candidate instead of (or
 * before) retrying the same binding.
 */
export function shouldAdvanceFailover(
  policy: ResolvedModelFailoverPolicy,
  opts: {
    kind: AgentFailureKind;
    hasNextCandidate: boolean;
  },
): boolean {
  if (!policy.enabled || !opts.hasNextCandidate) return false;
  if (!failoverTriggerMatches(policy, opts.kind)) return false;
  if (isCapacityFailure(opts.kind) && policy.preferNextModel) return true;
  // Transient / auth: still prefer switching when a next candidate exists —
  // provider outages often survive same-agent retries.
  return opts.kind === "transient" || opts.kind === "auth" || opts.kind === "unknown";
}

/**
 * Quota with no remaining candidate should fail fast (same model will not
 * recover). Rate limits may still burn remaining same-binding attempts.
 */
export function shouldFailFastWithoutCandidate(
  policy: ResolvedModelFailoverPolicy,
  kind: AgentFailureKind,
  hasNextCandidate: boolean,
): boolean {
  if (hasNextCandidate) return false;
  if (!policy.enabled || !policy.preferNextModel) return false;
  return kind === "quota" && failoverTriggerMatches(policy, kind);
}
