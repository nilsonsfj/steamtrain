import { rm, stat } from "node:fs/promises";
import type { RunRecord } from "./history";
import {
  type HarvestResult,
  type WorktreeSource,
  defaultHarvestBranchName,
  harvestWorktrees,
  pruneWorktree,
  worktreeSourceFromInfo,
} from "./merge";
import { runGit, runGitText } from "./worktree";

/**
 * Post-run worktree lifecycle, shared by the CLI, the web server, and the TUI:
 * harvesting a recorded run's step worktrees into the checkout / a branch / a
 * PR, discarding them, and repo-wide garbage collection of steamtrain
 * worktrees and branches (including orphans whose run record is gone).
 *
 * Worktrees are deliberately *retained* after a run (see worktree.ts) so the
 * user can inspect and land agent work later — which makes explicit lifecycle
 * closure everyone's problem. This module is the one place that closes it.
 */

/** The subset of the history store these helpers need to persist outcomes. */
export interface RunRecordSaver {
  save: (record: RunRecord) => Promise<void>;
}

/**
 * The harvestable worktrees of a recorded run: every step that ran in a git
 * worktree, deduped by step id keeping the LAST occurrence (a loop body step
 * appears once per iteration; the final iteration's worktree is its final
 * state).
 */
export function finalRunWorktrees(record: RunRecord, stepFilter?: string): WorktreeSource[] {
  const byId = new Map<string, WorktreeSource>();
  for (const phase of record.phases) {
    for (const step of phase.steps) {
      if (!step.worktree) continue;
      if (stepFilter && step.stepId !== stepFilter) continue;
      byId.set(step.stepId, worktreeSourceFromInfo(step.stepId, step.worktree));
    }
  }
  return [...byId.values()];
}

/**
 * EVERY recorded worktree of a run, including non-final loop iterations
 * (deduped by worktree root, not step id) — prune must remove them all, not
 * just each step's final iteration.
 */
export function allRunWorktrees(record: RunRecord): WorktreeSource[] {
  const byRoot = new Map<string, WorktreeSource>();
  for (const phase of record.phases) {
    for (const step of phase.steps) {
      if (!step.worktree) continue;
      byRoot.set(step.worktree.root, worktreeSourceFromInfo(step.stepId, step.worktree));
    }
  }
  return [...byRoot.values()];
}

export interface RunHarvestRequest {
  /** Restrict the harvest to one step's worktree. */
  step?: string;
  /** Where the merged changes land. Default `"apply"` (uncommitted, in the checkout). */
  mode?: "apply" | "branch" | "pr";
  /** Branch to leave the merged state on (branch/pr modes); generated when omitted. */
  branchName?: string;
  /** Deterministic conflict resolution: first-merged wins / last-merged wins. */
  onConflict?: "ours" | "theirs";
  signal?: AbortSignal;
}

export interface RunHarvestOutcome {
  result: HarvestResult;
  /** Set when the harvest succeeded but the run record could not be updated. */
  recordWarning?: string;
}

/**
 * Merge a recorded run's step worktrees per `request` and persist the outcome
 * on the run record (`harvest:` in `history show`), so "was this run ever
 * landed?" stays answerable. Throws {@link MergeConflictError} (or a plain
 * Error) on failure — the checkout is never left half-patched.
 */
export async function harvestRunWorktrees(
  store: RunRecordSaver,
  record: RunRecord,
  request: RunHarvestRequest = {},
): Promise<RunHarvestOutcome> {
  const sources = finalRunWorktrees(record, request.step);
  if (sources.length === 0) {
    throw new Error(
      request.step
        ? `run '${record.id}' has no worktree recorded for step '${request.step}'`
        : `run '${record.id}' has no step worktrees to harvest`,
    );
  }
  const mode = request.mode ?? "apply";
  const result = await harvestWorktrees({
    repoRoot: record.cwd,
    sources,
    mode,
    branchName:
      request.branchName ??
      (mode === "apply" ? undefined : defaultHarvestBranchName(record.workflow)),
    strategyOption: request.onConflict,
    signal: request.signal,
  });
  if (result.noChanges) return { result };

  record.harvest = {
    ...record.harvest,
    appliedSteps: [...new Set([...(record.harvest?.appliedSteps ?? []), ...result.mergedSources])],
    appliedAt: Date.now(),
    ...(result.branch ? { branch: result.branch } : {}),
    ...(result.prUrl ? { prUrl: result.prUrl } : {}),
  };
  let recordWarning: string | undefined;
  await store.save(record).catch((err: unknown) => {
    recordWarning = `could not update run record: ${err instanceof Error ? err.message : String(err)}`;
  });
  return { result, recordWarning };
}

export interface RunPruneOutcome {
  pruned: number;
  total: number;
  recordWarning?: string;
}

