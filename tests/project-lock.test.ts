import { mkdtemp, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkflowCacheStore,
  persistWorkflowStepDone,
  setWorkflowCacheLock,
  workflowCacheKey,
} from "../src/workflow/cache-store";
import { withFileLock } from "../src/workflow/file-lock";
import {
  projectRootFromStatePath,
  steamtrainDirFromStatePath,
  withProjectStateLock,
  withStateDirLock,
} from "../src/workflow/project-lock";
import { migrateStateVersion } from "../src/workflow/state-migrate";
import type { StepResult } from "../src/workflow/types";

async function scratchDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "steamtrain-project-lock-"));
}

function sampleResult(stepId: string): StepResult {
  return { stepId, ok: true, output: stepId, durationMs: 1 };
}

describe("project state lock", () => {
  afterEach(() => {
    setWorkflowCacheLock(undefined);
  });

  it("serializes two concurrent critical sections", async () => {
    const project = await scratchDir();
    let active = 0;
    let maxActive = 0;
    const opts = { pollMs: 5, maxWaitMs: 5_000 } as const;
    const run = async (tag: string): Promise<string> => {
      return withProjectStateLock(
        project,
        async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 25));
          active -= 1;
          return tag;
        },
        opts,
      );
    };
    const [a, b] = await Promise.all([run("a"), run("b")]);
    expect([a, b].sort()).toEqual(["a", "b"]);
    expect(maxActive).toBe(1);
  });

  it("throws when required lock cannot be acquired", async () => {
    const lockDir = await scratchDir();
    const project = await scratchDir();
    // Hold the lock with a live pid so it cannot be stolen.
    const held = withProjectStateLock(
      project,
      async () => {
        await new Promise((r) => setTimeout(r, 200));
        return "holder";
      },
      { lockDir, maxWaitMs: 5_000, pollMs: 5 },
    );
    await new Promise((r) => setTimeout(r, 20));
    await expect(
      withProjectStateLock(project, async () => "waiter", {
        lockDir,
        maxWaitMs: 40,
        pollMs: 5,
      }),
    ).rejects.toThrow(/project state lock still held/);
    await held;
  });

  it("maps store paths under .steamtrain to the project root", async () => {
    const { resolve } = await import("node:path");
    const project = resolve("/repo/project");
    expect(steamtrainDirFromStatePath(join(project, ".steamtrain", "cache"))).toBe(
      join(project, ".steamtrain"),
    );
    expect(projectRootFromStatePath(join(project, ".steamtrain", "runs"))).toBe(project);
  });

  it("steals an abandoned same-host lock", async () => {
    const lockDir = await scratchDir();
    const project = await scratchDir();
    // Acquire once so the hashed lock path exists, then plant a dead holder.
    let lockPath = "";
    await withProjectStateLock(
      project,
      async () => {
        const { readdir } = await import("node:fs/promises");
        const names = await readdir(lockDir);
        lockPath = join(lockDir, names[0]!);
      },
      { lockDir },
    );
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 2_147_483_647, host: hostname(), createdAtMs: 0 }),
    );
    const result = await withProjectStateLock(project, async () => "ok", {
      lockDir,
      pollMs: 3,
      maxWaitMs: 2_000,
    });
    expect(result).toBe("ok");
  });
  it("withStateDirLock shares the project lock for production store paths", async () => {
    const project = await scratchDir();
    const cacheDir = join(project, ".steamtrain", "cache");
    let active = 0;
    let maxActive = 0;
    const bump = async (): Promise<void> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active -= 1;
    };
    await Promise.all([
      withProjectStateLock(project, bump, { pollMs: 5 }),
      withStateDirLock(cacheDir, bump, { pollMs: 5 }),
    ]);
    expect(maxActive).toBe(1);
  });
});

describe("cache merge under lock", () => {
  afterEach(() => {
    setWorkflowCacheLock(undefined);
  });

  it("keeps completions from overlapping saves instead of last-writer-wins", async () => {
    const root = await scratchDir();
    // Fast poll so the second writer doesn't sit on the default 750ms interval.
    setWorkflowCacheLock((stateSubdir, fn, opts) =>
      withStateDirLock(stateSubdir, fn, { ...opts, pollMs: 5 }),
    );
    const store = createWorkflowCacheStore(root);
    const key = workflowCacheKey("wf", "in", root, { name: "wf", phases: [] });

    // Simulate two writers that each only know about their own step.
    const saveA = store.save(key, new Map([["a", sampleResult("a")]]));
    const saveB = store.save(key, new Map([["b", sampleResult("b")]]));
    await Promise.all([saveA, saveB]);

    const loaded = await store.load(key);
    expect([...loaded.keys()].sort()).toEqual(["a", "b"]);
  });

  it("persistWorkflowStepDone merges under the lock", async () => {
    const root = await scratchDir();
    setWorkflowCacheLock((stateSubdir, fn, opts) =>
      withStateDirLock(stateSubdir, fn, { ...opts, pollMs: 5 }),
    );
    const store = createWorkflowCacheStore(root);
    const key = workflowCacheKey("wf", "in", root, { name: "wf", phases: [] });
    const cacheA = new Map<string, StepResult>();
    const cacheB = new Map<string, StepResult>();
    await Promise.all([
      persistWorkflowStepDone(store, key, cacheA, "a", sampleResult("a"), false),
      persistWorkflowStepDone(store, key, cacheB, "b", sampleResult("b"), false),
    ]);
    const loaded = await store.load(key);
    expect([...loaded.keys()].sort()).toEqual(["a", "b"]);
  });
});

describe("migrateStateVersion", () => {
  it("applies chained migrators up to the current version", () => {
    const result = migrateStateVersion<{ version: number; name: string }>(
      { version: 1, name: "old" },
      3,
      {
        1: (v) => ({ ...v, version: 2, name: `${v.name}-v2` }),
        2: (v) => ({ ...v, version: 3, name: `${v.name}-v3` }),
      },
    );
    expect(result).toEqual({ ok: true, value: { version: 3, name: "old-v2-v3" } });
  });

  it("rejects future and unmigratable versions", () => {
    expect(migrateStateVersion({ version: 9 }, 2, {}).ok).toBe(false);
    expect(migrateStateVersion({ version: 0 }, 2, {}).ok).toBe(false);
  });

  it("passes through current-version payloads", () => {
    expect(migrateStateVersion({ version: 2, x: 1 }, 2, {})).toEqual({
      ok: true,
      value: { version: 2, x: 1 },
    });
  });
});

describe("withFileLock bestEffort", () => {
  it("runs unlocked when bestEffort and the holder never releases", async () => {
    const dir = await scratchDir();
    const lockPath = join(dir, "x.lock");
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, host: hostname(), createdAtMs: Date.now() }),
    );
    const outcome = await withFileLock(lockPath, async (locked) => locked, {
      bestEffort: true,
      maxWaitMs: 30,
      pollMs: 5,
      label: "test lock",
    });
    expect(outcome).toEqual({ value: false, locked: false });
  });
});
