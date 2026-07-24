import { type LandLockOptions, withLandLock } from "./land-lock";
import { runCommand } from "./merge";

/**
 * GitHub PR check-status helpers for babysit / land workflows.
 *
 * The failure mode this module exists to prevent: an agent (or a naive
 * `gh pr merge`) lands a PR and deletes the head branch while an external
 * automated review / CI job is still queued or running. Those jobs then die
 * with `fatal: couldn't find remote ref <branch>`.
 *
 * GitHub's `mergeable` / required-check rollup is NOT enough — non-required
 * checks (common for remote code-review bots) stay pending while the PR is
 * already mergeable. We wait for EVERY entry in `statusCheckRollup` to reach
 * a terminal state, and we treat an empty rollup right after a fresh push as
 * "checks not registered yet" rather than "no CI, ship it".
 */

/** Terminal / in-flight states we care about (GitHub CheckConclusion + Status). */
export type CheckRollupState =
  | "PENDING"
  | "QUEUED"
  | "IN_PROGRESS"
  | "EXPECTED"
  | "SUCCESS"
  | "NEUTRAL"
  | "SKIPPED"
  | "FAILURE"
  | "ERROR"
  | "CANCELLED"
  | "TIMED_OUT"
  | "ACTION_REQUIRED"
  | "STARTUP_FAILURE"
  | "STALE"
  | "WAITING"
  | "REQUESTED"
  | "UNKNOWN";

export interface CheckRollupEntry {
  name: string;
  state: CheckRollupState;
  /** Optional workflow / app that produced the check. */
  source?: string;
}

export type PullRequestMergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

/**
 * GitHub's richer merge-state signal (GraphQL `mergeStateStatus`). Orthogonal
 * to `mergeable`: a PR can be `mergeable: MERGEABLE` yet `BEHIND` (its head is
 * behind the base and the repo requires up-to-date branches) or `BLOCKED`
 * (a required review/check gate is unmet). We use it to tell "just needs its
 * branch updated" apart from "genuinely cannot land".
 */
export type PullRequestMergeStateStatus =
  | "BEHIND"
  | "BLOCKED"
  | "CLEAN"
  | "DIRTY"
  | "DRAFT"
  | "HAS_HOOKS"
  | "UNKNOWN"
  | "UNSTABLE";

export interface PullRequestCheckSnapshot {
  /** PR number. */
  number: number;
  /** open | closed | merged (derived from state + mergedAt). */
  state: "open" | "closed" | "merged";
  headRefName: string;
  /**
   * GitHub's mergeability computation. UNKNOWN while GitHub is still
   * calculating; CONFLICTING means the PR cannot land cleanly even if checks
   * are green / absent.
   */
  mergeable?: PullRequestMergeable;
  /** GitHub's `mergeStateStatus`, when known — see the type doc above. */
  mergeStateStatus?: PullRequestMergeStateStatus;
  /** ISO timestamp of the tip commit on the PR head, when known. */
  headCommittedAt?: string;
  checks: CheckRollupEntry[];
}

export type CheckEvaluation =
  | { ready: false; reason: "pending" | "awaiting_registration"; detail: string }
  | { ready: true; ok: true; detail: string }
  | { ready: true; ok: false; detail: string; failed: CheckRollupEntry[] };

export interface EvaluateChecksOptions {
  /**
   * How long after the head commit (or, when unknown, after `now`) we keep
   * treating an empty rollup as "checks have not registered yet". Default 90s.
   */
  emptyGraceMs?: number;
  /** Wall clock; injectable for tests. */
  nowMs?: number;
}

const IN_FLIGHT = new Set<CheckRollupState>([
  "PENDING",
  "QUEUED",
  "IN_PROGRESS",
  "EXPECTED",
  "WAITING",
  "REQUESTED",
  "STALE",
  "UNKNOWN",
]);

