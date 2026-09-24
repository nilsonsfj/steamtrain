import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowEvent } from "../src/workflow/events";
import { createWorkflowHistoryStore } from "../src/workflow/history-store";
import {
  acquireRunSlot,
  createLiveRunPublisher,
  newLiveRunMeta,
  resolveMaxParallelRuns,
  storeApprovalProvider,
  watchRunCancel,
  withStoreApprovals,
} from "../src/workflow/live-run";
import {
  LIVE_RUN_HEARTBEAT_STALE_MS,
  LIVE_RUN_META_VERSION,
  type LiveRunMeta,
  createLiveRunStore,
  isLiveRunOwnerAlive,
  isTerminalLiveRunStatus,
} from "../src/workflow/live-run-store";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "steamtrain-live-"));
}

function meta(id: string, overrides: Partial<LiveRunMeta> = {}): LiveRunMeta {
  return {
    ...newLiveRunMeta({
      id,
      workflow: "wf",
      input: "go",
      cwd: "/tmp",
      source: "cli",
    }),
    ...overrides,
  };
}

function stepStart(stepId: string): WorkflowEvent {
  return { kind: "step_start", phaseId: "p1", stepId, ts: Date.now() };
}

function textDelta(stepId: string, text: string): WorkflowEvent {
  return {
    kind: "step_event",
    phaseId: "p1",
    stepId,
    event: { kind: "text_delta", text, agent: "claude", ts: Date.now() },
    ts: Date.now(),
  };
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

describe("live-run store", () => {
  it("creates, reads, updates, and lists runs newest-first", async () => {
    const store = createLiveRunStore(tempDir());
    await store.create(meta("a", { createdAt: 1000 }));
    await store.create(meta("b", { createdAt: 2000 }));
    const got = await store.get("a");
    expect(got?.workflow).toBe("wf");
    expect(got?.status).toBe("queued");
    await store.update("a", { status: "running", startedAt: 1500 });
    expect((await store.get("a"))?.status).toBe("running");
    const listed = await store.list({ sweep: false });
    expect(listed.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("ignores corrupt and wrong-version meta files", async () => {
    const root = tempDir();
    const store = createLiveRunStore(root);
    await store.create(meta("good"));
    await store.create(meta("bad"));
    await writeFile(join(root, "bad", "meta.json"), "{nope", "utf8");
    await store.create(meta("old"));
    await store.update("old", { version: LIVE_RUN_META_VERSION + 1 } as Partial<LiveRunMeta>);
    const listed = await store.list({ sweep: false });
    expect(listed.map((r) => r.id)).toEqual(["good"]);
  });

  it("replays and tails events until the meta turns terminal", async () => {
    const store = createLiveRunStore(tempDir());
    await store.create(meta("run", { status: "running", pid: process.pid }));
    await store.appendEventLines("run", `${JSON.stringify(stepStart("s1"))}\n`);

    const seen: WorkflowEvent[] = [];
    const done = (async () => {
      for await (const event of store.tailEvents("run", { pollMs: 10 })) seen.push(event);
    })();

    // Give the tail a moment to replay, then append live and finish.
    await new Promise((r) => setTimeout(r, 30));
    await store.appendEventLines("run", `${JSON.stringify(stepStart("s2"))}\n`);
    await new Promise((r) => setTimeout(r, 30));
    await store.update("run", { status: "done", ok: true, endedAt: Date.now() });
    await done;

    expect(seen.map((e) => (e.kind === "step_start" ? e.stepId : e.kind))).toEqual(["s1", "s2"]);
  });

  it("tail skips torn (partial) trailing lines until completed", async () => {
    const store = createLiveRunStore(tempDir());
    await store.create(meta("run", { status: "running", pid: process.pid }));
    const line = JSON.stringify(stepStart("s1"));
    await store.appendEventLines("run", `${line}\n${JSON.stringify(stepStart("s2")).slice(0, 5)}`);
    const tail = store.tailEvents("run", { pollMs: 10 });
    const first = await tail.next();
    expect(first.value).toMatchObject({ stepId: "s1" });
    // Complete the torn line, then finish the run.
    const rest = `${JSON.stringify(stepStart("s2")).slice(5)}\n`;
    await store.appendEventLines("run", rest);
    const second = await tail.next();
    expect(second.value).toMatchObject({ stepId: "s2" });
    await store.update("run", { status: "canceled", endedAt: Date.now() });
    const end = await tail.next();
    expect(end.done).toBe(true);
  });

  it("cancel markers round-trip and refuse terminal runs", async () => {
    const store = createLiveRunStore(tempDir());
    await store.create(meta("run", { status: "running", pid: process.pid }));
    expect(await store.cancelRequested("run")).toBe(false);
    expect(await store.requestCancel("run")).toBe(true);
    expect(await store.cancelRequested("run")).toBe(true);
    await store.update("run", { status: "done", endedAt: Date.now() });
    expect(await store.requestCancel("run")).toBe(false);
    expect(await store.requestCancel("missing")).toBe(false);
  });

  it("approval decisions round-trip", async () => {
    const store = createLiveRunStore(tempDir());
    await store.create(meta("run", { status: "running", pid: process.pid }));
    expect(await store.readApprovalDecision("run", "gate", 1)).toBeUndefined();
    await store.writeApprovalDecision("run", "gate", 1, {
      approved: false,
      by: "human:web",
      note: "nope",
      rejectDisposition: "stop",
    });
    const decision = await store.readApprovalDecision("run", "gate", 1);
    expect(decision).toEqual({
      approved: false,
      by: "human:web",
      note: "nope",
      rejectDisposition: "stop",
    });
    // Different iteration is a different checkpoint.
    expect(await store.readApprovalDecision("run", "gate", 2)).toBeUndefined();
  });

  it("finds a decision written under a namespaced sub-workflow id when read by the local id", async () => {
    // The engine hands approval providers the LOCAL step id while events (and
    // external deciders) carry the NAMESPACED `parent::child` id — the read
    // must bridge the two or a decided checkpoint would hang forever.
    const store = createLiveRunStore(tempDir());
    await store.create(meta("run", { status: "running", pid: process.pid }));
    await store.writeApprovalDecision("run", "review::gate", 2, {
      approved: true,
      by: "human:cli",
    });
    const decision = await store.readApprovalDecision("run", "gate", 2);
    expect(decision?.approved).toBe(true);
    // Wrong iteration or unrelated local id still misses.
    expect(await store.readApprovalDecision("run", "gate", 1)).toBeUndefined();
    expect(await store.readApprovalDecision("run", "other", 2)).toBeUndefined();
  });

  it("sweep marks dead-pid runs orphaned and folds them into history", async () => {
    const root = tempDir();
    const historyDir = join(root, "history");
    const historyStore = createWorkflowHistoryStore(historyDir);
    const store = createLiveRunStore(join(root, "runs"), { historyStore });
    // pid 2^30 is virtually guaranteed dead; createdAt in the past beats the grace period.
    await store.create(
      meta("dead", { status: "running", pid: 2 ** 30, createdAt: Date.now() - 60_000 }),
    );
    await store.appendEventLines(
      "dead",
      `${JSON.stringify({ kind: "workflow_start", name: "wf", phaseCount: 1, stepCount: 1, ts: Date.now() })}\n`,
    );
    const listed = await store.list();
    expect(listed[0]?.status).toBe("error");
    expect(listed[0]?.error).toMatch(/exited/);
    const record = await historyStore.get("dead");
    expect(record?.status).toBe("error");
    expect(record?.workflow).toBe("wf");
  });

  it("sweep deletes expired terminal runs", async () => {
    const root = tempDir();
    let now = 1_000_000;
    const store = createLiveRunStore(root, { ttlMs: 100, now: () => now });
    await store.create(meta("done", { status: "done", endedAt: now, createdAt: now }));
    expect((await store.list()).length).toBe(1);
    now += 200;
    expect((await store.list()).length).toBe(0);
    expect(await store.get("done")).toBeUndefined();
  });

  it("update() on a nonexistent run returns undefined without creating anything", async () => {
    const store = createLiveRunStore(tempDir());
    expect(await store.update("missing", { status: "running" })).toBeUndefined();
    expect(await store.get("missing")).toBeUndefined();
  });

  it("remove() deletes a run dir and tolerates missing runs", async () => {
    const store = createLiveRunStore(tempDir());
    await store.create(meta("gone"));
    await store.remove("gone");
    expect(await store.get("gone")).toBeUndefined();
    await store.remove("gone"); // idempotent
  });

  it("appendEventLines on a nonexistent run throws (owners create first)", async () => {
    const store = createLiveRunStore(tempDir());
    await expect(store.appendEventLines("missing", "{}\n")).rejects.toThrow();
  });

  it("tailEvents returns immediately when the signal is already aborted", async () => {
    const store = createLiveRunStore(tempDir());
    await store.create(meta("run", { status: "running", pid: process.pid }));
    await store.appendEventLines("run", `${JSON.stringify(stepStart("s1"))}\n`);
    const ac = new AbortController();
    ac.abort();
    const seen = await collect(store.tailEvents("run", { signal: ac.signal, pollMs: 5 }));
    expect(seen).toEqual([]);
  });

  it("sanitizes hostile run ids away from path traversal", async () => {
    const root = tempDir();
    const store = createLiveRunStore(root);
    await store.create(meta("../../evil"));
    const listed = await store.list({ sweep: false });
    expect(listed[0]?.id).toBe("../../evil");
    // The directory on disk is sanitized (no traversal outside root).
    const raw = await readFile(join(root, ".._.._evil", "meta.json"), "utf8");
    expect(JSON.parse(raw).id).toBe("../../evil");
  });
});

describe("live-run publisher", () => {
  it("buffers events, tracks pending approvals, and finishes terminal", async () => {
    const store = createLiveRunStore(tempDir());
    await store.create(meta("run", { status: "running", pid: process.pid }));
    const publisher = createLiveRunPublisher(store, "run");
    publisher.event(stepStart("s1"));
    publisher.event({
      kind: "approval_pending",
      phaseId: "p1",
      stepId: "gate",
      onReject: "stop",
      ts: Date.now(),
    });
    // Drain the publisher write chain (pendingApprovals meta + buffered events)
    // instead of a fixed sleep — 60ms raced under CI load.
    await publisher.flush();
    expect((await store.get("run"))?.pendingApprovals).toEqual([{ stepId: "gate", iteration: 1 }]);
    publisher.event({
      kind: "approval_resolved",
      phaseId: "p1",
      stepId: "gate",
      approved: true,
      ts: Date.now(),
    });
    await publisher.finish("done", { ok: true });
    const final = await store.get("run");
    expect(final?.status).toBe("done");
    expect(final?.ok).toBe(true);
    expect(final?.pendingApprovals).toEqual([]);
    const events = await store.readEvents("run");
    expect(events.map((e) => e.kind)).toEqual([
      "step_start",
      "approval_pending",
      "approval_resolved",
    ]);
  });

  it("caps persisted stream chatter but keeps lifecycle events", async () => {
    const store = createLiveRunStore(tempDir());
    await store.create(meta("run", { status: "running", pid: process.pid }));
    const publisher = createLiveRunPublisher(store, "run");
    // Import the cap indirectly: overflow by publishing cap + 5 stream events.
    const { MAX_STREAM_EVENTS_PER_RUN } = await import("../src/workflow/live-run-store");
    for (let i = 0; i < MAX_STREAM_EVENTS_PER_RUN + 5; i++) {
      publisher.event(textDelta("s1", "x"));
    }
    publisher.event(stepStart("s2"));
    await publisher.finish("done", { ok: true });
    const events = await store.readEvents("run");
    const streamCount = events.filter((e) => e.kind === "step_event").length;
    // cap + the single truncation notice
    expect(streamCount).toBe(MAX_STREAM_EVENTS_PER_RUN + 1);
    expect(events.at(-1)?.kind).toBe("step_start");
  });
});

describe("run queue", () => {
  it("admits up to the limit and promotes in arrival order", async () => {
    const store = createLiveRunStore(tempDir());
    const base = Date.now();
    await store.create(meta("a", { createdAt: base, pid: process.pid }));
    await store.create(meta("b", { createdAt: base + 1, pid: process.pid }));
    await store.create(meta("c", { createdAt: base + 2, pid: process.pid }));

    expect(await acquireRunSlot(store, "a", 2, { pollMs: 5 })).toEqual({ ok: true });
    expect(await acquireRunSlot(store, "b", 2, { pollMs: 5 })).toEqual({ ok: true });

    const positions: number[] = [];
    const waiting = acquireRunSlot(store, "c", 2, {
      pollMs: 5,
      onQueued: (position) => positions.push(position),
    });
    // Queued, and has said so, before a slot frees up.
    await vi.waitFor(() => expect(positions).not.toHaveLength(0));
    expect((await store.get("c"))?.status).toBe("queued");
    // A slot frees up → c is promoted.
    await store.update("a", { status: "done", endedAt: Date.now() });
    expect(await waiting).toEqual({ ok: true });
    expect((await store.get("c"))?.status).toBe("running");
    expect(positions[0]).toBe(1);
  });

  it("ignores dead queue entries when counting slots", async () => {
    const store = createLiveRunStore(tempDir());
    await store.create(
      meta("dead", {
        status: "running",
        pid: 2 ** 30,
        createdAt: Date.now() - 60_000,
      }),
    );
    await store.create(meta("live", { pid: process.pid }));
    expect(await acquireRunSlot(store, "live", 1, { pollMs: 5 })).toEqual({ ok: true });
  });

  it("returns canceled when the cancel marker appears while queued", async () => {
    const store = createLiveRunStore(tempDir());
    await store.create(meta("hog", { pid: process.pid }));
    await store.create(meta("waiter", { pid: process.pid }));
    expect(await acquireRunSlot(store, "hog", 1, { pollMs: 5 })).toEqual({ ok: true });
    const waiting = acquireRunSlot(store, "waiter", 1, { pollMs: 5 });
    await store.requestCancel("waiter");
    expect(await waiting).toEqual({ ok: false, reason: "canceled" });
  });

  it("returns canceled when the abort signal fires while queued", async () => {
    const store = createLiveRunStore(tempDir());
    await store.create(meta("hog", { pid: process.pid }));
    await store.create(meta("waiter", { pid: process.pid }));
    expect(await acquireRunSlot(store, "hog", 1, { pollMs: 5 })).toEqual({ ok: true });
    const ac = new AbortController();
    const waiting = acquireRunSlot(store, "waiter", 1, { pollMs: 5, signal: ac.signal });
    ac.abort();
    expect(await waiting).toEqual({ ok: false, reason: "canceled" });
  });
});

describe("cancel watcher and approvals", () => {
  it("watchRunCancel fires once when the marker appears", async () => {
    const store = createLiveRunStore(tempDir());
    await store.create(meta("run", { status: "running", pid: process.pid }));
    let fired = 0;
    const dispose = watchRunCancel(store, "run", () => fired++, 10);
    await store.requestCancel("run");
    await vi.waitFor(() => expect(fired).toBeGreaterThan(0));
    // Several more polls see the same marker; none of them may fire again.
    await new Promise((r) => setTimeout(r, 60));
    expect(fired).toBe(1);
    dispose();
  });

  it("storeApprovalProvider resolves from a decision file", async () => {
    const store = createLiveRunStore(tempDir());
    await store.create(meta("run", { status: "running", pid: process.pid }));
    const provider = storeApprovalProvider(store, "run");
    const pending = provider(
      { stepId: "gate", iteration: 1, phaseId: "p1", onReject: "stop" },
      undefined,
    );
    await store.writeApprovalDecision("run", "gate", 1, { approved: true, by: "human:cli" });
    const decision = await pending;
    expect(decision.approved).toBe(true);
    expect(decision.by).toBe("human:cli");
  });

  it("storeApprovalProvider settles as canceled on abort", async () => {
    const store = createLiveRunStore(tempDir());
    await store.create(meta("run", { status: "running", pid: process.pid }));
    const provider = storeApprovalProvider(store, "run");
    const ac = new AbortController();
    const pending = provider(
      { stepId: "gate", iteration: 1, phaseId: "p1", onReject: "stop" },
      ac.signal,
    );
    ac.abort();
    const decision = await pending;
    expect(decision.approved).toBe(false);
    expect(decision.by).toBe("auto:canceled");
  });

  it("withStoreApprovals lets a store decision beat a slow local provider", async () => {
    const store = createLiveRunStore(tempDir());
    await store.create(meta("run", { status: "running", pid: process.pid }));
    const never: import("../src/workflow/approval").ApprovalProvider = () => new Promise(() => {});
    const provider = withStoreApprovals(store, "run", never);
    const pending = provider(
      { stepId: "gate", iteration: 1, phaseId: "p1", onReject: "stop" },
      undefined,
    );
    await store.writeApprovalDecision("run", "gate", 1, { approved: false });
    const decision = await pending;
    expect(decision.approved).toBe(false);
    expect(decision.by).toBe("human");
  });

  it("withStoreApprovals settles as canceled on abort even if the local provider hangs", async () => {
    const store = createLiveRunStore(tempDir());
    await store.create(meta("run", { status: "running", pid: process.pid }));
    const never: import("../src/workflow/approval").ApprovalProvider = () => new Promise(() => {});
    const provider = withStoreApprovals(store, "run", never);
    const ac = new AbortController();
    const pending = provider(
      { stepId: "gate", iteration: 1, phaseId: "p1", onReject: "stop" },
      ac.signal,
    );
    ac.abort();
    const decision = await pending;
    expect(decision.approved).toBe(false);
    expect(decision.by).toBe("auto:canceled");
  });

  it("withStoreApprovals survives a rejecting local provider (store decision still lands)", async () => {
    const store = createLiveRunStore(tempDir());
    await store.create(meta("run", { status: "running", pid: process.pid }));
    const rejecting: import("../src/workflow/approval").ApprovalProvider = () =>
      Promise.reject(new Error("boom"));
    const provider = withStoreApprovals(store, "run", rejecting);
    const pending = provider(
      { stepId: "gate", iteration: 1, phaseId: "p1", onReject: "stop" },
      undefined,
    );
    await store.writeApprovalDecision("run", "gate", 1, { approved: true });
    const decision = await pending;
    expect(decision.approved).toBe(true);
  });

  it("withStoreApprovals lets the local provider win too", async () => {
    const store = createLiveRunStore(tempDir());
    await store.create(meta("run", { status: "running", pid: process.pid }));
    const local: import("../src/workflow/approval").ApprovalProvider = async () => ({
      approved: true,
      by: "human:tui",
    });
    const provider = withStoreApprovals(store, "run", local);
    const decision = await provider(
      { stepId: "gate", iteration: 1, phaseId: "p1", onReject: "stop" },
      undefined,
    );
    expect(decision.by).toBe("human:tui");
  });
});

describe("resolveMaxParallelRuns", () => {
  it("defaults and honors config", () => {
    expect(resolveMaxParallelRuns(undefined)).toBe(2);
    expect(resolveMaxParallelRuns({} as never)).toBe(2);
    expect(resolveMaxParallelRuns({ maxParallelRuns: 5 } as never)).toBe(5);
    expect(resolveMaxParallelRuns({ maxParallelRuns: 0 } as never)).toBe(2);
  });
});

describe("live-run owner liveness / queue promote", () => {
  it("treats a live pid with a stale heartbeat as dead (PID-reuse guard)", () => {
    const now = Date.now();
    expect(
      isLiveRunOwnerAlive(
        {
          pid: process.pid,
          createdAt: now - 1_000,
          heartbeatAt: now - LIVE_RUN_HEARTBEAT_STALE_MS - 1,
        },
        now,
      ),
    ).toBe(false);
    expect(
      isLiveRunOwnerAlive(
        {
          pid: process.pid,
          createdAt: now - 1_000,
          heartbeatAt: now - 1_000,
        },
        now,
      ),
    ).toBe(true);
    // Legacy metas without heartbeat keep the pid-only check.
    expect(isLiveRunOwnerAlive({ pid: process.pid, createdAt: now }, now)).toBe(true);
  });

  it("tryPromote promotes under the lock and refuses a second claim", async () => {
    const store = createLiveRunStore(tempDir(), { withLock: (fn) => fn() });
    await store.create(meta("a", { status: "queued", createdAt: 1 }));
    await store.create(meta("b", { status: "queued", createdAt: 2 }));
    expect(await store.tryPromote("a", 1)).toBe("promoted");
    expect(await store.tryPromote("b", 1)).toBe("waiting");
    expect((await store.get("a"))?.status).toBe("running");
    expect((await store.get("b"))?.status).toBe("queued");
  });

  it("publisher refreshes heartbeatAt on finish", async () => {
    const store = createLiveRunStore(tempDir(), { withLock: (fn) => fn() });
    await store.create(meta("run", { status: "running", pid: process.pid, heartbeatAt: 1 }));
    const publisher = createLiveRunPublisher(store, "run");
    await publisher.finish("done", { ok: true });
    const final = await store.get("run");
    expect(final?.heartbeatAt).toBeGreaterThan(1);
    expect(final?.ownerToken).toBeTypeOf("string");
  });
});

describe("terminal status helper", () => {
  it("classifies statuses", () => {
    expect(isTerminalLiveRunStatus("done")).toBe(true);
    expect(isTerminalLiveRunStatus("budget-exceeded")).toBe(true);
    expect(isTerminalLiveRunStatus("running")).toBe(false);
    expect(isTerminalLiveRunStatus("queued")).toBe(false);
  });
});
