import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

/**
 * Whether a `relative(base, target)` result points outside `base`: it walks up
 * (`..`), or it is absolute (`relative` returns the target verbatim when the
 * two paths share no root). Used wherever a computed path gates a filesystem
 * operation that must stay inside a sandbox directory (worktree cwds, artifact
 * snapshot destinations).
 */
export function isOutside(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || resolve(rel) === rel;
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
