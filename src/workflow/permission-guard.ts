import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STEAMTRAIN_STATE_DIR } from "./fs-util";
import { runGit, runGitText } from "./worktree";

/**
 * Trust-but-verify for `read-only` steps.
 *
 * The permission profile is translated into each agent CLI's native flags
 * (`src/agents/permissions.ts`), but a flag is a promise made by someone else's
 * binary: a CLI can ignore it, a future version can rename it, a wrapper script
 * can strip it, and three of the nine supported agents can't express the
 * restriction at all. So the engine also checks the outcome — it fingerprints
 * the step's workspace before the agent starts and again when it finishes, and
 * fails a `read-only` step that changed anything.
 *
 * The fingerprint is a git **tree hash** of the entire working state (tracked
 * edits, deletions, and untracked files, honoring `.gitignore`), taken through
 * a throwaway index so the step's real index is never touched — the same
 * technique `merge.ts` uses to diff a worktree without disturbing it. A tree
 * hash rather than `git status` output because a read-only step's most
 * plausible violation is editing a file that was *already* dirty (the
 * `workspace: "attach:"` case, where an upstream step's edits are the starting
 * state): porcelain status would read ` M file` before and after and see
 * nothing, while the tree hash changes with the bytes.
 */

/** A workspace's complete working state, as one git tree object. */
export interface WorkspaceFingerprint {
  /** Directory that was fingerprinted. */
  cwd: string;
  /** Tree hash of the full working state. */
  tree: string;
}

/** Paths pathspec-excluded from every fingerprint (engine-owned runtime state). */
function excludeArgs(linkedIgnoredPaths?: readonly string[]): string[] {
  return [`:!${STEAMTRAIN_STATE_DIR}`, ...(linkedIgnoredPaths ?? []).map((path) => `:!${path}`)];
}

/**
 * Fingerprint a workspace's working state. Returns `undefined` when the
 * directory is not inside a git repository (a plain-cwd run has no cheap,
 * reliable way to do this) — callers treat that as "verification unavailable"
 * rather than as a pass or a failure.
 */
export async function fingerprintWorkspace(
  cwd: string,
  options: { linkedIgnoredPaths?: readonly string[]; signal?: AbortSignal } = {},
): Promise<WorkspaceFingerprint | undefined> {
  const { signal } = options;
  try {
    await runGitText(["rev-parse", "--is-inside-work-tree"], cwd, signal);
  } catch {
    return undefined;
  }
  const indexFile = join(tmpdir(), `steamtrain-perm-index-${randomBytes(6).toString("hex")}`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    // A fresh empty index + `add -A .` captures exactly the working state:
    // every tracked file at its current content, every untracked file git
    // would accept, and nothing that `.gitignore` excludes.
    await runGit(
      ["add", "-A", ".", "--", ...excludeArgs(options.linkedIgnoredPaths)],
      cwd,
      undefined,
      signal,
      env,
    );
    const tree = (await runGitText(["write-tree"], cwd, signal, env)).trim();
    return tree ? { cwd, tree } : undefined;
  } catch {
    // A repo git refuses to read (mid-rebase, permissions, exotic setup) must
    // not fail an otherwise healthy step — the profile's native enforcement
    // still applies; only the extra verification is unavailable.
    return undefined;
  } finally {
    await rm(indexFile, { force: true }).catch(() => undefined);
  }
}

/**
 * Paths that differ between two fingerprints of the same workspace, in
 * `git diff --name-status` order. Empty ⇒ the step left the workspace exactly
 * as it found it. `undefined` for either side means verification was
 * unavailable and the caller must not claim a violation.
 */
export async function fingerprintChanges(
  before: WorkspaceFingerprint | undefined,
  after: WorkspaceFingerprint | undefined,
  signal?: AbortSignal,
): Promise<string[]> {
  if (!before || !after || before.tree === after.tree) return [];
  try {
    const nameStatus = await runGitText(
      ["diff-tree", "-r", "--name-status", "--no-commit-id", before.tree, after.tree],
      after.cwd,
      signal,
    );
    const paths: string[] = [];
    for (const line of nameStatus.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split("\t");
      const status = parts[0] ?? "";
      // Renames/copies carry both paths; the destination is what changed.
      const path = parts[parts.length - 1];
      if (path) paths.push(`${status[0] ?? "M"} ${path}`);
    }
    // Two different trees always differ somewhere; if `diff-tree` says nothing
    // (a mode-only oddity, a git that fails silently), report the workspace
    // itself rather than swallowing a real violation.
    return paths.length > 0 ? paths : ["M (workspace state changed)"];
  } catch {
    return ["M (workspace state changed)"];
  }
}

/** Human-readable violation summary, capped so a rampage stays readable. */
export function describeViolations(paths: readonly string[], limit = 8): string {
  const shown = paths.slice(0, limit);
  const rest = paths.length - shown.length;
  return shown.join(", ") + (rest > 0 ? `, +${rest} more` : "");
}
