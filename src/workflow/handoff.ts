import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { sanitizePathComponent } from "./fs-util";
import type { LiveRunPublisher } from "./live-run";
import type { LiveRunLaunch, LiveRunStore } from "./live-run-store";

/**
 * Turning an in-process run into a background one. Both the `--detach` launch
 * (a brand-new run) and mid-run detach (handing off a run that started in the
 * TUI or web UI) end up re-execing this same CLI as a detached child that
 * re-owns the run via `workflow _detached-runner <runId>`. The two paths share
 * {@link spawnDetachedRunner} so the child-process plumbing — log capture,
 * flag passthrough, spawn-error handling — lives in exactly one place.
 */

/** Where to point the detached child at the same project/config the parent used. */
export interface DetachedRunnerIo {
  /** `--project-dir`: the project directory (state, cache, history, runs live here). */
  projectDir?: string;
  /** `--config-file`: a custom `steamtrain.json` the parent was started with. */
  configPath?: string;
  /** `--workspace`: a custom `workspace.json` the parent was started with. */
  workspacePath?: string;
}

export interface SpawnDetachedRunnerOptions extends DetachedRunnerIo {
  store: LiveRunStore;
  /** The already-registered run the child takes ownership of. */
  runId: string;
  /** Working directory for the child (the resolved project dir). */
  cwd: string;
}

export type SpawnDetachedRunnerResult = { ok: true; pid: number } | { ok: false; error: string };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Re-exec this CLI as a detached background child that re-owns `runId` through
 * the hidden `workflow _detached-runner` entry point. The child's stdout/stderr
 * land in the run dir's `runner.log`; it is `unref`'d so the parent can exit (or
 * the UI can close) without waiting on it. Resolves once the OS confirms the
 * spawn (or reports why it failed) so a bad exec never leaves a zombie entry.
 *
 * The run must already be registered in `store` (the caller creates or rewrites
 * its meta first) — this only launches the process.
 */
export async function spawnDetachedRunner(
  options: SpawnDetachedRunnerOptions,
): Promise<SpawnDetachedRunnerResult> {
  const script = process.argv[1];
  if (!script) {
    return { ok: false, error: "the steamtrain entry script could not be determined" };
  }

  let logFd: number;
  try {
    logFd = openSync(
      join(options.store.rootDir, sanitizePathComponent(options.runId), "runner.log"),
      "a",
    );
  } catch (err) {
    return { ok: false, error: `could not open the runner log: ${message(err)}` };
  }

  const childArgs = [
    script,
    ...(options.projectDir ? ["--project-dir", options.projectDir] : []),
    ...(options.configPath ? ["--config-file", options.configPath] : []),
    ...(options.workspacePath ? ["--workspace", options.workspacePath] : []),
    "workflow",
    "_detached-runner",
    options.runId,
  ];
  const child = spawn(process.execPath, childArgs, {
    cwd: options.cwd,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } catch (spawnErr) {
    closeSync(logFd);
    return { ok: false, error: message(spawnErr) };
  }
  // The child holds its own copy of the log fd; release the parent's.
  closeSync(logFd);
  return { ok: true, pid: child.pid ?? -1 };
}

export interface HandoffRunOptions extends DetachedRunnerIo {
  store: LiveRunStore;
  /** The in-flight run to hand off (its meta already exists in `store`). */
  runId: string;
  cwd: string;
  /** Launch args the detached runner replays the remaining steps from. */
  launch: LiveRunLaunch;
}

/**
 * Hand an already-running, in-process run off to a fresh detached background
 * process **under the same run id**, so the launching UI can close without
 * stopping the workflow. The caller MUST have committed the ownership transfer,
 * aborted the local engine, and waited for its event loop to unwind before
 * calling this function. Completed steps are already on disk in the step cache;
 * an interrupted step has no cache entry and the detached runner replays it.
 *
 * Rewrites the run's meta to look like a freshly-queued `cli-detached` run
 * (clearing the old owner's pid, pause, and pending human checkpoints, and
 * stamping the `launch` block), then spawns the runner. On a spawn failure the
 * meta is settled as errored so the run never lingers as a phantom "queued"
 * entry that the orphan sweep would later have to reap.
 */
export async function handoffRunToDetached(
  options: HandoffRunOptions,
): Promise<SpawnDetachedRunnerResult> {
  const { store, runId } = options;
  // Re-arm the registry entry for a detached owner: back to the queue (so the
  // child acquires a run slot cleanly), owner-less until the child reports its
  // pid, and stripped of the previous owner's transient state.
  await store.update(runId, {
    source: "cli-detached",
    detached: true,
    status: "queued",
    pid: -1,
    paused: false,
    pendingApprovals: [],
    pendingInputs: [],
    // Re-timed when the child leaves the queue; createdAt is preserved so the
    // run keeps its place in the cross-process queue ordering.
    startedAt: undefined,
    launch: options.launch,
  });

  const result = await spawnDetachedRunner({
    store,
    runId,
    cwd: options.cwd,
    projectDir: options.projectDir,
    configPath: options.configPath,
    workspacePath: options.workspacePath,
  });

  if (!result.ok) {
    await store
      .update(runId, {
        status: "error",
        ok: false,
        error: `could not detach the run: ${result.error}`,
        endedAt: Date.now(),
      })
      .catch(() => {});
  }
  return result;
}

export interface CompleteQuiescedHandoffOptions extends HandoffRunOptions {
  /**
   * The live-run publisher mirroring this run's event stream, if any. Only its
   * `event`/`flush` methods are used — the terminal `finish` is deliberately
   * skipped because the detached child owns the run's record from here on.
   */
  publisher?: Pick<LiveRunPublisher, "event" | "flush">;
}

/**
 * Finish a committed mid-run detach after the local engine has been aborted.
 * Both the TUI (`useWorkflowRunner`) and web (`WorkflowRunManager`) paths funnel
 * through here so the "land the stream, hand off" sequence lives in one place
 * and can't drift between the two surfaces. The historical function name is
 * retained for API compatibility; callers now abort immediately rather than
 * pausing to quiesce.
 *
 * Flush every buffered event to disk so the child appends after them, then hand
 * the run off under the same id.
 */
export async function completeQuiescedHandoff(
  options: CompleteQuiescedHandoffOptions,
): Promise<SpawnDetachedRunnerResult> {
  const { publisher, ...handoff } = options;
  await publisher?.flush().catch(() => {});
  return handoffRunToDetached(handoff);
}
