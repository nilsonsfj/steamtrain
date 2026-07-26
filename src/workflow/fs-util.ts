import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

/**
 * Whether a `relative(base, target)` result points outside `base`: it walks up
 * (`..`), or it is absolute (`relative` returns the target verbatim when the
 * two paths share no root). Used wherever a computed path gates a filesystem
 * operation that must stay inside a sandbox directory (worktree cwds, artifact
 * snapshot destinations).
 *
 * Checks both `/` and `\` separators so a forward-slash `../` cannot bypass
 * the guard on Windows (where `sep` is `\`).
 */
export function isOutside(rel: string): boolean {
  if (rel === ".." || resolve(rel) === rel) return true;
  if (rel.startsWith("../") || rel.startsWith("..\\")) return true;
  // Also catch the platform sep form (redundant on POSIX/Win after the above,
  // but keeps the historical `..${sep}` check explicit).
  if (rel.startsWith(`..${sep}`)) return true;
  return false;
}

/** Maximum length for a single path-component id (run ids, step ids, …). */
export const MAX_PATH_COMPONENT_LENGTH = 256;

/**
 * Restrict an id to filesystem-safe characters for use as a single path
 * component. Ids are normally UUIDs/step ids, but be defensive against path
 * traversal. Shared by the history and live-run stores (their on-disk names
 * must agree so `::` in namespaced step ids always maps to `__`).
 * Truncates to {@link MAX_PATH_COMPONENT_LENGTH} after sanitization.
 */
export function sanitizePathComponent(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (cleaned.length <= MAX_PATH_COMPONENT_LENGTH) return cleaned;
  return cleaned.slice(0, MAX_PATH_COMPONENT_LENGTH);
}

/** True when a URL/path id is within length bounds before sanitization. */
export function isValidPathId(id: string, maxLength = MAX_PATH_COMPONENT_LENGTH): boolean {
  return id.length > 0 && id.length <= maxLength;
}

/**
 * The engine's run-state directory at the workflow cwd (history, cache — see
 * `WORKFLOW_HISTORY_DIR` / `WORKFLOW_CACHE_DIR`). Worktree snapshotting and
 * merge-back harvesting treat it as engine-owned runtime state: it is never
 * copied into a fresh worktree and never staged by a harvest, whether or not
 * the repo gitignores it. Without this, parallel worktrees each carry a
 * slightly different copy of the cache and every multi-source merge hits a
 * spurious add/add conflict on state files.
 */
export const STEAMTRAIN_STATE_DIR = ".steamtrain";

/** True when `rel` (a git-style `/`-separated relative path) is the state dir or inside it. */
export function isSteamtrainStatePath(rel: string): boolean {
  return (
    rel === STEAMTRAIN_STATE_DIR ||
    rel.startsWith(`${STEAMTRAIN_STATE_DIR}/`) ||
    rel.startsWith(`${STEAMTRAIN_STATE_DIR}\\`)
  );
}

/** True when an error is a "file/dir does not exist" (ENOENT) failure. */
export function isEnoent(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "ENOENT",
  );
}

/**
 * Atomically write a file: ensure the parent directory exists, write the
 * contents to a temp sibling, then `rename` it into place. The rename is atomic
 * on POSIX filesystems, so a reader never observes a half-written file (and a
 * crash mid-write leaves the previous version intact). Shared by the on-disk
 * cache and history stores.
 */
export async function atomicWriteFile(target: string, contents: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, contents, "utf8");
  await rename(temp, target);
}