const FAILURE_LIKE = new Set<CheckRollupState>([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);

export const DEFAULT_EMPTY_GRACE_MS = 90_000;
export const DEFAULT_POLL_INTERVAL_MS = 10_000;
export const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60_000;

/** Normalize a raw GitHub status/conclusion string into a rollup state. */
export function normalizeCheckState(raw: unknown): CheckRollupState {
  if (typeof raw !== "string" || !raw.trim()) return "UNKNOWN";
  const upper = raw.trim().toUpperCase().replace(/-/g, "_");
  const known: CheckRollupState[] = [
    "PENDING",
    "QUEUED",
    "IN_PROGRESS",
    "EXPECTED",
    "SUCCESS",
    "NEUTRAL",
    "SKIPPED",
    "FAILURE",
    "ERROR",
    "CANCELLED",
    "TIMED_OUT",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
    "STALE",
    "WAITING",
    "REQUESTED",
  ];
  return (known as string[]).includes(upper) ? (upper as CheckRollupState) : "UNKNOWN";
}

/**
 * Decide whether a PR's check rollup is still in flight, green, or failed.
 *
 * Empty rollup + recent head commit → not ready (`awaiting_registration`).
 * That closes the race where a bot merges in the few seconds between push and
 * the external review check appearing in the rollup.
 *
 * Mergeability is checked too: CONFLICTING fails closed (even with no checks),
 * and UNKNOWN keeps us pending so we do not race GitHub's mergeability calc.
 */
export function evaluatePullRequestChecks(
  snapshot: PullRequestCheckSnapshot,
  opts: EvaluateChecksOptions = {},
): CheckEvaluation {
  if (snapshot.state === "merged") {
    return { ready: true, ok: true, detail: `PR #${snapshot.number} is already merged` };
  }
  if (snapshot.state === "closed") {
    return {
      ready: true,
      ok: false,
      detail: `PR #${snapshot.number} is closed without being merged`,
      failed: [],
    };
  }

  if (snapshot.mergeable === "CONFLICTING") {
    return {
      ready: true,
      ok: false,
      detail: `PR #${snapshot.number} has merge conflicts with the base branch - rebase/update the head before landing`,
      failed: [],
    };
  }

  const now = opts.nowMs ?? Date.now();
  const graceMs = opts.emptyGraceMs ?? DEFAULT_EMPTY_GRACE_MS;
  // CANCELLED entries are almost always superseded runs (new push cancelled the
  // previous workflow). Ignoring them avoids failing closed on stale cancels
  // while still honoring live FAILURE / pending checks.
  const checks = snapshot.checks.filter((c) => c.state !== "CANCELLED");

  if (checks.length === 0) {
    const committedAtMs = snapshot.headCommittedAt
      ? Date.parse(snapshot.headCommittedAt)
      : Number.NaN;
    const ageMs = Number.isFinite(committedAtMs) ? Math.max(0, now - committedAtMs) : 0;
    if (ageMs < graceMs) {
      const remainSec = Math.ceil((graceMs - ageMs) / 1000);
      return {
        ready: false,
        reason: "awaiting_registration",
        detail:
          `PR #${snapshot.number} has no checks in the rollup yet ` +
          `(waiting up to ${remainSec}s for CI / external review to register)`,
      };
    }
    if (snapshot.mergeable === "UNKNOWN") {
      return {
        ready: false,
        reason: "pending",
        detail: `PR #${snapshot.number} has no status checks yet and mergeability is still UNKNOWN`,
      };
    }
    return {
      ready: true,
      ok: true,
      detail: `PR #${snapshot.number} has no status checks after the grace window — treating as ready`,
    };
  }

  const failed = checks.filter((c) => FAILURE_LIKE.has(c.state));
  if (failed.length > 0) {
    return {
      ready: true,
      ok: false,
      detail: `PR #${snapshot.number} has failing checks: ${failed
        .map((c) => `${c.name} (${c.state})`)
        .join(", ")}`,
      failed,
    };
  }

  // FAILURE_LIKE already returned above. Remaining states are either still
  // in flight (including UNKNOWN from normalizeCheckState) or success-like
  // (SUCCESS / NEUTRAL / SKIPPED).
  const pending = checks.filter((c) => IN_FLIGHT.has(c.state));
  if (pending.length > 0) {
    return {
      ready: false,
      reason: "pending",
      detail: `PR #${snapshot.number} still running: ${pending
        .map((c) => `${c.name} (${c.state})`)
        .join(", ")}`,
    };
  }

  if (snapshot.mergeable === "UNKNOWN") {
    return {
      ready: false,
      reason: "pending",
      detail: `PR #${snapshot.number} checks are green but mergeability is still UNKNOWN`,
    };
  }

  return {
    ready: true,
    ok: true,
    detail: `PR #${snapshot.number} — all ${checks.length} check(s) green`,
  };
}

/** Parse a PR number out of a bare number, URL, or "number\\nbranch" fixture line. */
export function parsePullRequestRef(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("PR ref is empty");
  // Fixture / babysit item shape: "417\nclaude/hopeful-shannon-lx8lxp"
  const firstLine = trimmed.split(/\r?\n/, 1)[0]!.trim();
  const urlMatch = firstLine.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/i);
  if (urlMatch) return urlMatch[1]!;
  const numMatch = firstLine.match(/^#?(\d+)\b/);
  if (numMatch) return numMatch[1]!;
  // Branch name or other selector — pass through to `gh pr view`.
  return firstLine;
}

interface GhPrViewJson {
  number?: number;
  state?: string;
  mergedAt?: string | null;
  headRefName?: string;
  mergeable?: string | null;
  mergeStateStatus?: string | null;
  statusCheckRollup?: unknown;
  commits?: unknown;
}

function normalizeMergeable(raw: unknown): PullRequestMergeable | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const upper = raw.trim().toUpperCase();
  if (upper === "MERGEABLE" || upper === "CONFLICTING" || upper === "UNKNOWN") {
    return upper;
  }
  return "UNKNOWN";
}

