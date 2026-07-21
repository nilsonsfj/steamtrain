import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLiveRunStore, handoffRunToDetached, newLiveRunMeta } from "../src/workflow";

/**
 * The mid-run handoff helper: it re-arms an in-process run's registry entry for
 * a detached owner (source `cli-detached`, back to `queued`, owner-less, with a
 * `launch` block) and re-execs the CLI as a background child. Here the child is
 * a no-op script (we exercise the meta rewrite + spawn plumbing, not the real
 * `_detached-runner`).
 */

let root: string;
let savedArgv1: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "steamtrain-handoff-"));
  savedArgv1 = process.argv[1];
});

afterEach(() => {
  process.argv[1] = savedArgv1 as string;
  rmSync(root, { recursive: true, force: true });
});

describe("handoffRunToDetached", () => {
  it("re-arms the run as a queued cli-detached owner and spawns the child", async () => {
    const store = createLiveRunStore(join(root, "runs"));
    const runId = "run-1";
    // A run currently owned by this (TUI-like) process, mid-flight.
    await store.create(
      newLiveRunMeta({
        id: runId,
        workflow: "bug-hunt",
        input: "audit the parser",
        params: { depth: 2 },
        cwd: root,
        source: "tui",
      }),
    );
    await store.update(runId, { status: "running", pid: process.pid, startedAt: Date.now() });

    // A no-op child: the handoff only needs the spawn to succeed.
    const noop = join(root, "noop.mjs");
    writeFileSync(noop, "process.exit(0)\n");
    process.argv[1] = noop;

    const result = await handoffRunToDetached({
      store,
      runId,
      cwd: root,
      projectDir: root,
      launch: {
        workflow: "bug-hunt",
        input: "audit the parser",
        params: { depth: 2 },
        fresh: false,
      },
    });

    expect(result.ok).toBe(true);

    const meta = await store.get(runId);
    expect(meta).toMatchObject({
      source: "cli-detached",
      detached: true,
      status: "queued",
      pid: -1,
      paused: false,
    });
    // Queue ordering is preserved; the previous owner's start time is cleared.
    expect(meta?.startedAt).toBeUndefined();
    expect(meta?.launch).toMatchObject({
      workflow: "bug-hunt",
      input: "audit the parser",
      params: { depth: 2 },
      fresh: false,
    });
  });

  it("settles the run as errored when the child cannot be spawned", async () => {
    const store = createLiveRunStore(join(root, "runs"));
    const runId = "run-2";
    await store.create(
      newLiveRunMeta({ id: runId, workflow: "w", input: "i", cwd: root, source: "web" }),
    );
    await store.update(runId, { status: "running", pid: process.pid });

    // No entry script ⇒ the spawn helper cannot build a command line.
    process.argv[1] = "";

    const result = await handoffRunToDetached({
      store,
      runId,
      cwd: root,
      projectDir: root,
      launch: { workflow: "w", input: "i", fresh: false },
    });

    expect(result.ok).toBe(false);
    const meta = await store.get(runId);
    expect(meta?.status).toBe("error");
    expect(meta?.ok).toBe(false);
    expect(String(meta?.error)).toMatch(/could not detach/);
  });
});
