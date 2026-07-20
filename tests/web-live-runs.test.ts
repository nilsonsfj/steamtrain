import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type WorkflowHost, WorkflowRunManager } from "../src/web/runs";
import { createWebServer } from "../src/web/server";
import type { StepResult, WorkflowCacheStore, WorkflowEvent, WorkflowSpec } from "../src/workflow";
import { createLiveRunPublisher, createLiveRunStore, newLiveRunMeta } from "../src/workflow";
import { readSse } from "./helpers/read-sse";

const servers: Server[] = [];

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop()!;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "steamtrain-web-live-"));
}

function demoSpec(name = "demo"): WorkflowSpec {
  return {
    name,
    phases: [
      {
        id: "p1",
        title: "Phase 1",
        steps: [{ id: "s1", kind: "worker", agent: "opencode", model: "m", prompt: "{{input}}" }],
      },
    ],
  };
}

function createInMemoryStore(): WorkflowCacheStore {
  const store = new Map<string, Map<string, StepResult>>();
  const k = (key: { workflow: string; cwd: string; input: string; specHash: string }): string =>
    `${key.workflow}:${key.cwd}:${key.input}:${key.specHash}`;
  return {
    rootDir: "/tmp/test-cache",
    async load(key) {
      return store.get(k(key)) ?? new Map();
    },
    async save(key, cache) {
      store.set(k(key), new Map(cache));
    },
    async clear(key) {
      store.delete(k(key));
    },
    async clearAll() {
      store.clear();
    },
  };
}

class FakeHost implements WorkflowHost {
  constructor(
    private readonly spec: WorkflowSpec,
    private readonly gen: (input: string, signal?: AbortSignal) => AsyncIterable<WorkflowEvent>,
  ) {}
  listWorkflows(): Record<string, WorkflowSpec> {
    return { [this.spec.name]: this.spec };
  }
  canDispatchWorkflowSpec(): { ok: true } {
    return { ok: true };
  }
  runWorkflow(_name: string, input: string, signal?: AbortSignal): AsyncIterable<WorkflowEvent> {
    return this.gen(input, signal);
  }
}

async function* happyRun(input: string): AsyncIterable<WorkflowEvent> {
  const ts = () => Date.now();
  yield { kind: "workflow_start", name: "demo", phaseCount: 1, stepCount: 1, ts: ts() };
  yield { kind: "phase_start", phaseId: "p1", title: "Phase 1", index: 0, stepCount: 1, ts: ts() };
  yield { kind: "step_start", phaseId: "p1", stepId: "s1", blockKind: "worker", ts: ts() };
  const result: StepResult = { stepId: "s1", ok: true, output: `hi ${input}`, durationMs: 5 };
  yield { kind: "step_done", phaseId: "p1", stepId: "s1", result, cached: false, ts: ts() };
  yield { kind: "phase_done", phaseId: "p1", ok: true, ts: ts() };
  yield { kind: "workflow_done", ok: true, results: [result], ts: ts() };
}

const testRunConfig = { stepTimeoutSec: 60, workflowTimeoutSec: 3600, maxParallelRuns: 2 };

function makeServer(root: string) {
  const liveRuns = createLiveRunStore(join(root, "runs"));
  const host = new FakeHost(demoSpec(), happyRun);
  const runs = new WorkflowRunManager({
    host,
    cacheStore: createInMemoryStore(),
    cwd: root,
    config: testRunConfig,
    liveRuns,
  });
  const server = createWebServer({ host, runs, liveRuns });
  servers.push(server);
  return { server, runs, liveRuns };
}

