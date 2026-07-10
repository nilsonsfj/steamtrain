/**
 * Human-in-the-loop approval gates (§1.2). A workflow can pause at an
 * `approval` step (or a `gate` whose condition is `{ "human": true }`), surface
 * the reviewed step's output — and, when it ran in an isolated git worktree,
 * its diff — and wait for a human (or an automated CI policy) to Approve or
 * Reject before continuing.
 *
 * The engine stays UI-agnostic: it never blocks on a terminal, an HTTP request,
 * or a keypress directly. Instead each surface injects an {@link
 * ApprovalProvider} into `WorkflowDeps.requestApproval`. The engine emits an
 * `approval_pending` event (so every UI can render the checkpoint), calls the
 * provider, awaits its {@link ApprovalDecision}, then emits `approval_resolved`
 * and routes on the outcome (approve → continue to `target`; reject → the
 * step's `onReject` disposition). The provider is:
 *
 *  - the TUI: resolve when the user presses `a`/`r` on the pending card;
 *  - the web UI: resolve when a `POST /api/runs/:id/approval` arrives;
 *  - the headless CLI: resolve immediately from `--approve-all` /
 *    `--on-approval fail|stop` (see {@link headlessApprovalProvider}).
 *
 * Approval decisions are never cached, so a resumed run always re-asks (the
 * cached steps around the checkpoint replay, the human reconfirms) — see the
 * `noCache` handling in the engine and cache store.
 */

import type { WorktreeDiff } from "./merge";
import type { AgentWorktreeInfo } from "./types";

/** Reviewed-step output surfaced to the human is truncated to this many chars. */
export const APPROVAL_OUTPUT_CAP = 8000;
/** Reviewed-step diff patch surfaced to the human is truncated to this many chars. */
export const APPROVAL_DIFF_CAP = 20000;

/**
 * What a rejection does to control flow. Mirrors a gate's `onFalse` minus the
 * no-op "continue" for the `approval` step kind (rejecting an approval that
 * just continues is meaningless); a `gate` with `{ human: true }` may still use
 * `continue` via its own `onFalse`.
 */
export type ApprovalRejectDisposition = "fail" | "stop" | "continue";

/**
 * A pending approval the engine surfaces to a provider. Everything a UI needs
 * to render the checkpoint and let a human decide is here — no back-reference
 * into engine internals.
 */
export interface ApprovalRequest {
  /** The approval step's own id. */
  stepId: string;
  /** Phase id the approval step lives in (for correlation with the live tree). */
  phaseId: string;
  /** Loop iteration this approval is being requested under (1-based). */
  iteration: number;
  /** The step whose work is under review, when the approval references one. */
  reviewStepId?: string;
  /** Human-readable instructions from the spec (`prompt`), when provided. */
  message?: string;
  /** The reviewed step's final output text, capped to {@link APPROVAL_OUTPUT_CAP}. */
  output?: string;
  /**
   * The reviewed step's worktree diff (files, +/- stats, and a capped unified
   * patch), when it ran in an isolated git worktree with changes. Absent for
   * agentless steps or steps that produced no diff.
   */
  diff?: WorktreeDiff;
  /** The reviewed step's worktree metadata, when it ran in one. */
  worktree?: AgentWorktreeInfo;
  /** What a rejection does (`fail` / `stop` / `continue`). */
  onReject: ApprovalRejectDisposition;
}

/** A human/automated decision on a pending {@link ApprovalRequest}. */
export interface ApprovalDecision {
  /** True to continue the run; false to reject. */
  approved: boolean;
  /**
   * Who/what decided — e.g. `"human"`, `"auto:approve-all"`,
   * `"auto:reject-stop"`. Free-form; recorded in history and shown in UIs.
   */
  by?: string;
  /** Optional free-text note the decider attached (shown/recorded). */
  note?: string;
  /**
   * Override the rejection disposition for this decision (rejection only).
   * Lets a headless `--on-approval fail|stop` force the outcome regardless of
   * the spec's declared `onReject`. Ignored when `approved` is true.
   *
   * Deliberately narrower than {@link ApprovalRejectDisposition}: a decision can
   * only force a hard `fail`/`stop`, never `continue` (silently proceeding past
   * a rejection is not something a decider overrides into). When this is
   * `undefined` the engine falls back to the spec's declared disposition, which
   * *may* be `continue` — so the effective disposition still spans all three.
   */
  rejectDisposition?: "fail" | "stop";
}

