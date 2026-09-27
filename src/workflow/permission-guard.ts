import { randomBytes } from "node:crypto";
import { lstat, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { STEAMTRAIN_STATE_DIR, isOutside } from "./fs-util";
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
 *
 * Outbound symlinks (links whose target resolves outside the workspace) are a
 * separate blind spot: writing through one mutates bytes the tree hash never
 * sees. {@link findOutboundSymlinks} rejects those before a read-only step runs.
 */

/** A workspace's complete working state, as one git tree object. */
export interface WorkspaceFingerprint {
  /** Directory that was fingerprinted. */
  cwd: string;
  /** Tree hash of the full working state. */
  tree: string;
}

/**
 * Paths pathspec-excluded from every fingerprint (engine-owned runtime state).
 * The linked paths are relative to the worktree root, not to the step's cwd,
 * hence `top`.
 */
function excludeArgs(linkedIgnoredPaths?: readonly string[]): string[] {
  return [
    `:!${STEAMTRAIN_STATE_DIR}`,
    ...(linkedIgnoredPaths ?? []).map((path) => `:(top,exclude)${path}`),
  ];
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
      // Status letter as git reports it: A added, M modified, D deleted, T type
      // changed, R renamed, C copied (only when the repo's own diff config
      // enables copy detection). Kept verbatim — "C src/x.ts" is as truthful a
      // violation as "M src/x.ts", and flattening it would lose information.
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

/**
 * The engine's own links in a fresh worktree, by repo-relative path, with the
 * target each one had when the step started. `linkedIgnoredPaths` (the lease's)
 * are ignored dependencies and build output linked back to the source checkout
 * so an agent can use them. They lead out of the workspace by design, and the
 * fingerprint already leaves them out, so {@link findOutboundSymlinks} accepts
 * them, but only while they still point where they did here.
 */
export async function linkedTargets(
  cwd: string,
  linkedIgnoredPaths: readonly string[] | undefined,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const targets = new Map<string, string>();
  if (!linkedIgnoredPaths?.length) return targets;
  try {
    const top = (await runGitText(["rev-parse", "--show-toplevel"], cwd, signal)).trim();
    for (const rel of linkedIgnoredPaths) {
      try {
        const abs = join(top, rel);
        if ((await lstat(abs)).isSymbolicLink()) targets.set(rel, await readlink(abs));
      } catch {
        // Gone already: nothing to accept, and nothing left to write through.
      }
    }
  } catch {
    // Not a repository: `findOutboundSymlinks` finds nothing there either.
  }
  return targets;
}

/**
 * Paths of symlinks under `cwd` whose targets resolve outside the workspace.
 * Used before read-only steps so an agent cannot exfiltrate or mutate bytes
 * through a pre-existing outbound link the tree-hash fingerprint would miss,
 * and after them, so it cannot leave one behind. The links in `accepted` (from
 * {@link linkedTargets}) are the engine's own. Each must still be there, still a
 * link, with its recorded target: gone is reported as `D`, replaced by a file or
 * directory as `T`, re-pointed as `L`, as the fingerprint leaves them out.
 */
export async function findOutboundSymlinks(
  cwd: string,
  options: { accepted?: ReadonlyMap<string, string>; signal?: AbortSignal } = {},
): Promise<string[]> {
  const { accepted, signal } = options;
  try {
    // Cached + untracked (honoring gitignore), same surface the fingerprint sees.
    const out = await runGitText(
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      cwd,
      signal,
    );
    // `accepted` is keyed from the worktree root; `ls-files` answers from `cwd`.
    const prefix = accepted?.size
      ? (await runGitText(["rev-parse", "--show-prefix"], cwd, signal)).trim()
      : "";
    const violations: string[] = [];
    const root = resolve(cwd);
    for (const rel of out.split("\0")) {
      if (!rel || accepted?.has(`${prefix}${rel}`)) continue;
      const abs = join(cwd, rel);
      try {
        const st = await lstat(abs);
        if (!st.isSymbolicLink()) continue;
        const target = await readlink(abs);
        const resolved = resolve(dirname(abs), target);
        const relToCwd = relative(root, resolved);
        if (isOutside(relToCwd)) {
          violations.push(`L ${rel} -> ${target}`);
        }
      } catch {
        // Broken / raced symlink — ignore; fingerprint will still see tree churn.
      }
    }
    for (const [key, recorded] of accepted ?? []) {
      // A link outside `cwd` is outside what this step was given to work in.
      if (!key.startsWith(prefix)) continue;
      const rel = key.slice(prefix.length);
      const st = await lstat(join(cwd, rel)).catch(() => undefined);
      if (!st) violations.push(`D ${rel}`);
      else if (!st.isSymbolicLink()) violations.push(`T ${rel}`);
      else {
        const target = await readlink(join(cwd, rel));
        if (target !== recorded) violations.push(`L ${rel} -> ${target}`);
      }
    }
    return violations;
  } catch {
    return [];
  }
}