/** Fetch a PR check snapshot via `gh pr view --json …`. */
export async function fetchPullRequestCheckSnapshot(
  prRef: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<PullRequestCheckSnapshot> {
  const selector = parsePullRequestRef(prRef);
  const output = await runCommand(
    "gh",
    [
      "pr",
      "view",
      selector,
      "--json",
      "number,state,mergedAt,headRefName,mergeable,mergeStateStatus,statusCheckRollup,commits",
    ],
    cwd,
    signal,
  );
  let parsed: GhPrViewJson;
  try {
    parsed = JSON.parse(output) as GhPrViewJson;
  } catch {
    throw new Error(`gh pr view returned invalid JSON for '${selector}'`);
  }
  const number = typeof parsed.number === "number" ? parsed.number : Number(selector);
  if (!Number.isFinite(number)) {
    throw new Error(`could not resolve PR number from '${prRef}'`);
  }
  const merged = Boolean(parsed.mergedAt);
  const stateRaw = (parsed.state ?? "").toUpperCase();
  const state: PullRequestCheckSnapshot["state"] = merged
    ? "merged"
    : stateRaw === "OPEN"
      ? "open"
      : "closed";

  return {
    number,
    state,
    headRefName: typeof parsed.headRefName === "string" ? parsed.headRefName : "",
    mergeable: normalizeMergeable(parsed.mergeable),
    mergeStateStatus: normalizeMergeStateStatus(parsed.mergeStateStatus),
    headCommittedAt: latestCommitTimestamp(parsed.commits),
    checks: parseStatusCheckRollup(parsed.statusCheckRollup),
  };
}

const MERGE_STATE_STATUSES: PullRequestMergeStateStatus[] = [
  "BEHIND",
  "BLOCKED",
  "CLEAN",
  "DIRTY",
  "DRAFT",
  "HAS_HOOKS",
  "UNKNOWN",
  "UNSTABLE",
];

function normalizeMergeStateStatus(raw: unknown): PullRequestMergeStateStatus | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const upper = raw.trim().toUpperCase();
  return (MERGE_STATE_STATUSES as string[]).includes(upper)
    ? (upper as PullRequestMergeStateStatus)
    : "UNKNOWN";
}

function latestCommitTimestamp(commits: unknown): string | undefined {
  if (!Array.isArray(commits) || commits.length === 0) return undefined;
  let latest: string | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const entry of commits) {
    if (!entry || typeof entry !== "object") continue;
    const committed =
      (entry as { committedDate?: unknown }).committedDate ??
      (entry as { commit?: { committedDate?: unknown } }).commit?.committedDate;
    if (typeof committed !== "string") continue;
    const ms = Date.parse(committed);
    if (Number.isFinite(ms) && ms >= latestMs) {
      latestMs = ms;
      latest = committed;
    }
  }
  return latest;
}

/** Normalize `statusCheckRollup` (array of check nodes, or nested shapes) into entries. */
export function parseStatusCheckRollup(raw: unknown): CheckRollupEntry[] {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [];
  const out: CheckRollupEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const name =
      (typeof obj.name === "string" && obj.name) ||
      (typeof obj.context === "string" && obj.context) ||
      (typeof obj.workflowName === "string" && obj.workflowName) ||
      "check";
    // Check runs use conclusion when complete; status while in flight.
    // Status contexts use state. checkSuite.status is a nested fallback.
    const checkSuiteStatus =
      obj.checkSuite && typeof obj.checkSuite === "object"
        ? (obj.checkSuite as { status?: unknown }).status
        : undefined;
    const state = normalizeCheckState(
      obj.conclusion ?? obj.state ?? obj.status ?? checkSuiteStatus,
    );
    const source =
      typeof obj.workflowName === "string"
        ? obj.workflowName
        : typeof (obj.app as { name?: unknown } | undefined)?.name === "string"
          ? (obj.app as { name: string }).name
          : undefined;
    out.push({ name, state, source });
  }
  return out;
}

