import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentWorktreeInfo } from "./types";
import { runGit, runGitText, withRepoWorktreeLock } from "./worktree";

/**
 * Worktree harvesting: turn the retained per-step git worktrees (see
 * `worktree.ts`) into something the user can actually use. Every agent step
 * leaves its edits *uncommitted* in an isolated worktree on a steamtrain
 * branch; this module snapshots that state into commits, merges any number of
 * step worktrees together in an isolated staging worktree (with pluggable
 * conflict resolution — deterministic `ours`/`theirs`, a caller-supplied
 * resolver such as an LLM agent, or fail), and delivers the result:
 *
 *  - `apply`  — the merged diff lands in the user's checkout as uncommitted
 *               working-tree changes (nothing is committed on their behalf);
 *  - `branch` — the merged state is left on a named local branch;
 *  - `pr`     — the branch is pushed and a pull request is opened via `gh`.
 *
 * The same primitives power the `merge` workflow step (engine.ts) and the
 * `workflow history show --diff` / `history apply` CLI, so automated and
 * manual harvesting cannot drift apart.
 */

/** One step worktree to harvest — the recorded `StepResult.worktree` fields. */
export interface WorktreeSource {
  /** Step (or fan-out child) id, for labels and error messages. */
  stepId: string;
  /** Worktree root directory. */
  root: string;
  /** The steamtrain branch checked out in the worktree. */
  branch: string;
  /**
   * Commit the branch started from. Recorded by the worktree manager for new
   * runs; when absent (older records), the worktree's merge-base with the
   * target ref is used instead.
   */
  baseCommit?: string;
  /** Ignored runtime entries symlinked into the worktree (excluded from diffs). */
  linkedIgnoredPaths?: string[];
}

export interface DiffFileStat {
  path: string;
  /** Git name-status letter: A, M, D, R…, or "?" for binary/unparsed rows. */
  status: string;
  additions: number;
  deletions: number;
}

export interface WorktreeDiff {
  base: string;
  files: DiffFileStat[];
  additions: number;
  deletions: number;
  /** Full unified patch (binary-safe) when requested. */
  patch?: string;
}

export type ConflictResolvedBy = "agent" | "ours" | "theirs";

export interface ConflictRecord {
  /** Source step whose merge conflicted. */
  stepId: string;
  files: string[];
  resolvedBy: ConflictResolvedBy;
}

/**
 * Resolve merge conflicts left in `stagingRoot` (standard conflict markers;
 * `files` are the unmerged paths). Implementations edit the files in place —
 * concluding the merge commit is optional, the caller finishes any merge still
 * in progress. Throw to fail the harvest.
 */
export type ConflictResolver = (conflict: {
  stagingRoot: string;
  stepId: string;
  files: string[];
}) => Promise<void>;

export interface HarvestRequest {
  /** Root of the repository the changes should land in. */
  repoRoot: string;
  sources: WorktreeSource[];
  mode: "apply" | "branch" | "pr";
  /** Branch to leave the merged state on (branch/pr modes); generated when omitted. */
  branchName?: string;
  commitMessage?: string;
  prTitle?: string;
  prBody?: string;
  /** Deterministic conflict strategy passed to `git merge -X`. */
  strategyOption?: "ours" | "theirs";
  /** Called for conflicts when no deterministic strategy is set. */
  resolveConflicts?: ConflictResolver;
  signal?: AbortSignal;
}

export interface HarvestResult {
  mode: HarvestRequest["mode"];
  /** Step ids whose worktrees contributed changes. */
  mergedSources: string[];
  /** Step ids whose worktrees had no changes (skipped). */
  unchangedSources: string[];
  files: DiffFileStat[];
  additions: number;
  deletions: number;
  conflicts: ConflictRecord[];
  /** The branch holding the merged state (branch/pr modes). */
  branch?: string;
  /** The created pull request URL (pr mode). */
  prUrl?: string;
  /** True when no source had any changes; delivery was skipped. */
  noChanges: boolean;
}

export class MergeConflictError extends Error {
  readonly files: string[];
  readonly stepId: string;
  constructor(stepId: string, files: string[]) {
    super(
      `merging worktree of step '${stepId}' conflicts in ${files.length} file${files.length === 1 ? "" : "s"}: ${files.join(", ")}`,
    );
    this.files = files;
    this.stepId = stepId;
  }
}

