import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withFileLock } from "../src/workflow/file-lock";

const hooks = vi.hoisted(() => ({
  unlink: undefined as ((path: string) => Promise<void>) | undefined,
  link: undefined as ((source: string, destination: string) => Promise<void>) | undefined,
  fastSleep: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    unlink: async (path: string) => {
      await hooks.unlink?.(path);
      return fs.unlink(path);
    },
    link: async (source: string, destination: string) => {
      await hooks.link?.(source, destination);
      return fs.link(source, destination);
    },
  };
});

vi.mock("../src/workflow/timeout", async (importOriginal) => {
  const timeout = await importOriginal<typeof import("../src/workflow/timeout")>();
  return {
    ...timeout,
    abortableSleep: (ms: number, signal?: AbortSignal) =>
      hooks.fastSleep ? Promise.resolve() : timeout.abortableSleep(ms, signal),
  };
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const deadPayload = JSON.stringify({ pid: 2 ** 30, host: hostname(), createdAtMs: 0 });
const livePayload = JSON.stringify({ pid: process.pid, host: hostname(), createdAtMs: 0 });
const dirs: string[] = [];

async function scratchLock(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "steamtrain-lock-recovery-"));
  dirs.push(dir);
  return join(dir, "state.lock");
}

afterEach(async () => {
  hooks.unlink = undefined;
  hooks.link = undefined;
  hooks.fastSleep = false;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("file lock recovery invariants", () => {
  it("does not revoke a live coordinator paused before deleting a stale lock", async () => {
    const lock = await scratchLock();
    await writeFile(lock, deadPayload);
    const entered = gate();
    const resume = gate();
    let paused = false;
    hooks.unlink = async (path) => {
      if (path === lock && !paused) {
        paused = true;
        entered.release();
        await resume.promise;
      }
    };
    const a = withFileLock(lock, async () => "a", { pollMs: 1, maxWaitMs: 1000 });
    await entered.promise;
    const coordinator = await readFile(`${lock}.steal`, "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(`${lock}.steal`, old, old);
    try {
      const callback = vi.fn(async () => "b");
      await expect(withFileLock(lock, callback, { pollMs: 1, maxWaitMs: 40 })).rejects.toThrow(
        /still held/,
      );
      expect(callback).not.toHaveBeenCalled();
      expect(await readFile(`${lock}.steal`, "utf8")).toBe(coordinator);
    } finally {
      resume.release();
      await a;
    }
    await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a live main lock exclusive even with a deliberately expired heartbeat", async () => {
    const lock = await scratchLock();
    const entered = gate();
    const resume = gate();
    const a = withFileLock(lock, async () => {
      entered.release();
      await resume.promise;
    });
    await entered.promise;
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    try {
      await expect(
        withFileLock(lock, async () => "b", { staleMs: 1, pollMs: 1, maxWaitMs: 40 }),
      ).rejects.toThrow(/still held/);
    } finally {
      resume.release();
      await a;
    }
  });

  it("succeeds a dead recovery claimant without deleting either claim generation", async () => {
    const lock = await scratchLock();
    const steal = `${lock}.steal`;
    await writeFile(steal, deadPayload);
    const info = await stat(steal);
    const identity = createHash("sha256")
      .update(`${info.dev}:${info.ino}:${deadPayload}`)
      .digest("hex");
    const firstClaim = `${steal}.claim.${identity}.0`;
    const nextClaim = `${steal}.claim.${identity}.1`;
    await writeFile(firstClaim, deadPayload);
    const entered = gate();
    const resume = gate();
    let paused = false;
    hooks.unlink = async (path) => {
      if (path === steal && !paused) {
        paused = true;
        entered.release();
        await resume.promise;
      }
    };
    const a = withFileLock(lock, async () => "a", { pollMs: 1, maxWaitMs: 1000 });
    await entered.promise;
    const nextPayload = await readFile(nextClaim, "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(nextClaim, old, old);
    try {
      await expect(
        withFileLock(lock, async () => "b", { pollMs: 1, maxWaitMs: 40 }),
      ).rejects.toThrow(/still held/);
      expect(await readFile(firstClaim, "utf8")).toBe(deadPayload);
      expect(await readFile(nextClaim, "utf8")).toBe(nextPayload);
    } finally {
      resume.release();
      await a;
    }
    expect(await readFile(firstClaim, "utf8")).toBe(deadPayload);
    expect(await readFile(nextClaim, "utf8")).toBe(nextPayload);
    expect((await withFileLock(lock, async () => "b")).value).toBe("b");
  });

  it("waits past the former release retry limit without deleting outside the coordinator", async () => {
    const lock = await scratchLock();
    const steal = `${lock}.steal`;
    let releasing = false;
    let attempts = 0;
    let expectedPayload = "";
    hooks.fastSleep = true;
    hooks.link = async (_source, destination) => {
      if (destination !== steal || !releasing) return;
      attempts++;
      if (attempts === 2200) {
        expect(await readFile(lock, "utf8")).toBe(expectedPayload);
        const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
        await real.unlink(steal);
      }
    };
    await withFileLock(lock, async () => {
      expectedPayload = await readFile(lock, "utf8");
      await writeFile(steal, livePayload);
      releasing = true;
    });
    expect(attempts).toBe(2200);
    await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(steal)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the callback's error as the cause when releasing the lock also fails", async () => {
    const lock = await scratchLock();
    const original = new Error("callback failed");
    const failure = await withFileLock(lock, async () => {
      // Someone else removes the lock mid-flight, so the release finds no owner.
      await rm(lock, { force: true });
      throw original;
    }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/lock ownership lost/);
    expect((failure as Error).cause).toBe(original);
  });

  it.each(["", "{", '{"pid":0,"host":"bad"}'])(
    "fails closed on an unverifiable coordinator %j",
    async (payload) => {
      const lock = await scratchLock();
      await writeFile(`${lock}.steal`, payload);
      const old = new Date(Date.now() - 60_000);
      await utimes(`${lock}.steal`, old, old);
      const callback = vi.fn(async () => "unsafe");
      await expect(withFileLock(lock, callback, { maxWaitMs: 20 })).rejects.toThrow(/still held/);
      expect(callback).not.toHaveBeenCalled();
      expect(await readFile(`${lock}.steal`, "utf8")).toBe(payload);
    },
  );
});
