import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type LiveRunStore,
  type WorkflowEvent,
  createLiveRunPublisher,
  createLiveRunStore,
  newLiveRunMeta,
  storeHumanInputProvider,
} from "../src/workflow";

describe("live-run store human inputs", () => {
  let dir: string;
  let store: LiveRunStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "steamtrain-inputs-"));
    store = createLiveRunStore(dir);
    await store.create(
      newLiveRunMeta({ id: "run-1", workflow: "w", input: "go", cwd: "/", source: "cli" }),
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips attempt-scoped answers", async () => {
    expect(await store.readHumanInputResponse("run-1", "ask", 1, 1)).toBeUndefined();
    await store.writeHumanInputResponse("run-1", "ask", 1, 1, {
      value: "blue",
      by: "human:cli",
    });
    expect(await store.readHumanInputResponse("run-1", "ask", 1, 1)).toEqual({
      value: "blue",
      by: "human:cli",
    });
    // A different attempt reads nothing — a stale bad answer can't satisfy a re-ask.
    expect(await store.readHumanInputResponse("run-1", "ask", 1, 2)).toBeUndefined();
  });

  it("finds answers written under a namespaced sub-workflow id by the local id", async () => {
    await store.writeHumanInputResponse("run-1", "parent::ask", 1, 1, {
      value: "v",
      by: "human:web",
    });
    expect(await store.readHumanInputResponse("run-1", "ask", 1, 1)).toEqual({
      value: "v",
      by: "human:web",
    });
  });

  it("round-trips canceled responses", async () => {
    await store.writeHumanInputResponse("run-1", "ask", 1, 1, {
      canceled: true,
      by: "auto:test",
      reason: "nobody home",
    });
    expect(await store.readHumanInputResponse("run-1", "ask", 1, 1)).toEqual({
      canceled: true,
      by: "auto:test",
      reason: "nobody home",
    });
  });

  it("storeHumanInputProvider polls until an answer lands", async () => {
    const provider = storeHumanInputProvider(store, "run-1");
    const pending = provider({
      stepId: "ask",
      phaseId: "p",
      iteration: 1,
      attempt: 1,
      prompt: "?",
      origin: "human-step",
    });
    await new Promise((r) => setTimeout(r, 50));
    await store.writeHumanInputResponse("run-1", "ask", 1, 1, { value: "late answer" });
    const response = await pending;
    expect(response).toEqual({ value: "late answer", by: "human" });
  });

  it("the publisher mirrors pending inputs into the meta and clears on finish", async () => {
    const publisher = createLiveRunPublisher(store, "run-1");
    const pendingEvent: WorkflowEvent = {
      kind: "human_input_pending",
      phaseId: "p",
      stepId: "ask",
      attempt: 1,
      prompt: "a".repeat(300),
      choices: ["x", "y"],
      origin: "human-step",
      ts: 1,
    };
    publisher.event(pendingEvent);
    await new Promise((r) => setTimeout(r, 100));
    let meta = await store.get("run-1");
    expect(meta?.pendingInputs).toHaveLength(1);
    expect(meta?.pendingInputs?.[0]).toMatchObject({
      stepId: "ask",
      iteration: 1,
      attempt: 1,
      origin: "human-step",
      choices: ["x", "y"],
    });
    // Prompt is truncated for the meta (list views only need a teaser).
    expect(meta?.pendingInputs?.[0]?.prompt?.length).toBeLessThanOrEqual(201);

    // A re-ask supersedes rather than stacking.
    publisher.event({ ...pendingEvent, attempt: 2, ts: 2 });
    await new Promise((r) => setTimeout(r, 100));
    meta = await store.get("run-1");
    expect(meta?.pendingInputs).toHaveLength(1);
    expect(meta?.pendingInputs?.[0]?.attempt).toBe(2);

    publisher.event({
      kind: "human_input_resolved",
      phaseId: "p",
      stepId: "ask",
      value: "x",
      origin: "human-step",
      ts: 3,
    });
    await new Promise((r) => setTimeout(r, 100));
    meta = await store.get("run-1");
    expect(meta?.pendingInputs).toHaveLength(0);

    await publisher.finish("done", { ok: true });
    meta = await store.get("run-1");
    expect(meta?.pendingInputs).toEqual([]);
  });
});