export interface WaitForChecksOptions {
  cwd: string;
  prRef: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  emptyGraceMs?: number;
  signal?: AbortSignal;
  /** Called on each poll with the latest evaluation (for CLI progress). */
  onPoll?: (snapshot: PullRequestCheckSnapshot, evaluation: CheckEvaluation) => void;
  /** Injectable clock / sleep for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  fetchSnapshot?: (
    prRef: string,
    cwd: string,
    signal?: AbortSignal,
  ) => Promise<PullRequestCheckSnapshot>;
  nowMs?: () => number;
}

export type WaitForChecksResult =
  | {
      ok: true;
      snapshot: PullRequestCheckSnapshot;
      evaluation: CheckEvaluation & { ready: true; ok: true };
    }
  | {
      ok: false;
      error: string;
      snapshot?: PullRequestCheckSnapshot;
      evaluation?: CheckEvaluation;
    };

/**
 * Poll until every check is terminal. Fails on red checks, closed PRs, timeout,
 * or cancellation. Does NOT merge — callers decide what to do with a green PR.
 */
export async function waitForPullRequestChecks(
  opts: WaitForChecksOptions,
): Promise<WaitForChecksResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const fetchSnapshot = opts.fetchSnapshot ?? fetchPullRequestCheckSnapshot;
  const nowMs = opts.nowMs ?? Date.now;
  const deadline = nowMs() + timeoutMs;

  let lastSnapshot: PullRequestCheckSnapshot | undefined;
  let lastEvaluation: CheckEvaluation | undefined;

  while (true) {
    if (opts.signal?.aborted) {
      return { ok: false, error: "cancelled", snapshot: lastSnapshot, evaluation: lastEvaluation };
    }
    try {
      lastSnapshot = await fetchSnapshot(opts.prRef, opts.cwd, opts.signal);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message, snapshot: lastSnapshot, evaluation: lastEvaluation };
    }
    lastEvaluation = evaluatePullRequestChecks(lastSnapshot, {
      emptyGraceMs: opts.emptyGraceMs,
      nowMs: nowMs(),
    });
    opts.onPoll?.(lastSnapshot, lastEvaluation);

    if (lastEvaluation.ready && lastEvaluation.ok) {
      return {
        ok: true,
        snapshot: lastSnapshot,
        evaluation: lastEvaluation,
      };
    }
    if (lastEvaluation.ready && !lastEvaluation.ok) {
      return {
        ok: false,
        error: lastEvaluation.detail,
        snapshot: lastSnapshot,
        evaluation: lastEvaluation,
      };
    }

    const remaining = deadline - nowMs();
    if (remaining <= 0) {
      return {
        ok: false,
        error: `timed out after ${Math.round(timeoutMs / 1000)}s waiting for PR checks (${lastEvaluation.detail})`,
        snapshot: lastSnapshot,
        evaluation: lastEvaluation,
      };
    }
    await sleep(Math.min(pollIntervalMs, remaining), opts.signal);
  }
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface MergeWhenReadyOptions extends WaitForChecksOptions {
  /** Forwarded to `gh pr merge` (default squash). */
  mergeStrategy?: "squash" | "merge" | "rebase";
  /** Delete the head branch after a successful merge (default true). */
  deleteBranch?: boolean;
  /**
   * How many times to (re)attempt the actual land under the lock before giving
   * up — each attempt re-fetches fresh state, so a base branch that moved
   * between attempts is re-evaluated rather than merged blind. Default 4.
   */
  maxMergeAttempts?: number;
  /** Injectable `gh` runner (args after the implicit `gh`). Defaults to the real CLI. */
  runGh?: (args: string[], cwd: string, signal?: AbortSignal) => Promise<string>;
  /** Injectable land-lock wrapper (defaults to the cross-process file lock). */
  landLock?: <T>(
    cwd: string,
    fn: (locked: boolean) => Promise<T>,
    lockOpts?: LandLockOptions,
  ) => Promise<{ value: T; locked: boolean }>;
  /** Tuning/injection for the land lock (signal is forwarded automatically). */
  landLockOptions?: LandLockOptions;
}