/**
 * Resolves a pending approval. Injected via `WorkflowDeps.requestApproval`. The
 * `signal` aborts when the run is cancelled or times out mid-wait; a provider
 * that awaits external input MUST settle (reject or resolve) when it fires, so
 * the engine does not hang. The engine also races the call against the signal,
 * so a provider that ignores it still unblocks the run — but a well-behaved
 * provider stops any UI prompt it opened.
 */
export type ApprovalProvider = (
  request: ApprovalRequest,
  signal?: AbortSignal,
) => Promise<ApprovalDecision>;

/** Truncate text to `cap` chars with a visible "[truncated N chars]" marker. */
export function capApprovalText(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n… [truncated ${text.length - cap} chars]`;
}

/**
 * Find the pending-approval resolver key that matches a decision request. Both
 * UI bridges (web {@link ApprovalProvider} in the run manager, TUI runner) key
 * their resolver map by `<stepId>:<iteration>` using the step's LOCAL id. When
 * the checkpoint lives inside a sub-workflow, the surfaced event carries the
 * NAMESPACED id (`parent::child`), so a UI resolving it posts that namespaced
 * id. Match a resolver key when its local step id equals the posted id or is the
 * trailing `::`-segment of it; `iteration` (when provided) must also match.
 */
export function matchApprovalKey(
  keys: Iterable<string>,
  stepId: string,
  iteration?: number,
): string | undefined {
  for (const key of keys) {
    const sep = key.lastIndexOf(":");
    if (sep < 0) continue;
    const keyStep = key.slice(0, sep);
    const keyIteration = key.slice(sep + 1);
    const stepMatches = keyStep === stepId || stepId.endsWith(`::${keyStep}`);
    if (!stepMatches) continue;
    if (iteration === undefined || String(iteration) === keyIteration) return key;
  }
  return undefined;
}

/**
 * Find the pending checkpoint matching a decision request against a list of
 * pending approvals (the live-run registry's `pendingApprovals`). The list
 * carries NAMESPACED step ids (from the event stream), while a decider may
 * pass either form — same matching rule as {@link matchApprovalKey}, for the
 * list-of-objects shape used by external (cross-process) approvals.
 */
export function matchPendingApproval<T extends { stepId: string; iteration: number }>(
  pending: readonly T[],
  stepId: string,
  iteration?: number,
): T | undefined {
  return pending.find(
    (p) =>
      (p.stepId === stepId || p.stepId.endsWith(`::${stepId}`)) &&
      (iteration === undefined || p.iteration === iteration),
  );
}

/**
 * The automated decision policy for a headless run. `approve-all` approves
 * every checkpoint; `reject-fail` / `reject-stop` reject with that disposition.
 */
export type HeadlessApprovalMode = "approve-all" | "reject-fail" | "reject-stop";

/**
 * A non-interactive {@link ApprovalProvider} for CI / headless runs. Resolves
 * immediately per the chosen {@link HeadlessApprovalMode} — no prompt, no
 * blocking — so a pipeline never hangs on a checkpoint.
 */
export function headlessApprovalProvider(mode: HeadlessApprovalMode): ApprovalProvider {
  return async (): Promise<ApprovalDecision> => {
    if (mode === "approve-all") {
      return { approved: true, by: "auto:approve-all" };
    }
    const rejectDisposition = mode === "reject-fail" ? "fail" : "stop";
    return {
      approved: false,
      by: `auto:reject-${rejectDisposition}`,
      note: `auto-rejected by --on-approval ${rejectDisposition}`,
      rejectDisposition,
    };
  };
}

/**
 * The engine's fallback when a run reaches an approval checkpoint but no
 * provider was injected (misconfiguration, or an old caller). Rejects with the
 * checkpoint's own disposition rather than hanging, and explains why.
 */
export const noProviderApprovalDecision = (request: ApprovalRequest): ApprovalDecision => ({
  approved: false,
  by: "auto:no-provider",
  note:
    request.onReject === "continue"
      ? "no approval provider configured; continuing per the checkpoint's onReject"
      : "no approval provider configured; rejecting the checkpoint",
  rejectDisposition: request.onReject === "continue" ? undefined : request.onReject,
});