async function start(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function waitFor(cond: () => Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not met in time");
}

describe("web live-run integration", () => {
  it("mirrors web runs into the live-run store and lists them via GET /api/runs", async () => {
    const root = tempDir();
    const { server, runs, liveRuns } = makeServer(root);
    const base = await start(server);

    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "demo", input: "go" }),
    });
    expect(res.status).toBe(201);
    const { runId } = (await res.json()) as { runId: string };

    await waitFor(async () => runs.get(runId)?.status === "done");
    // The mirror settles asynchronously right before the terminal frame.
    await waitFor(async () => (await liveRuns.get(runId))?.status === "done");

    const list = (await (await fetch(`${base}/api/runs`)).json()) as {
      runs: { id: string; source: string; external: boolean }[];
    };
    const entry = list.runs.find((r) => r.id === runId);
    expect(entry).toBeDefined();
    expect(entry?.source).toBe("web");
    expect(entry?.external).toBe(false);

    // The on-disk mirror carries the full event stream for cross-UI attach.
    const events = await liveRuns.readEvents(runId);
    expect(events.map((e) => e.kind)).toContain("workflow_done");
  });

  it("lists, streams, and cancels externally-owned runs", async () => {
    const root = tempDir();
    const { server, liveRuns } = makeServer(root);
    const base = await start(server);

    // Simulate a CLI-detached run owned by this (alive) process.
    const meta = newLiveRunMeta({
      id: "ext-run",
      workflow: "other",
      input: "external input",
      cwd: root,
      source: "cli-detached",
      detached: true,
    });
    await liveRuns.create({
      ...meta,
      status: "running",
      startedAt: Date.now(),
      pendingInputs: [
        {
          stepId: "clarify",
          iteration: 1,
          attempt: 2,
          origin: "agent-question",
          prompt: "Which environment?",
          choices: ["staging", "production"],
        },
      ],
    });
    await liveRuns.appendEventLines(
      "ext-run",
      `${JSON.stringify({ kind: "workflow_start", name: "other", phaseCount: 1, stepCount: 1, ts: Date.now() })}\n`,
    );

    const list = (await (await fetch(`${base}/api/runs`)).json()) as {
      runs: {
        id: string;
        external: boolean;
        detached: boolean;
        status: string;
        pendingInputs?: { stepId: string; attempt: number; prompt?: string }[];
      }[];
    };
    const entry = list.runs.find((r) => r.id === "ext-run");
    expect(entry).toMatchObject({
      external: true,
      detached: true,
      status: "running",
      pendingInputs: [{ stepId: "clarify", attempt: 2, prompt: "Which environment?" }],
    });

    // Cancel drops the marker for the external owner to pick up.
    const cancel = await fetch(`${base}/api/runs/ext-run/cancel`, { method: "POST" });
    expect(cancel.status).toBe(200);
    expect(await liveRuns.cancelRequested("ext-run")).toBe(true);

    // Streaming replays the recorded events, then ends on terminal meta.
    const publisher = createLiveRunPublisher(liveRuns, "ext-run");
    await publisher.finish("canceled", { ok: false });
    const settledList = (await (await fetch(`${base}/api/runs`)).json()) as {
      runs: { id: string; pendingInputs?: unknown[] }[];
    };
    expect(settledList.runs.find((r) => r.id === "ext-run")?.pendingInputs).toEqual([]);
    const frames = await readSse(`${base}/api/runs/ext-run/stream`);
    expect(frames.some((f) => f.type === "event")).toBe(true);
    const status = frames.find((f) => f.type === "status");
    expect(status).toMatchObject({ status: "canceled" });
  });

  it("resolves approvals on externally-owned runs via decision files", async () => {
    const root = tempDir();
    const { server, liveRuns } = makeServer(root);
    const base = await start(server);

    const meta = newLiveRunMeta({
      id: "ext-appr",
      workflow: "other",
      input: "needs approval",
      cwd: root,
      source: "cli-detached",
      detached: true,
    });
    await liveRuns.create({
      ...meta,
      status: "running",
      startedAt: Date.now(),
      pendingApprovals: [{ stepId: "gate", iteration: 1 }],
    });

    const res = await fetch(`${base}/api/runs/ext-appr/approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stepId: "gate", approved: true }),
    });
    expect(res.status).toBe(200);
    const decision = await liveRuns.readApprovalDecision("ext-appr", "gate", 1);
    expect(decision?.approved).toBe(true);
    expect(decision?.by).toBe("human:web");

    // Unknown checkpoint → 404 and no decision written.
    const bad = await fetch(`${base}/api/runs/ext-appr/approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stepId: "nope", approved: true }),
    });
    expect(bad.status).toBe(404);
  });

  it("queues web runs beyond maxParallelRuns and emits queued frames", async () => {
    const root = tempDir();
    const liveRuns = createLiveRunStore(join(root, "runs"));
    const host = new FakeHost(demoSpec(), async function* (_input, signal) {
      yield {
        kind: "workflow_start",
        name: "demo",
        phaseCount: 1,
        stepCount: 1,
        ts: Date.now(),
      } as WorkflowEvent;
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener("abort", () => resolve());
      });
      yield { kind: "workflow_done", ok: false, results: [], ts: Date.now() } as WorkflowEvent;
    });
    const runs = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      cwd: root,
      config: { ...testRunConfig, maxParallelRuns: 1 },
      liveRuns,
    });
    const server = createWebServer({ host, runs, liveRuns });
    servers.push(server);
    const base = await start(server);

    const first = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "demo", input: "one" }),
    });
    const { runId: firstId } = (await first.json()) as { runId: string };
    await waitFor(async () => (await liveRuns.get(firstId))?.status === "running");

    const second = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "demo", input: "two" }),
    });
    const { runId: secondId } = (await second.json()) as { runId: string };

    // The second run waits in the queue (live-store status stays "queued").
    await waitFor(async () => (await liveRuns.get(secondId))?.status === "queued");
    const list = (await (await fetch(`${base}/api/runs`)).json()) as {
      runs: { id: string; status: string }[];
    };
    expect(list.runs.find((r) => r.id === secondId)?.status).toBe("queued");

    // Canceling the first frees the slot; the second starts running.
    await fetch(`${base}/api/runs/${firstId}/cancel`, { method: "POST" });
    await waitFor(async () => (await liveRuns.get(secondId))?.status === "running");

    // Drain: cancel the second too so the server can close cleanly.
    await fetch(`${base}/api/runs/${secondId}/cancel`, { method: "POST" });
    await waitFor(async () => {
      const meta = await liveRuns.get(secondId);
      return meta ? meta.status === "canceled" : false;
    });
  });
});