export type MergeWhenReadyResult =
  | {
      ok: true;
      merged: boolean;
      alreadyMerged: boolean;
      detail: string;
      prNumber: number;
      /** True when we serialized behind the cross-process land lock. */
      serialized?: boolean;
    }
  | { ok: false; error: string };

const DEFAULT_MAX_MERGE_ATTEMPTS = 4;
/** Backoff between transient-failure merge retries. */
const MERGE_RETRY_BACKOFF_MS = 3_000;

/**
 * `gh pr merge` failures that mean "the base moved under you, just try again":
 * the classic parallel-land race. Distinct from a hard rejection (review
 * required, not authorized), which must NOT be retried.
 */
function isRetriableMergeError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("base branch was modified") ||
    m.includes("try the merge again") ||
    m.includes("merge already in progress") ||
    m.includes("head branch was modified") ||
    // GitHub occasionally reports a just-moved base as momentarily un-mergeable
    // before its mergeability recompute catches up.
    m.includes("pull request is not mergeable") ||
    m.includes("not mergeable")
  );
}

/**
 * Wait until every check is green, then land the PR — serialized against other
 * steamtrain processes landing into the same repo, and resilient to the base
 * branch moving under a parallel fan-out.
 *
 * The land itself runs under a cross-process lock (see `land-lock.ts`) so the
 * `babysit-all-prs` fan-out merges its PRs one at a time instead of stampeding
 * the same base. Under the lock we RE-FETCH before merging: a sibling that
 * landed first may have advanced the base, in which case this PR is either
 * already re-runnable (wait again), now behind (update its branch, wait, retry),
 * or now genuinely conflicting (fail with an actionable message instead of a
 * raw `gh` error). Transient "base branch was modified" merge errors are
 * retried. Branch deletion still happens only after a clean terminal-green
 * merge — never while an external review still needs the remote ref.
 */
export async function mergePullRequestWhenReady(
  opts: MergeWhenReadyOptions,
): Promise<MergeWhenReadyResult> {
  const nowMs = opts.nowMs ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const deadline = nowMs() + timeoutMs;
  const runGh = opts.runGh ?? ((args, cwd, signal) => runCommand("gh", args, cwd, signal));
  const lock = opts.landLock ?? withLandLock;
  const sleep = opts.sleep ?? defaultSleep;
  const strategy = opts.mergeStrategy ?? "squash";
  const maxAttempts = Math.max(1, opts.maxMergeAttempts ?? DEFAULT_MAX_MERGE_ATTEMPTS);

  const remaining = (): number => Math.max(0, deadline - nowMs());
  const waitGreen = (): Promise<WaitForChecksResult> =>
    waitForPullRequestChecks({ ...opts, timeoutMs: remaining() });

  // First wait happens OUTSIDE the lock: N babysit children should all burn
  // their CI-wait time in parallel, and only contend for the lock once they are
  // actually ready to land. Holding the lock across the (long) check wait would
  // serialize the waiting too and defeat the fan-out.
  const firstWait = await waitGreen();
  if (!firstWait.ok) return { ok: false, error: firstWait.error };
  if (firstWait.snapshot.state === "merged") {
    return alreadyMerged(firstWait.snapshot.number, firstWait.evaluation.detail);
  }

  const outcome = await lock(
    opts.cwd,
    (locked) =>
      landUnderLock({
        opts,
        runGh,
        waitGreen,
        sleep,
        nowMs,
        remaining,
        strategy,
        maxAttempts,
        locked,
      }),
    { ...opts.landLockOptions, signal: opts.landLockOptions?.signal ?? opts.signal },
  );
  return outcome.value;
}

function alreadyMerged(prNumber: number, detail: string): MergeWhenReadyResult {
  return { ok: true, merged: false, alreadyMerged: true, detail, prNumber };
}

interface LandLoopArgs {
  opts: MergeWhenReadyOptions;
  runGh: (args: string[], cwd: string, signal?: AbortSignal) => Promise<string>;
  waitGreen: () => Promise<WaitForChecksResult>;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  nowMs: () => number;
  remaining: () => number;
  strategy: "squash" | "merge" | "rebase";
  maxAttempts: number;
  locked: boolean;
}

