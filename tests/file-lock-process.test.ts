import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { withFileLock } from "../src/workflow/file-lock";

const dirs: string[] = [];
const children: ChildProcess[] = [];
const moduleUrl = pathToFileURL(resolve("src/workflow/file-lock.ts")).href;

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "steamtrain-lock-process-"));
  dirs.push(dir);
  return dir;
}

function child(source: string): { process: ChildProcess; done: Promise<void> } {
  const proc = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.push(proc);
  let error = "";
  proc.stderr!.on("data", (data) => {
    error += data.toString();
  });
  const done = new Promise<void>((resolveDone, reject) => {
    proc.once("error", reject);
    proc.once("exit", (code, signal) => {
      if (code === 0 || signal === "SIGKILL") resolveDone();
      else reject(new Error(`lock subprocess exited ${code}: ${error}`));
    });
  });
  return { process: proc, done };
}

afterEach(async () => {
  for (const proc of children.splice(0)) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  }
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("file locks across real processes", () => {
  it("serializes repeated acquisitions from four independent processes", async () => {
    const dir = await scratch();
    const lock = join(dir, "state.lock");
    const log = join(dir, "events.jsonl");
    await writeFile(log, "");
    const runs = Array.from({ length: 4 }, (_, worker) =>
      child(`
      import { withFileLock } from ${JSON.stringify(moduleUrl)};
      import { appendFile } from "node:fs/promises";
      for (let iteration = 0; iteration < 4; iteration++) {
        await withFileLock(${JSON.stringify(lock)}, async () => {
          await appendFile(${JSON.stringify(log)}, JSON.stringify({worker:${worker},enter:true}) + "\\n");
          await new Promise(resolve => setTimeout(resolve, 10));
          await appendFile(${JSON.stringify(log)}, JSON.stringify({worker:${worker},enter:false}) + "\\n");
        }, {pollMs:2, maxWaitMs:10000});
      }
    `),
    );
    await Promise.all(runs.map((run) => run.done));
    const events = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toHaveLength(32);
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i].enter).toBe(true);
      expect(events[i + 1]).toEqual({ worker: events[i].worker, enter: false });
    }
    await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a published main lock after its actual owner is killed", async () => {
    const dir = await scratch();
    const lock = join(dir, "state.lock");
    const run = child(`
      import { withFileLock } from ${JSON.stringify(moduleUrl)};
      await withFileLock(${JSON.stringify(lock)}, async () => {
        process.stdout.write("ready\\n");
        await new Promise(() => { setInterval(() => {}, 1000); });
      });
    `);
    await Promise.race([
      new Promise<void>((ready) => run.process.stdout!.once("data", () => ready())),
      run.done.then(() => {
        throw new Error("owner exited before acquisition");
      }),
    ]);
    run.process.kill("SIGKILL");
    await run.done;
    const previous = JSON.parse(await readFile(lock, "utf8"));
    let current: { pid: number; token: string } | undefined;
    await withFileLock(
      lock,
      async () => {
        current = JSON.parse(await readFile(lock, "utf8"));
      },
      { pollMs: 2, maxWaitMs: 1000 },
    );
    expect(current).toMatchObject({ pid: process.pid });
    expect(current?.token).not.toBe(previous.token);
    await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