/** Discard a recorded run's worktrees and branches, and record the prune. */
export async function pruneRunWorktrees(
  store: RunRecordSaver,
  record: RunRecord,
): Promise<RunPruneOutcome> {
  const sources = allRunWorktrees(record);
  if (sources.length === 0) return { pruned: 0, total: 0 };
  let pruned = 0;
  for (const source of sources) {
    if (await pruneWorktree(source, record.cwd)) pruned += 1;
  }
  record.harvest = { ...record.harvest, prunedAt: Date.now() };
  let recordWarning: string | undefined;
  await store.save(record).catch((err: unknown) => {
    recordWarning = `could not update run record: ${err instanceof Error ? err.message : String(err)}`;
  });
  return { pruned, total: sources.length, recordWarning };
}

/**
 * Actionable next steps after a source-vs-source merge conflict, phrased for
 * the surface that hit it. Shared so the CLI, web UI, and engine agree on
 * what "what now?" looks like.
 */
export function mergeConflictGuidance(surface: "history" | "merge-step"): string {
  if (surface === "merge-step") {
    return (
      'set onConflict to "ours"/"theirs" (deterministic winner) or "agent" (an agent resolves the markers), ' +
      "or harvest later with 'steamtrain workflow history apply <runId> --onconflict ours|theirs [--mode branch]'"
    );
  }
  return (
    "retry with --onconflict ours|theirs (deterministic winner), --mode branch (merge by hand from a branch), " +
    'or --step <stepId> (land one step at a time); a merge step with onConflict "agent" resolves conflicts with an LLM during the run'
  );
}

// ── Repo-wide worktree garbage collection ────────────────────────────────

/** One steamtrain worktree/branch discovered in a repository. */
export interface RepoWorktreeEntry {
  /** The run segment of the branch name (`steamtrain/<runId>/…`). */
  runId: string;
  branch: string;
  /** Worktree directory, when git still has it registered. */
  root?: string;
  /** Whether the worktree directory still exists on disk. */
  exists: boolean;
  /**
   * Whether the worktree appears to hold work: uncommitted edits, or commits
   * on the branch that are not reachable from the repo's HEAD (snapshots).
   * Best-effort — used to protect unharvested work from GC, never to lose it.
   */
  changed: boolean;
  /** Best-effort age (record start, else dir mtime, else branch commit time). */
  ageMs?: number;
  /** Cross-referenced run record, when one still exists in history. */
  record?: {
    id: string;
    workflow: string;
    startedAt: number;
    applied: boolean;
    pruned: boolean;
  };
}

/** Merge deliverables (`steamtrain/merged/*`) are never GC targets. */
const MERGED_BRANCH_PREFIX = "steamtrain/merged/";
/** All steamtrain-owned branches; step worktree branches are these minus merged/. */
const BRANCH_PREFIX = "steamtrain/";

/**
 * Enumerate every steamtrain step worktree/branch in `repoRoot` — including
 * orphans whose run record is gone or whose directory was cleared by the OS
 * tmp reaper — cross-referenced against the given run records.
 */
export async function listRepoWorktrees(
  repoRoot: string,
  records: RunRecord[] = [],
): Promise<RepoWorktreeEntry[]> {
  const branches = (
    await runGitText(["branch", "--list", "steamtrain/*", "--format=%(refname:short)"], repoRoot)
  )
    .split("\n")
    .map((line) => line.trim())
    .filter((name) => name.startsWith(BRANCH_PREFIX) && !name.startsWith(MERGED_BRANCH_PREFIX));

  // branch -> registered worktree path, from `git worktree list`.
  const rootByBranch = new Map<string, string>();
  const porcelain = await runGitText(["worktree", "list", "--porcelain"], repoRoot);
  let currentRoot: string | undefined;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) currentRoot = line.slice("worktree ".length).trim();
    else if (line.startsWith("branch refs/heads/") && currentRoot) {
      rootByBranch.set(line.slice("branch refs/heads/".length).trim(), currentRoot);
    }
  }

  // branch -> record + recorded base commit, from history.
  const recordByBranch = new Map<string, { record: RunRecord; baseCommit?: string }>();
  for (const record of records) {
    for (const phase of record.phases) {
      for (const step of phase.steps) {
        if (step.worktree) {
          recordByBranch.set(step.worktree.branch, {
            record,
            baseCommit: step.worktree.baseCommit,
          });
        }
      }
    }
  }

  const entries: RepoWorktreeEntry[] = [];
  for (const branch of branches) {
    const runId = branch.split("/")[1] ?? "unknown";
    const root = rootByBranch.get(branch);
    const exists = root
      ? await stat(root).then(
          (st) => st.isDirectory(),
          () => false,
        )
      : false;
    const recorded = recordByBranch.get(branch);

    let changed = false;
    if (exists && root) {
      // Fail protective: a worktree whose state can't be read (corrupted
      // .git file, permissions) may still hold uncommitted work — treat it
      // as changed so GC skips it rather than eating it.
      changed = await runGitText(["status", "--porcelain"], root).then(
        (status) => status.trim().length > 0,
        () => true,
      );
    }
    if (!changed) {
      const tip = (
        await runGitText(["rev-parse", "--verify", branch], repoRoot).catch(() => "")
      ).trim();
      if (tip) {
        if (recorded?.baseCommit) {
          changed = tip !== recorded.baseCommit;
        } else {
          // No recorded base: a tip that is not an ancestor of HEAD carries
          // its own (snapshot) commits — treat as holding work.
          changed = !(await runGit(["merge-base", "--is-ancestor", tip, "HEAD"], repoRoot).then(
            () => true,
            () => false,
          ));
        }
      }
    }

    let ageMs: number | undefined;
    if (recorded) ageMs = Date.now() - recorded.record.startedAt;
    else if (exists && root) {
      ageMs = await stat(root).then(
        (st) => Date.now() - st.mtimeMs,
        () => undefined,
      );
    }
    if (ageMs === undefined) {
      const committed = (
        await runGitText(["log", "-1", "--format=%ct", branch], repoRoot).catch(() => "")
      ).trim();
      if (committed) ageMs = Date.now() - Number(committed) * 1000;
    }

    entries.push({
      runId,
      branch,
      root,
      exists,
      changed,
      ageMs,
      record: recorded
        ? {
            id: recorded.record.id,
            workflow: recorded.record.workflow,
            startedAt: recorded.record.startedAt,
            applied: Boolean(recorded.record.harvest?.appliedSteps?.length),
            pruned: Boolean(recorded.record.harvest?.prunedAt),
          }
        : undefined,
    });
  }
  return entries;
}