async function landUnderLock(a: LandLoopArgs): Promise<MergeWhenReadyResult> {
  const { opts, runGh, waitGreen, sleep, remaining, strategy, maxAttempts, locked } = a;
  const fetchSnapshot = opts.fetchSnapshot ?? fetchPullRequestCheckSnapshot;
  let lastError = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted) return { ok: false, error: "cancelled" };
    if (remaining() <= 0) {
      return {
        ok: false,
        error: `timed out landing PR${lastError ? ` (last: ${lastError})` : ""}`,
      };
    }

    // Re-read the world under the lock: a sibling may have merged and moved the
    // base since our pre-lock wait finished.
    let snapshot: PullRequestCheckSnapshot;
    try {
      snapshot = await fetchSnapshot(opts.prRef, opts.cwd, opts.signal);
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
    if (snapshot.state === "merged") {
      return alreadyMerged(snapshot.number, `PR #${snapshot.number} was merged by another run`);
    }
    if (snapshot.state === "closed") {
      return { ok: false, error: `PR #${snapshot.number} is closed without being merged` };
    }

    const evaluation = evaluatePullRequestChecks(snapshot, {
      emptyGraceMs: opts.emptyGraceMs,
      nowMs: a.nowMs(),
    });

    if (evaluation.ready && !evaluation.ok) {
      if (snapshot.mergeable === "CONFLICTING") {
        return {
          ok: false,
          error: `PR #${snapshot.number} now conflicts with the base branch (it advanced while this PR waited) — rebase/resolve the conflict before it can land`,
        };
      }
      return { ok: false, error: evaluation.detail };
    }

    if (!evaluation.ready) {
      // Base moved → new CI is registering / re-running, or mergeability is
      // still UNKNOWN. Wait for it to settle, then re-evaluate from the top.
      const rewait = await waitGreen();
      if (!rewait.ok) return { ok: false, error: rewait.error };
      continue;
    }

    // Green. If the repo requires an up-to-date branch, GitHub reports BEHIND —
    // update the branch (merges base into head), wait for the fresh CI, retry.
    if (snapshot.mergeStateStatus === "BEHIND") {
      const updated = await updateBranch(snapshot.number, a);
      if (!updated.ok) return updated;
      const rewait = await waitGreen();
      if (!rewait.ok) return { ok: false, error: rewait.error };
      continue;
    }

    const mergeArgs = ["pr", "merge", String(snapshot.number), `--${strategy}`];
    if (opts.deleteBranch !== false) mergeArgs.push("--delete-branch");
    try {
      await runGh(mergeArgs, opts.cwd, opts.signal);
      return {
        ok: true,
        merged: true,
        alreadyMerged: false,
        detail: `merged PR #${snapshot.number} (${strategy}) after checks were green`,
        prNumber: snapshot.number,
        serialized: locked,
      };
    } catch (err) {
      lastError = errText(err);
      if (isRetriableMergeError(lastError) && attempt < maxAttempts) {
        // The base moved between our fetch and the merge call — back off, then
        // loop to re-fetch and re-decide (behind → update, conflict → fail).
        await sleep(Math.min(MERGE_RETRY_BACKOFF_MS, remaining()), opts.signal);
        continue;
      }
      return { ok: false, error: `merge failed after green checks: ${lastError}` };
    }
  }

  return {
    ok: false,
    error: `PR did not converge to a landed state after ${maxAttempts} attempts${lastError ? ` (last: ${lastError})` : ""}`,
  };
}

/** `gh pr update-branch` — sync a behind PR head with its base before landing. */
async function updateBranch(
  prNumber: number,
  a: LandLoopArgs,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await a.runGh(["pr", "update-branch", String(prNumber)], a.opts.cwd, a.opts.signal);
    return { ok: true };
  } catch (err) {
    const message = errText(err);
    // update-branch merges the base into the head; a conflict there is the same
    // "needs human/agent resolution" signal as a CONFLICTING mergeable flag.
    if (/conflict/i.test(message)) {
      return {
        ok: false,
        error: `PR #${prNumber} is behind and its branch cannot be auto-updated (conflicts with base) — needs manual resolution`,
      };
    }
    return { ok: false, error: `could not update PR #${prNumber}'s branch: ${message}` };
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * How to re-invoke this steamtrain process from a `command` step.
 * Prefer the live entrypoint (`bun src/index.tsx` / `node dist/index.js`) so
 * bundled babysit workflows work in dev without a global install.
 */
export function resolveSteamtrainCliInvocation(
  argv: string[] = process.argv,
  execPath: string = process.execPath,
): string {
  const entry = argv[1];
  if (!entry) return "steamtrain";
  // Global install / PATH shim: argv[1] is already the steamtrain bin.
  if (/(^|[\\/])steamtrain(\.js)?$/.test(entry)) {
    return shellQuote(entry);
  }
  return `${shellQuote(execPath)} ${shellQuote(entry)}`;
}

function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
