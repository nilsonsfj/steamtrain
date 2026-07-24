import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeRepoKey, withLandLock } from "../src/workflow/land-lock";

async function scratchDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "steamtrain-land-lock-"));
}

const fixedKey = async (): Promise<string> => "test-repo-key";

/** Reproduces withLandLock's lock-file naming for a given resolved key. */
function lockFileFor(dir: string, key: string): string {
  return join(dir, `land-${createHash("sha256").update(key).digest("hex").slice(0, 16)}.lock`);
}

describe("normalizeRepoKey", () => {
  it("maps ssh/scp and https origins of the same repo to one key", () => {
    const scp = normalizeRepoKey("git@github.com:Owner/Repo.git");
    const https = normalizeRepoKey("https://github.com/owner/repo");
    const trailing = normalizeRepoKey("https://github.com/owner/repo.git/");
    expect(scp).toBe("github.com/owner/repo");
    expect(https).toBe("github.com/owner/repo");
    expect(trailing).toBe("github.com/owner/repo");
  });
});

describe("withLandLock", () => {
  it("serializes two concurrent holders (no overlap in the critical section)", async () => {
    const lockDir = await scratchDir();
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];

    const enter = async (tag: string): Promise<void> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`enter:${tag}`);
      await new Promise((r) => setTimeout(r, 25));
      order.push(`exit:${tag}`);
      active -= 1;
    };

    const opts = { lockDir, resolveKey: fixedKey, pollMs: 3, maxWaitMs: 5_000 } as const;
    const [a, b] = await Promise.all([
      withLandLock("/repo", () => enter("a").then(() => "a"), opts),
      withLandLock("/repo", () => enter("b").then(() => "b"), opts),
    ]);

    expect(a.locked).toBe(true);
    expect(b.locked).toBe(true);
    // The two critical sections never ran at the same time.
    expect(maxActive).toBe(1);
    // Interleaving must be a clean enter/exit pair per holder.
    expect(order).toEqual(
      order[0] === "enter:a"
        ? ["enter:a", "exit:a", "enter:b", "exit:b"]
        : ["enter:b", "exit:b", "enter:a", "exit:a"],
    );
  });

  it("releases the lock so a subsequent acquisition succeeds and leaves no file", async () => {
    const lockDir = await scratchDir();
    const opts = { lockDir, resolveKey: fixedKey } as const;
    const first = await withLandLock("/repo", async () => "one", opts);
    const second = await withLandLock("/repo", async () => "two", opts);
    expect([first.value, second.value]).toEqual(["one", "two"]);
    expect(first.locked && second.locked).toBe(true);
  });

  it("steals an abandoned lock whose holder process is gone", async () => {
    const lockDir = await scratchDir();
    const lockPath = lockFileFor(lockDir, "test-repo-key");
    // A dead holder on this host: an impossible-to-be-alive pid.
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 2_147_483_647, host: hostname(), createdAtMs: 0 }),
    );

    const result = await withLandLock("/repo", async () => "stolen", {
      lockDir,
      resolveKey: fixedKey,
      pollMs: 3,
      maxWaitMs: 2_000,
    });
    expect(result).toMatchObject({ value: "stolen", locked: true });
  });

  it("is best-effort: gives up and runs anyway when a live holder never releases", async () => {
    const lockDir = await scratchDir();
    const lockPath = lockFileFor(lockDir, "test-repo-key");
    // A live holder (our own pid) with a fresh mtime — not stealable.
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, host: hostname(), createdAtMs: Date.now() }),
    );

    let noticed = false;
    const result = await withLandLock("/repo", async () => "unlocked-run", {
      lockDir,
      resolveKey: fixedKey,
      pollMs: 5,
      maxWaitMs: 40,
      onWait: () => {
        noticed = true;
      },
    });
    expect(result).toMatchObject({ value: "unlocked-run", locked: false });
    expect(noticed).toBe(true);
    // The live holder's lock file must be left intact (we never owned it).
    await expect(stat(lockPath)).resolves.toBeTruthy();
    const held = JSON.parse(await readFile(lockPath, "utf8"));
    expect(held.pid).toBe(process.pid);
  });
});
