import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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
