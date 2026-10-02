/**
 * Unix process-group helpers for command steps and agent CLIs. Spawn those
 * children `detached` so SIGTERM/SIGKILL on `-pgid` reaches forks, then wait
 * until `kill(-pgid, 0)` fails before releasing a worktree.
 */

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True when any member of the detached group is still running. */
export function isProcessGroupAlive(pgid: number | undefined): boolean {
  if (process.platform === "win32" || typeof pgid !== "number" || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function killProcessGroup(
  pgid: number | undefined,
  child: { kill: (signal?: NodeJS.Signals) => boolean },
  sig: NodeJS.Signals,
): void {
  try {
    if (process.platform !== "win32" && typeof pgid === "number") {
      try {
        process.kill(-pgid, sig);
        return;
      } catch {
        // Not a group leader / already gone — fall through to the handle.
      }
    }
    child.kill(sig);
  } catch {
    // already gone
  }
}

function childHandleAlive(child: {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}): boolean {
  if (child.exitCode !== null || child.signalCode !== null) return false;
  return typeof child.pid === "number" && isPidAlive(child.pid);
}

export function isSpawnTreeAlive(
  pgid: number | undefined,
  child: {
    pid?: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  },
): boolean {
  if (process.platform !== "win32" && typeof pgid === "number") {
    return isProcessGroupAlive(pgid);
  }
  return childHandleAlive(child);
}

/**
 * Block until the process group (or, on Windows, the child handle) is gone,
 * then SIGKILL once more if the deadline passed with anyone still standing.
 */
export async function waitForProcessGroupExit(
  pgid: number | undefined,
  child: {
    pid?: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: (signal?: NodeJS.Signals) => boolean;
  },
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (!isSpawnTreeAlive(pgid, child)) return;
    await sleep(20);
  }
  killProcessGroup(pgid, child, "SIGKILL");
  const extra = Date.now() + 500;
  while (Date.now() < extra) {
    if (!isSpawnTreeAlive(pgid, child)) return;
    await sleep(20);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