/** Identity used for snapshot/merge commits so harvesting works in repos without user.name. */
const GIT_IDENT = [
  "-c",
  "user.name=steamtrain",
  "-c",
  "user.email=steamtrain@localhost",
  "-c",
  "commit.gpgsign=false",
];

/**
 * Build `git add -A` args that exclude paths previously symlinked into the
 * worktree by `linkIgnoredRuntimeEntries`. These paths are symlinks pointing
 * at the real repo's scaffolding (node_modules, dist, .claude, etc.) — without
 * exclusion they get staged as new mode-120000 entries because `.gitignore`
 * directory patterns don't match symlinks.
 */
function gitAddArgsWithExcludes(linkedIgnoredPaths?: string[]): string[] {
  if (!linkedIgnoredPaths?.length) return ["add", "-A", "."];
  const pathspecs = linkedIgnoredPaths.map((p) => `:!${p}`);
  return ["add", "-A", ".", "--", ...pathspecs];
}

export function worktreeSourceFromInfo(stepId: string, info: AgentWorktreeInfo): WorktreeSource {
  return {
    stepId,
    root: info.root,
    branch: info.branch,
    baseCommit: info.baseCommit,
    linkedIgnoredPaths: info.linkedIgnoredPaths,
  };
}

async function assertWorktreeExists(source: WorktreeSource): Promise<void> {
  try {
    const st = await stat(source.root);
    if (!st.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(
      `worktree for step '${source.stepId}' no longer exists at ${source.root} (pruned or cleaned up?)`,
    );
  }
}

/** The diff base for a source: its recorded base commit, else merge-base with `ref`. */
async function resolveBase(
  source: WorktreeSource,
  ref: string,
  signal?: AbortSignal,
): Promise<string> {
  if (source.baseCommit) return source.baseCommit;
  const head = (await runGitText(["rev-parse", "--verify", "HEAD"], source.root, signal)).trim();
  try {
    return (await runGitText(["merge-base", head, ref], source.root, signal)).trim();
  } catch {
    return head;
  }
}

/**
 * Diff a step worktree's current state (tracked edits AND untracked files)
 * against its base commit — without mutating the worktree. Uses a throwaway
 * GIT_INDEX_FILE so `git add -A` can stage the full working state for
 * comparison while the worktree's real index and branch stay untouched.
 */
export async function worktreeDiff(
  source: WorktreeSource,
  opts: { patch?: boolean; ref?: string; signal?: AbortSignal } = {},
): Promise<WorktreeDiff> {
  await assertWorktreeExists(source);
  const base = await resolveBase(source, opts.ref ?? "HEAD", opts.signal);
  const tempIndex = join(tmpdir(), `steamtrain-diff-index-${randomBytes(6).toString("hex")}`);
  const env = { GIT_INDEX_FILE: tempIndex };
  try {
    // Populate the throwaway index from the base tree first, then stage the
    // working state over it: `git add -A` from an empty index would miss
    // deletions of files that were never staged.
    await runGit(["read-tree", base], source.root, undefined, opts.signal, env);
    await runGit(gitAddArgsWithExcludes(source.linkedIgnoredPaths), source.root, undefined, opts.signal, env);
    const stats = parseNumstat(
      await gitTextEnv(["diff", "--cached", "--numstat", base], source.root, env, opts.signal),
      await gitTextEnv(["diff", "--cached", "--name-status", base], source.root, env, opts.signal),
    );
    const patch = opts.patch
      ? await gitTextEnv(["diff", "--cached", "--binary", base], source.root, env, opts.signal)
      : undefined;
    return {
      base,
      files: stats,
      additions: stats.reduce((n, f) => n + f.additions, 0),
      deletions: stats.reduce((n, f) => n + f.deletions, 0),
      patch,
    };
  } finally {
    await unlink(tempIndex).catch(() => {});
  }
}

async function gitTextEnv(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  signal?: AbortSignal,
): Promise<string> {
  return (await runGit(args, cwd, undefined, signal, env)).toString("utf8");
}

function parseNumstat(numstat: string, nameStatus: string): DiffFileStat[] {
  const statusByPath = new Map<string, string>();
  for (const line of nameStatus.split("\n")) {
    if (!line.trim()) continue;
    const [status, ...paths] = line.split("\t");
    const path = paths[paths.length - 1];
    if (status && path) statusByPath.set(path, status[0] ?? "?");
  }
  const files: DiffFileStat[] = [];
  const seen = new Set<string>();
  for (const line of numstat.split("\n")) {
    if (!line.trim()) continue;
    const [added, deleted, ...paths] = line.split("\t");
    const rawPath = paths.join("\t");
    if (!rawPath) continue;
    // `--numstat` prints renames as "old => new" (optionally brace-collapsed,
    // "src/{old => new}/file"), while `--name-status` keys them by the new
    // path only — resolve to the new path so one rename isn't reported twice.
    const renamed = numstatRenamePath(rawPath);
    const path = renamed !== undefined && statusByPath.has(renamed) ? renamed : rawPath;
    seen.add(path);
    files.push({
      path,
      status: statusByPath.get(path) ?? "?",
      // "-" for binary files
      additions: added === "-" ? 0 : Number(added) || 0,
      deletions: deleted === "-" ? 0 : Number(deleted) || 0,
    });
  }
  // Entries numstat has no line counts for (submodule pointer changes, some
  // rename edges) still exist in name-status — keep them with 0/0 counts
  // rather than dropping them from the report.
  for (const [path, status] of statusByPath) {
    if (!seen.has(path)) files.push({ path, status, additions: 0, deletions: 0 });
  }
  return files;
}

/** New path of a numstat rename entry, or undefined if `raw` is not one. */
function numstatRenamePath(raw: string): string | undefined {
  if (!raw.includes(" => ")) return undefined;
  if (raw.includes("{")) {
    return raw.replace(/\{([^{}]*) => ([^{}]*)\}/g, "$2").replace(/\/{2,}/g, "/");
  }
  return raw.slice(raw.indexOf(" => ") + 4);
}

/**
 * Commit the worktree's full working state (tracked edits + untracked files)
 * onto its steamtrain branch, if anything changed since the last commit.
 * Returns the commit to merge from. The branch belongs to steamtrain, so
 * committing here is safe — and it makes the harvested state durable and
 * inspectable (`git log`/`git show` on the recorded branch).
 */
export async function snapshotWorktreeState(
  source: WorktreeSource,
  signal?: AbortSignal,
): Promise<{ commit: string; changed: boolean }> {
  await assertWorktreeExists(source);
  // Resolve the base BEFORE committing: for sources without a recorded
  // baseCommit the fallback is a merge-base against the worktree's own HEAD,
  // which after the snapshot commit would be the snapshot itself — every
  // source would then look unchanged and harvesting would silently no-op.
  const base = await resolveBase(source, "HEAD", signal);
  await runGit(gitAddArgsWithExcludes(source.linkedIgnoredPaths), source.root, undefined, signal);
  const staged = await runGit(["diff", "--cached", "--quiet"], source.root, undefined, signal).then(
    () => false,
    () => true,
  );
  if (staged) {
    await runGit(
      [...GIT_IDENT, "commit", "-m", `steamtrain: snapshot of step '${source.stepId}'`],
      source.root,
      undefined,
      signal,
    );
  }
  const head = (await runGitText(["rev-parse", "--verify", "HEAD"], source.root, signal)).trim();
  return { commit: head, changed: head !== base };
}

function randomSuffix(): string {
  return randomBytes(4).toString("hex");
}

export function defaultHarvestBranchName(label: string): string {
  const safe =
    label
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "step";
  return `steamtrain/merged/${safe}-${randomSuffix()}`;
}

/**
 * Merge the given step worktrees into `repoRoot`'s current HEAD and deliver
 * the result per `request.mode`. All merging happens in a throwaway staging
 * worktree; the user's checkout is only ever touched by `apply` mode, and then
 * only via a pre-checked `git apply` (all-or-nothing, uncommitted).
 */
export async function harvestWorktrees(request: HarvestRequest): Promise<HarvestResult> {
  const { sources, mode, signal } = request;
  if (sources.length === 0) throw new Error("no worktree sources to merge");
  // `git apply` silently skips paths outside its cwd, so a repoRoot that is
  // actually a subdirectory (e.g. a run recorded from packages/app) would drop
  // out-of-tree changes while reporting success — resolve the true top level.
  const repoRoot = (
    await runGitText(["rev-parse", "--show-toplevel"], request.repoRoot, signal)
  ).trim();
  const targetHead = (await runGitText(["rev-parse", "--verify", "HEAD"], repoRoot, signal)).trim();

  // Snapshot every source first (commit its working state on its own branch).
  // Under the repo lock: concurrent merge steps sharing a source would
  // otherwise run add/commit on the same worktree index at once.
  const snapshots: { source: WorktreeSource; commit: string }[] = [];
  const unchangedSources: string[] = [];
  for (const source of sources) {
    const snap = await withRepoWorktreeLock(repoRoot, signal, () =>
      snapshotWorktreeState(source, signal),
    );
    if (snap.changed) snapshots.push({ source, commit: snap.commit });
    else unchangedSources.push(source.stepId);
  }

  const empty: HarvestResult = {
    mode,
    mergedSources: [],
    unchangedSources,
    files: [],
    additions: 0,
    deletions: 0,
    conflicts: [],
    noChanges: true,
  };
  if (snapshots.length === 0) return empty;

  const branch = request.branchName ?? defaultHarvestBranchName(snapshots[0]!.source.stepId);
  const stagingDir = join(tmpdir(), `steamtrain-merge-${randomSuffix()}`);
  const conflicts: ConflictRecord[] = [];
  let keepBranch = false;
  try {
    await withRepoWorktreeLock(repoRoot, signal, () =>
      runGit(
        ["worktree", "add", "-B", branch, stagingDir, targetHead],
        repoRoot,
        undefined,
        signal,
      ),
    );

    for (const { source, commit } of snapshots) {
      await mergeOneSource(stagingDir, source, commit, request, conflicts, signal);
    }

    const stats = parseNumstat(
      await runGitText(["diff", "--numstat", targetHead, "HEAD"], stagingDir, signal),
      await runGitText(["diff", "--name-status", targetHead, "HEAD"], stagingDir, signal),
    );
    const result: HarvestResult = {
      mode,
      mergedSources: snapshots.map((s) => s.source.stepId),
      unchangedSources,
      files: stats,
      additions: stats.reduce((n, f) => n + f.additions, 0),
      deletions: stats.reduce((n, f) => n + f.deletions, 0),
      conflicts,
      noChanges: stats.length === 0,
    };
    if (result.noChanges) return result;

    if (mode === "apply") {
      await applyRangeToWorkspace(repoRoot, targetHead, "HEAD", stagingDir, signal);
      return result;
    }
    keepBranch = true;
    result.branch = branch;
    if (mode === "pr") {
      // Base the PR on the branch the merge targeted: without --base, gh
      // defaults to the remote's default branch, so a run from a feature
      // branch would open a PR whose diff includes the whole feature branch.
      const baseBranch = await runGitText(["symbolic-ref", "--short", "HEAD"], repoRoot, signal)
        .then((b) => b.trim() || undefined)
        .catch(() => undefined);
      await runGit(["push", "-u", "origin", branch], stagingDir, undefined, signal);
      result.prUrl = await createPullRequest(stagingDir, {
        branch,
        base: baseBranch,
        title: request.prTitle,
        body: request.prBody,
        signal,
      });
    }
    return result;
  } finally {
    await runGit(["worktree", "remove", "--force", stagingDir], repoRoot).catch(() => {});
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    if (!keepBranch) await runGit(["branch", "-D", branch], repoRoot).catch(() => {});
  }
}

async function mergeOneSource(
  stagingDir: string,
  source: WorktreeSource,
  commit: string,
  request: HarvestRequest,
  conflicts: ConflictRecord[],
  signal?: AbortSignal,
): Promise<void> {
  const message =
    request.commitMessage ?? `steamtrain: merge step '${source.stepId}' (${source.branch})`;
  const strategyArgs = request.strategyOption ? ["-X", request.strategyOption] : [];
  let mergeError: string | undefined;
  const merged = await runGit(
    [...GIT_IDENT, "merge", "--no-ff", ...strategyArgs, "-m", message, commit],
    stagingDir,
    undefined,
    signal,
  ).then(
    () => true,
    (err: unknown) => {
      mergeError = err instanceof Error ? err.message : String(err);
      return false;
    },
  );
  if (merged) return;

  const unmerged = (
    await runGitText(["diff", "--name-only", "--diff-filter=U"], stagingDir, signal)
  )
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (unmerged.length === 0) {
    // The merge failed for a non-conflict reason (unrelated histories, dirty
    // staging tree, …) — abort and surface git's own explanation.
    await runGit(["merge", "--abort"], stagingDir).catch(() => {});
    throw new Error(
      `git merge of step '${source.stepId}' (${commit.slice(0, 12)}) failed${mergeError ? `: ${mergeError}` : ""}`,
    );
  }
  if (!request.resolveConflicts) {
    await runGit(["merge", "--abort"], stagingDir).catch(() => {});
    throw new MergeConflictError(source.stepId, unmerged);
  }

  await request.resolveConflicts({
    stagingRoot: stagingDir,
    stepId: source.stepId,
    files: unmerged,
  });

  // Stage whatever the resolver wrote (this is what clears the unmerged index
  // entries), then verify nothing is left conflicted before concluding.
  await runGit(["add", "-A", "."], stagingDir, undefined, signal);
  const stillUnmerged = (await runGitText(["ls-files", "-u"], stagingDir, signal))
    .split("\n")
    .map((l) => l.split("\t")[1] ?? "")
    .filter(Boolean);
  if (stillUnmerged.length > 0) {
    await runGit(["merge", "--abort"], stagingDir).catch(() => {});
    throw new MergeConflictError(source.stepId, [...new Set(stillUnmerged)]);
  }
  // Conclude the merge if the resolver edited files without committing.
  const mergeInProgress = await runGitText(
    ["rev-parse", "-q", "--verify", "MERGE_HEAD"],
    stagingDir,
  )
    .then(() => true)
    .catch(() => false);
  if (mergeInProgress) {
    await runGit([...GIT_IDENT, "commit", "--no-edit"], stagingDir, undefined, signal);
  }
  conflicts.push({ stepId: source.stepId, files: unmerged, resolvedBy: "agent" });
}

/**
 * Land the staging worktree's `from..to` diff in the user's checkout as
 * uncommitted working-tree changes. `git apply --check` runs first so the
 * apply is all-or-nothing: a checkout with conflicting local edits fails
 * cleanly with guidance instead of ending up half-patched.
 */
async function applyRangeToWorkspace(
  repoRoot: string,
  from: string,
  to: string,
  stagingDir: string,
  signal?: AbortSignal,
): Promise<void> {
  const patch = await runGit(["diff", "--binary", from, to], stagingDir, undefined, signal);
  if (patch.length === 0) return;
  const check = await runGit(["apply", "--binary", "--check", "-"], repoRoot, patch, signal).then(
    () => undefined,
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
  if (check !== undefined) {
    throw new Error(
      `merged changes do not apply cleanly to ${repoRoot} (local edits or a moved HEAD conflict with them): ${check}. Use mode "branch" and merge manually, or stash/clean the conflicting local changes and re-run.`,
    );
  }
  await runGit(["apply", "--binary", "-"], repoRoot, patch, signal);
}

async function createPullRequest(
  cwd: string,
  opts: { branch: string; base?: string; title?: string; body?: string; signal?: AbortSignal },
): Promise<string> {
  const args = [
    "pr",
    "create",
    "--head",
    opts.branch,
    ...(opts.base ? ["--base", opts.base] : []),
    "--title",
    opts.title ?? `steamtrain: ${opts.branch}`,
    "--body",
    opts.body ?? "Automated merge-back of steamtrain agent worktrees.",
  ];
  const output = await runCommand("gh", args, cwd, opts.signal);
  const url = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^https?:\/\//.test(l))
    .pop();
  return url ?? output.trim();
}

/** Remove a step worktree and its branch (discard/prune). Best-effort by design. */
export async function pruneWorktree(source: WorktreeSource, repoRoot: string): Promise<boolean> {
  const removed = await runGit(["worktree", "remove", "--force", source.root], repoRoot).then(
    () => true,
    () => false,
  );
  await rm(source.root, { recursive: true, force: true }).catch(() => {});
  await runGit(["worktree", "prune"], repoRoot).catch(() => {});
  await runGit(["branch", "-D", source.branch], repoRoot).catch(() => {});
  return removed;
}

function runCommand(
  binary: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    const child = spawn(binary, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      reject(new Error("cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      reject(
        err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error(`'${binary}' is not installed or not on PATH`)
          : err,
      );
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) resolvePromise(Buffer.concat(stdout).toString("utf8"));
      else {
        const message = Buffer.concat(stderr).toString("utf8").trim();
        reject(new Error(`${binary} ${args.join(" ")} failed${message ? `: ${message}` : ""}`));
      }
    });
  });
}