export interface WorktreeGcOptions {
  repoRoot: string;
  /** Full run records for cross-referencing (history list → get). */
  records?: RunRecord[];
  /** Prune only this worktree run id (`steamtrain/<runId>/…`). */
  runId?: string;
  /** Prune worktrees older than this. */
  olderThanMs?: number;
  /** Prune everything. */
  all?: boolean;
  /** Also prune worktrees that appear to hold unharvested work. */
  force?: boolean;
  /** Report what would be pruned without touching anything. */
  dryRun?: boolean;
}

export interface WorktreeGcResult {
  removed: RepoWorktreeEntry[];
  skipped: { entry: RepoWorktreeEntry; reason: string }[];
  /** Entries the selection did not target at all. */
  kept: RepoWorktreeEntry[];
}

/**
 * Repo-wide GC of steamtrain step worktrees and branches. Selection: `runId`,
 * `olderThanMs`, or `all`; with no selector only *stale* entries (worktree
 * directory gone — OS tmp reaper, manual deletion) are targeted, which is the
 * always-safe default. Entries that appear to hold unharvested work
 * (uncommitted edits or unlanded snapshot commits, and no recorded
 * apply/prune) are skipped unless `force` — GC must never eat work the user
 * hasn't landed or explicitly discarded.
 */
export async function gcRepoWorktrees(options: WorktreeGcOptions): Promise<WorktreeGcResult> {
  const entries = await listRepoWorktrees(options.repoRoot, options.records ?? []);
  const removed: RepoWorktreeEntry[] = [];
  const skipped: { entry: RepoWorktreeEntry; reason: string }[] = [];
  const kept: RepoWorktreeEntry[] = [];

  for (const entry of entries) {
    const selected =
      options.all ||
      (options.runId !== undefined && entry.runId === options.runId) ||
      (options.olderThanMs !== undefined &&
        entry.ageMs !== undefined &&
        entry.ageMs >= options.olderThanMs) ||
      // With no explicit selector, target only stale entries.
      (options.runId === undefined &&
        options.olderThanMs === undefined &&
        !options.all &&
        !entry.exists);
    if (!selected) {
      kept.push(entry);
      continue;
    }
    const harvested = entry.record?.applied || entry.record?.pruned;
    if (entry.changed && !harvested && !options.force) {
      skipped.push({
        entry,
        reason: "appears to hold unharvested work (apply or prune it first, or pass --force)",
      });
      continue;
    }
    if (!options.dryRun) {
      // Best-effort by design: GC is not a critical path, and each step can
      // legitimately fail (dir already gone, registration already pruned).
      // The trailing `git worktree prune` below sweeps any registration a
      // failed `worktree remove` left behind.
      if (entry.root) {
        await runGit(["worktree", "remove", "--force", entry.root], options.repoRoot).catch(
          () => {},
        );
        await rm(entry.root, { recursive: true, force: true }).catch(() => {});
      }
      await runGit(["branch", "-D", entry.branch], options.repoRoot).catch(() => {});
    }
    removed.push(entry);
  }

  if (!options.dryRun && removed.length > 0) {
    await runGit(["worktree", "prune"], options.repoRoot).catch(() => {});
  }
  return { removed, skipped, kept };
}
