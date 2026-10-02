import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { groupHasLiveMember, isProcessGroupAlive, parseProcStat } from "../src/util/process-group";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A stand-in /proc with one `stat` line per `[pid, comm, state, pgrp]`. */
async function fakeProc(
  procs: [pid: number, comm: string, state: string, pgrp: number, threads?: number][],
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "steamtrain-fake-proc-"));
  dirs.push(root);
  for (const [pid, comm, state, pgrp, threads = 1] of procs) {
    await mkdir(join(root, String(pid)));
    await writeFile(
      join(root, String(pid), "stat"),
      `${pid} (${comm}) ${state} 1 ${pgrp} ${pgrp} 0 -1 4194304 100 0 0 0 0 0 0 0 20 0 ${threads} 0 12345 1000 10 18446744073709551615\n`,
    );
  }
  await mkdir(join(root, "self")); // not a pid: must be skipped
  return root;
}

describe("parseProcStat", () => {
  it("reads the state and process group", () => {
    expect(parseProcStat("42 (sh) S 1 42 42 0 -1 0")).toEqual({ state: "S", pgrp: 42, threads: 1 });
    expect(parseProcStat("42 (sh) S 1 42 42 0 -1 4194304 1 0 0 0 0 0 0 0 20 0 7 0 99 1 1")).toEqual(
      { state: "S", pgrp: 42, threads: 7 },
    );
  });

  it("counts from the last parenthesis, so a command name with spaces or parens is safe", () => {
    expect(parseProcStat("42 (a b) R 1 7 7 0 -1 0")).toEqual({ state: "R", pgrp: 7, threads: 1 });
    expect(parseProcStat("42 (my (odd) cmd) Z 1 99 99 0 -1 0")).toEqual({
      state: "Z",
      pgrp: 99,
      threads: 1,
    });
  });

  it("returns undefined for a line it cannot read", () => {
    expect(parseProcStat("")).toBeUndefined();
    expect(parseProcStat("42 (sh)")).toBeUndefined();
    expect(parseProcStat("42 (sh) S 1 notanumber")).toBeUndefined();
  });
});

describe("groupHasLiveMember", () => {
  it("is false when every member of the group is a zombie", async () => {
    const root = await fakeProc([
      [100, "node", "Z", 100],
      [101, "sleep", "Z", 100],
      [200, "other", "S", 200],
    ]);
    expect(groupHasLiveMember(100, root)).toBe(false);
  });

  it("is true for a zombie leader that still has running threads", async () => {
    const root = await fakeProc([[100, "node", "Z", 100, 3]]);
    expect(groupHasLiveMember(100, root)).toBe(true);
  });

  it("is true while any member runs, whatever its state", async () => {
    for (const state of ["R", "S", "D", "T"]) {
      const root = await fakeProc([
        [100, "node", "Z", 100],
        [101, "sleep", state, 100],
      ]);
      expect(groupHasLiveMember(100, root)).toBe(true);
    }
  });

  it("cannot tell when the group does not appear in /proc, or /proc is unreadable", async () => {
    const root = await fakeProc([[200, "other", "S", 200]]);
    expect(groupHasLiveMember(100, root)).toBeUndefined();
    expect(groupHasLiveMember(100, join(root, "missing"))).toBeUndefined();
  });
});

/** Python is only a way to leave a child unreaped; absent, the test is skipped. */
const hasPython = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

describe("isProcessGroupAlive", () => {
  it.skipIf(process.platform !== "linux" || !hasPython)(
    "calls a group of only zombies gone, as under a PID 1 that never reaps",
    async () => {
      // The parent forks a child into its own group and never waits for it, so
      // the child stays a zombie: alone in a group that still answers kill(-pgid, 0).
      const parent = spawn(
        "python3",
        [
          "-c",
          "import os,time\npid=os.fork()\nif pid==0:\n os.setpgid(0,0)\n os._exit(0)\nprint(pid,flush=True)\ntime.sleep(60)",
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      try {
        const pgid = await new Promise<number>((resolve, reject) => {
          parent.stdout.once("data", (data) => resolve(Number(String(data).trim())));
          parent.once("error", reject);
        });
        expect(pgid).toBeGreaterThan(0);
        const deadline = Date.now() + 3000;
        while (isProcessGroupAlive(pgid) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(isProcessGroupAlive(pgid)).toBe(false);
      } finally {
        parent.kill("SIGKILL");
      }
    },
  );

  it("is false for a group that does not exist, and for no group", () => {
    expect(isProcessGroupAlive(2 ** 30)).toBe(false);
    expect(isProcessGroupAlive(undefined)).toBe(false);
  });

  it("is true while a member runs, and false once the group is gone", async () => {
    if (process.platform === "win32") return;
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const pgid = child.pid as number;
    try {
      expect(isProcessGroupAlive(pgid)).toBe(true);
      const exited = new Promise((resolve) => child.once("exit", resolve));
      process.kill(-pgid, "SIGKILL");
      await exited;
      expect(isProcessGroupAlive(pgid)).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  });
});
