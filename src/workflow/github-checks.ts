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

export interface PullRequestCheckSnapshot {
  /** PR number. */
  number: number;
  /** open | closed | merged (derived from state + mergedAt). */
  state: "open" | "closed" | "merged";
  headRefName: string;
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
  "CANCELLED",
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

  const now = opts.nowMs ?? Date.now();
  const graceMs = opts.emptyGraceMs ?? DEFAULT_EMPTY_GRACE_MS;
  const checks = snapshot.checks;

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
  statusCheckRollup?: unknown;
  commits?: unknown;
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
      "number,state,mergedAt,headRefName,statusCheckRollup,commits",
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
    headCommittedAt: latestCommitTimestamp(parsed.commits),
    checks: parseStatusCheckRollup(parsed.statusCheckRollup),
  };
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
}

export type MergeWhenReadyResult =
  | { ok: true; merged: boolean; alreadyMerged: boolean; detail: string; prNumber: number }
  | { ok: false; error: string };

/**
 * Wait until every check is green, then merge. Branch deletion happens only
 * after checks are terminal green — never while an external review still needs
 * the remote ref.
 */
export async function mergePullRequestWhenReady(
  opts: MergeWhenReadyOptions,
): Promise<MergeWhenReadyResult> {
  const waited = await waitForPullRequestChecks(opts);
  if (!waited.ok) return { ok: false, error: waited.error };
  const snapshot = waited.snapshot;
  if (snapshot.state === "merged") {
    return {
      ok: true,
      merged: false,
      alreadyMerged: true,
      detail: waited.evaluation.detail,
      prNumber: snapshot.number,
    };
  }

  const strategy = opts.mergeStrategy ?? "squash";
  const args = ["pr", "merge", String(snapshot.number), `--${strategy}`];
  if (opts.deleteBranch !== false) args.push("--delete-branch");

  try {
    await runCommand("gh", args, opts.cwd, opts.signal);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `merge failed after green checks: ${message}` };
  }
  return {
    ok: true,
    merged: true,
    alreadyMerged: false,
    detail: `merged PR #${snapshot.number} (${strategy}) after checks were green`,
    prNumber: snapshot.number,
  };
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
