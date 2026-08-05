import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LIVE_RUN_META_VERSION,
  type LiveRunMeta,
  createLiveRunPublisher,
  createLiveRunStore,
  createWorkflowRunControl,
  watchRunControl,
} from "../src/workflow";

const dirs: string[] = [];
function tempStoreDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "steamtrain-live-control-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function meta(id: string, over: Partial<LiveRunMeta> = {}): LiveRunMeta {
  return {
    version: LIVE_RUN_META_VERSION,
    id,
    workflow: "wf",
    input: "hi",
    cwd: "/",
    pid: process.pid,
    source: "cli",
    detached: false,
    status: "running",
    createdAt: Date.now(),
    ...over,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("live-run store: pause state + step-edit requests", () => {
  it("round-trips the desired pause state (last write wins)", async () => {
    const store = createLiveRunStore(tempStoreDir());
    await store.create(meta("r1"));

    expect(await store.readPauseState("r1")).toBeUndefined();
    expect(await store.writePauseState("r1", { paused: true, by: "human:cli" })).toBe(true);
    expect(await store.readPauseState("r1")).toEqual({ paused: true, by: "human:cli" });
    expect(await store.writePauseState("r1", { paused: false, by: "human:web" })).toBe(true);
    expect(await store.readPauseState("r1")).toEqual({ paused: false, by: "human:web" });
  });

  it("refuses pause/edit requests for unknown or terminal runs", async () => {
    const store = createLiveRunStore(tempStoreDir());
    expect(await store.writePauseState("ghost", { paused: true })).toBe(false);
    expect(await store.requestStepEdit("ghost", { stepId: "a", patch: { prompt: "x" } })).toBe(
      undefined,
    );
    await store.create(meta("done-run", { status: "done" }));
    expect(await store.writePauseState("done-run", { paused: true })).toBe(false);
  });

  it("round-trips step-edit requests and results, in request order", async () => {
    const store = createLiveRunStore(tempStoreDir());
    await store.create(meta("r1"));

    const first = await store.requestStepEdit("r1", {
      stepId: "a",
      patch: { prompt: "new prompt" },
      by: "human:cli",
    });
    const second = await store.requestStepEdit("r1", { stepId: "b", patch: { cmd: "ls" } });
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();

    const requests = await store.listStepEditRequests("r1");
    expect(requests.map((r) => r.stepId)).toEqual(["a", "b"]);
    expect(requests[0]).toMatchObject({
      editId: first,
      patch: { prompt: "new prompt" },
      by: "human:cli",
    });

    expect(await store.readStepEditResult("r1", first!)).toBeUndefined();
    await store.writeStepEditResult("r1", first!, { ok: true });
    await store.writeStepEditResult("r1", second!, { ok: false, error: "nope" });
    expect(await store.readStepEditResult("r1", first!)).toEqual({ ok: true });
    expect(await store.readStepEditResult("r1", second!)).toEqual({ ok: false, error: "nope" });
    // Result files never show up as requests.
    expect((await store.listStepEditRequests("r1")).map((r) => r.editId)).toEqual([first, second]);
  });

  it("keeps request order for edits minted in the same millisecond", async () => {
    // The ordering guarantee used to rest on Date.now() alone, so edits landing
    // in one tick were sorted by their random suffix — order came out right
    // most of the time and inverted the rest, which is the worst kind of bug to
    // have in the queue the owner replays. Freezing the clock makes the
    // collision certain rather than a 1-in-N flake.
    const store = createLiveRunStore(tempStoreDir(), { now: () => 1_700_000_000_000 });
    await store.create(meta("r1"));

    const stepIds = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const ids: string[] = [];
    for (const stepId of stepIds) {
      const editId = await store.requestStepEdit("r1", { stepId, patch: { cmd: stepId } });
      expect(editId).toBeTruthy();
      ids.push(editId!);
    }

    const requests = await store.listStepEditRequests("r1");
    expect(requests.map((r) => r.stepId)).toEqual(stepIds);
    expect(requests.map((r) => r.editId)).toEqual(ids);
  });
});

describe("watchRunControl", () => {
  it("applies pause/resume state and edit requests to the run's control", async () => {
    const store = createLiveRunStore(tempStoreDir());
    await store.create(meta("r1"));
    const control = createWorkflowRunControl();
    // Bind engine-side hooks so edits validate: everything editable.
    control.attachRun({
      stepEditIssue: () => undefined,
      onEditAccepted: () => {},
      killStep: () => ({ ok: true }),
    });

    const dispose = watchRunControl(store, "r1", control, 20);
    try {
      await store.writePauseState("r1", { paused: true, by: "human:cli" });
      await waitFor(() => control.isPauseRequested());
      expect(control.pauseRequestedBy()).toBe("human:cli");

      const editId = await store.requestStepEdit("r1", {
        stepId: "a",
        patch: { prompt: "edited" },
        by: "human:cli",
      });
      await waitFor(() => control.stepEdit("a") !== undefined);
      expect(control.stepEdit("a")).toEqual({ prompt: "edited" });
      await waitFor(async () => (await store.readStepEditResult("r1", editId!)) !== undefined);
      expect(await store.readStepEditResult("r1", editId!)).toEqual({ ok: true });

      await store.writePauseState("r1", { paused: false, by: "human:web" });
      await waitFor(() => !control.isPauseRequested());
      expect(control.resumeRequestedBy()).toBe("human:web");
    } finally {
      dispose();
    }
  });

  it("writes the engine's rejection back for the requester to read", async () => {
    const store = createLiveRunStore(tempStoreDir());
    await store.create(meta("r1"));
    const control = createWorkflowRunControl();
    control.attachRun({
      stepEditIssue: () => "step 'a' has already started",
      onEditAccepted: () => {},
      killStep: () => ({ ok: false, error: "step 'a' is not running" }),
    });
    await store.writePauseState("r1", { paused: true });

    const dispose = watchRunControl(store, "r1", control, 20);
    try {
      const editId = await store.requestStepEdit("r1", { stepId: "a", patch: { prompt: "x" } });
      await waitFor(async () => (await store.readStepEditResult("r1", editId!)) !== undefined);
      expect(await store.readStepEditResult("r1", editId!)).toEqual({
        ok: false,
        error: "step 'a' has already started",
      });
    } finally {
      dispose();
    }
  });
});

describe("live-run publisher: paused meta mirror", () => {
  it("mirrors run_paused/run_resumed into meta.paused", async () => {
    const store = createLiveRunStore(tempStoreDir());
    await store.create(meta("r1"));
    const publisher = createLiveRunPublisher(store, "r1");

    publisher.event({ kind: "run_paused", by: "human:cli", ts: Date.now() });
    await waitFor(async () => (await store.get("r1"))?.paused === true);

    publisher.event({ kind: "run_resumed", ts: Date.now() });
    await waitFor(async () => (await store.get("r1"))?.paused === false);

    await publisher.finish("done", { ok: true });
    expect((await store.get("r1"))?.paused).toBe(false);
  });
});

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(10);
  }
}
