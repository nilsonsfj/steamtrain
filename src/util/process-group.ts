import { readFileSync, readdirSync } from "node:fs";

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
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
  // A zombie still answers `kill(-pgid, 0)`. Where nothing reaps the orphans
  // (steamtrain as PID 1 in a container) the group would look alive until the
  // deadline, so Linux asks /proc whether anyone in it is actually running.
  if (process.platform === "linux" && !recentlySawLiveMember(pgid)) {
    if (groupHasLiveMember(pgid) === false) return false;
    lastLiveScan = { pgid, at: Date.now() };
  }
  return true;
}

/**
 * `waitForProcessGroupExit` polls every 20ms, and a /proc scan reads a file per
 * process on the host. So a scan that found the group alive is trusted for a
 * moment. The cost is a zombie-only group reported alive up to that long late;
 * the next poll after it expires looks again.
 */
const LIVE_SCAN_TTL_MS = 100;
let lastLiveScan: { pgid: number; at: number } | undefined;

function recentlySawLiveMember(pgid: number): boolean {
  return lastLiveScan?.pgid === pgid && Date.now() - lastLiveScan.at < LIVE_SCAN_TTL_MS;
}

/**
 * Whether any member of process group `pgid` is not a zombie, read from
 * `procRoot` (`/proc`). `undefined` when that cannot be told: the directory is
 * unreadable, or no member of the group shows up in it at all (a /proc from
 * another PID namespace, `hidepid`), where the caller must not assume the group
 * is gone.
 */
export function groupHasLiveMember(pgid: number, procRoot = "/proc"): boolean | undefined {
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return undefined;
  }
  let seen = false;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let stat: ReturnType<typeof parseProcStat>;
    try {
      stat = parseProcStat(readFileSync(`${procRoot}/${entry}/stat`, "utf8"));
    } catch {
      continue; // exited between the listing and the read
    }
    if (stat?.pgrp !== pgid) continue;
    seen = true;
    // A zombie leader can still have running threads (its main thread called
    // pthread_exit); the group is not empty while they run.
    if ((stat.state !== "Z" && stat.state !== "X") || stat.threads > 1) return true;
  }
  return seen ? false : undefined;
}

/**
 * The state, process group and thread count out of a `/proc/<pid>/stat` line,
 * which reads `pid (comm) state ppid pgrp session tty_nr tpgid flags minflt
 * cminflt majflt cmajflt utime stime cutime cstime priority nice num_threads …`.
 * The command name may hold spaces and parentheses, so the fields are counted
 * from the last `)`.
 */
export function parseProcStat(
  text: string,
): { state: string; pgrp: number; threads: number } | undefined {
  const end = text.lastIndexOf(")");
  if (end < 0) return undefined;
  const fields = text
    .slice(end + 1)
    .trim()
    .split(/\s+/);
  const state = fields[0];
  const pgrp = Number(fields[2]);
  // A line cut short of num_threads still gives a state and group; count one thread.
  const threads = fields[17] === undefined ? 1 : Number(fields[17]);
  if (!state || !Number.isInteger(pgrp) || !Number.isInteger(threads)) return undefined;
  return { state, pgrp, threads };
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
