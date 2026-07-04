import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { isOutside } from "./fs-util";
import { type StepArtifact, artifactName } from "./types";

/**
 * Declared-artifact snapshots. A step lists output paths (`"artifacts":
 * ["report.md", "coverage/"]`); after it succeeds, each is copied out of its
 * (ephemeral, prunable) workspace into a per-run artifact directory so the
 * paths recorded in run history — and handed to later steps via
 * `{{steps.<id>.artifacts.<name>}}` — stay valid independent of worktree
 * lifecycle. Kept separate from the engine so the filesystem mechanics are
 * testable on their own.
 */

export interface CollectArtifactsOptions {
  /** Declared artifact paths, relative to `stepCwd` (validated by the spec). */
  declared: string[];
  /** The directory the step actually ran in (its workspace cwd). */
  stepCwd: string;
  /** Per-run artifact directory; snapshots land under `<dir>/<step>/<name>`. */
  artifactsDir: string;
  stepId: string;
  signal?: AbortSignal;
}

export interface CollectArtifactsResult {
  artifacts: StepArtifact[];
  /** Declared paths the step did not produce. */
  missing: string[];
}

/**
 * Snapshot every declared artifact that exists; report the ones that don't.
 * Copies are symlink-preserving (`dereference: false`) so a linked runtime
 * entry never balloons the snapshot. Re-collection for the same step (a loop
 * iteration re-running) replaces the previous snapshot, matching the
 * latest-result-wins semantics of step outputs.
 */
export async function collectArtifacts(
  opts: CollectArtifactsOptions,
): Promise<CollectArtifactsResult> {
  const artifacts: StepArtifact[] = [];
  const missing: string[] = [];
  const stepDir = join(opts.artifactsDir, artifactStepDirName(opts.stepId));

  for (const source of opts.declared) {
    throwIfAborted(opts.signal);
    const sourcePath = resolve(opts.stepCwd, source);
    // The spec validator already rejects escaping paths; re-check here so a
    // manager returning an unexpected cwd can never snapshot foreign files.
    if (isOutside(relative(resolve(opts.stepCwd), sourcePath))) {
      missing.push(source);
      continue;
    }
    const exists = await lstat(sourcePath).then(
      () => true,
      () => false,
    );
    if (!exists) {
      missing.push(source);
      continue;
    }
    const name = artifactName(source);
    const dest = join(stepDir, name);
    // The spec validator rejects names that resolve outside the step's own
    // snapshot directory, but `rm`/`cp` below are destructive against a
    // directory SHARED by every step of the run — never trust the name alone.
    if (dest === stepDir || isOutside(relative(stepDir, dest))) {
      throw new Error(`artifact '${source}' resolves outside the step's snapshot directory`);
    }
    await rm(dest, { recursive: true, force: true });
    await mkdir(dirname(dest), { recursive: true });
    await cp(sourcePath, dest, { recursive: true });
    const { bytes, files } = await measure(dest);
    artifacts.push({ name, source, path: dest, bytes, files });
  }

  return { artifacts, missing };
}

/** Total bytes and file count under a snapshot path (symlinks count as 0-byte files). */
async function measure(path: string): Promise<{ bytes: number; files: number }> {
  const st = await lstat(path);
  if (st.isDirectory()) {
    let bytes = 0;
    let files = 0;
    for (const entry of await readdir(path)) {
      const sub = await measure(join(path, entry));
      bytes += sub.bytes;
      files += sub.files;
    }
    return { bytes, files };
  }
  return { bytes: st.isFile() ? st.size : 0, files: 1 };
}

/**
 * Directory name for one step's artifacts. Step ids are free-form, so sanitize
 * for the filesystem; when sanitizing changed the id (so two distinct ids could
 * collide), a short hash of the raw id keeps the directories distinct.
 */
function artifactStepDirName(stepId: string): string {
  const sanitized = stepId.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (sanitized === stepId) return sanitized;
  return `${sanitized}-${createHash("sha1").update(stepId).digest("hex").slice(0, 8)}`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("cancelled");
}
