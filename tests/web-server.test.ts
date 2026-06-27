import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type WorkflowHost, WorkflowRunManager } from "../src/web/runs";
import { createWebServer } from "../src/web/server";
import type {
  StepResult,
  WorkflowCacheStore,
  WorkflowEvent,
  WorkflowHistoryStore,
  WorkflowSpec,
} from "../src/workflow";
import { RunRecordBuilder, createWorkflowHistoryStore } from "../src/workflow";

const servers: Server[] = [];

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function demoSpec(name = "demo"): WorkflowSpec {
  return {
    name,
    description: "a demo workflow",
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
  return {
    rootDir: "/tmp/test-cache",
    async load(key) {
      const k = `${key.workflow}:${key.cwd}:${key.input}:${key.specHash}`;
      return store.get(k) ?? new Map();
    },
    async save(key, cache) {
      const k = `${key.workflow}:${key.cwd}:${key.input}:${key.specHash}`;
      store.set(k, new Map(cache));
    },
    async clear(key) {
      store.delete(`${key.workflow}:${key.cwd}:${key.input}:${key.specHash}`);
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
    private readonly dispatchable = true,
  ) {}
  listWorkflows(): Record<string, WorkflowSpec> {
    return { [this.spec.name]: this.spec };
  }
  canDispatchWorkflowSpec(): { ok: true } | { ok: false; reason: string } {
    return this.dispatchable ? { ok: true } : { ok: false, reason: "agent is down" };
  }
  runWorkflow(name: string, input: string, signal?: AbortSignal): AsyncIterable<WorkflowEvent> {
    return this.gen(input, signal);
  }
}

async function* happyRun(input: string): AsyncIterable<WorkflowEvent> {
  const ts = () => Date.now();
  yield { kind: "workflow_start", name: "demo", phaseCount: 1, stepCount: 1, ts: ts() };
  yield { kind: "phase_start", phaseId: "p1", title: "Phase 1", index: 0, stepCount: 1, ts: ts() };
  yield {
    kind: "step_start",
    phaseId: "p1",
    stepId: "s1",
    blockKind: "worker",
    agent: "opencode",
    model: "m",
    ts: ts(),
  };
  yield {
    kind: "step_event",
    phaseId: "p1",
    stepId: "s1",
    event: { kind: "text_delta", text: `hi ${input}`, agent: "opencode", ts: Date.now() },
    ts: ts(),
  };
  const result: StepResult = { stepId: "s1", ok: true, output: `hi ${input}`, durationMs: 5 };
  yield { kind: "step_done", phaseId: "p1", stepId: "s1", result, cached: false, ts: ts() };
  yield { kind: "phase_done", phaseId: "p1", ok: true, ts: ts() };
  yield { kind: "workflow_done", ok: true, results: [result], ts: ts() };
}

async function* hangingRun(_input: string, signal?: AbortSignal): AsyncIterable<WorkflowEvent> {
  yield { kind: "workflow_start", name: "demo", phaseCount: 1, stepCount: 1, ts: Date.now() };
  yield {
    kind: "step_start",
    phaseId: "p1",
    stepId: "s1",
    blockKind: "worker",
    ts: Date.now(),
  };
  // Mirror the real engine's graceful abort: it does NOT throw — it breaks the
  // loop and yields a final workflow_done with ok:false, then returns normally.
  await new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    signal?.addEventListener("abort", () => resolve());
  });
  yield { kind: "workflow_done", ok: false, results: [], ts: Date.now() };
}

function makeServer(host: WorkflowHost): { server: Server; runs: WorkflowRunManager } {
  const runs = new WorkflowRunManager({ host, cacheStore: createInMemoryStore(), cwd: "/tmp" });
  const server = createWebServer({
    host,
    runs,
    workflowSource: () => "bundled",
    doctor: () => [{ agent: "opencode", status: "ok", message: "ready" }] as never,
    configLabel: "test config",
  });
  servers.push(server);
  return { server, runs };
}

async function start(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** Read an SSE response, collecting `data:` payloads until the terminal status frame. */
async function readSse(url: string): Promise<{ type: string; [k: string]: unknown }[]> {
  const res = await fetch(url);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const frames: { type: string; [k: string]: unknown }[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard SSE frame split
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const frame = JSON.parse(line.slice(6));
      frames.push(frame);
      if (frame.type === "status") {
        await reader.cancel();
        return frames;
      }
    }
  }
  return frames;
}

describe("web server", () => {
  it("serves the single-page app", async () => {
    const { server } = makeServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const res = await fetch(`${base}/`);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("steam");
    expect(html).toContain('id="wflist"');
    expect(html).toContain("/api/runs/");
  });

  it("lists workflows with summaries", async () => {
    const { server } = makeServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const res = await fetch(`${base}/api/workflows`);
    const body = (await res.json()) as {
      configLabel: string;
      workflows: Record<string, unknown>[];
    };
    expect(body.configLabel).toBe("test config");
    expect(body.workflows).toHaveLength(1);
    expect(body.workflows[0]).toMatchObject({
      name: "demo",
      source: "bundled",
      phaseCount: 1,
      stepCount: 1,
      kinds: { worker: 1 },
      agents: ["opencode"],
    });
  });

  it("returns a full spec and 404s unknown workflows", async () => {
    const { server } = makeServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const ok = await fetch(`${base}/api/workflows/demo`);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { spec: { name: string } }).spec.name).toBe("demo");
    const missing = await fetch(`${base}/api/workflows/nope`);
    expect(missing.status).toBe(404);
  });

  it("rejects runs for unknown or undispatchable workflows", async () => {
    const { server } = makeServer(new FakeHost(demoSpec(), happyRun, false));
    const base = await start(server);
    const unknown = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "nope", input: "x" }),
    });
    expect(unknown.status).toBe(400);
    const blocked = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "demo", input: "x" }),
    });
    expect(blocked.status).toBe(400);
    expect(((await blocked.json()) as { error: string }).error).toContain("agent is down");
  });

  it("streams workflow events then a terminal done status", async () => {
    const { server } = makeServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const created = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "demo", input: "world" }),
    });
    expect(created.status).toBe(201);
    const { runId } = (await created.json()) as { runId: string };
    expect(runId).toBeTruthy();

    const frames = await readSse(`${base}/api/runs/${runId}/stream`);
    const events = frames.filter((f) => f.type === "event").map((f) => f.event as WorkflowEvent);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("workflow_start");
    expect(kinds).toContain("step_done");
    expect(kinds).toContain("workflow_done");

    const status = frames[frames.length - 1]!;
    expect(status.type).toBe("status");
    expect(status.status).toBe("done");
    expect(status.ok).toBe(true);
  });

  it("records a completed run and serves it from the history routes", async () => {
    const host = new FakeHost(demoSpec(), happyRun);
    const root = mkdtempSync(join(tmpdir(), "steamtrain-web-history-"));
    const historyStore = createWorkflowHistoryStore(root);
    const runs = new WorkflowRunManager({ host, cacheStore: createInMemoryStore(), historyStore, cwd: "/tmp" });
    const server = createWebServer({
      host,
      runs,
      history: historyStore,
      workflowSource: () => "bundled",
    });
    servers.push(server);
    const base = await start(server);

    const created = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "demo", input: "world" }),
    });
    const { runId } = (await created.json()) as { runId: string };
    // Drain the stream so the run reaches its terminal state (and history save).
    await readSse(`${base}/api/runs/${runId}/stream`);

    const listRes = await fetch(`${base}/api/history`);
    const { runs: list } = (await listRes.json()) as { runs: { id: string; workflow: string }[] };
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: runId, workflow: "demo" });
    expect(list[0]).not.toHaveProperty("phases");

    const recRes = await fetch(`${base}/api/history/${runId}`);
    expect(recRes.status).toBe(200);
    const { record } = (await recRes.json()) as { record: { phases: unknown[] } };
    expect(record.phases).toHaveLength(1);

    const missing = await fetch(`${base}/api/history/nope`);
    expect(missing.status).toBe(404);

    const del = await fetch(`${base}/api/history/${runId}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const after = await fetch(`${base}/api/history`);
    expect(((await after.json()) as { runs: unknown[] }).runs).toHaveLength(0);
  });

  it("cancels a running workflow", async () => {
    const { server } = makeServer(new FakeHost(demoSpec(), hangingRun));
    const base = await start(server);
    const created = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "demo", input: "x" }),
    });
    const { runId } = (await created.json()) as { runId: string };

    const cancel = await fetch(`${base}/api/runs/${runId}/cancel`, { method: "POST" });
    expect(cancel.status).toBe(200);
    expect(((await cancel.json()) as { canceled: boolean }).canceled).toBe(true);

    const frames = await readSse(`${base}/api/runs/${runId}/stream`);
    const status = frames[frames.length - 1]!;
    expect(status.type).toBe("status");
    expect(status.status).toBe("canceled");
  });

  it("is not cancelable in the settled-but-not-terminal window", async () => {
    // Pin the exact race the settled/terminal split closes: the run's outcome is
    // resolved (settled === true) but the terminal SSE frame hasn't been emitted
    // yet (terminal === false) because the history write is still in flight. A
    // blocking history store parks `drive()` inside that window. The old code,
    // which keyed cancel() off `terminal`, would (wrongly) report this run as
    // cancelable; the new code keys off `settled`.
    let enterWindow!: () => void;
    const inWindow = new Promise<void>((resolve) => {
      enterWindow = resolve;
    });
    let releaseWrite!: () => void;
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const blockingHistory: WorkflowHistoryStore = {
      rootDir: "/tmp/none",
      async save() {
        enterWindow();
        await writeReleased;
      },
      async list() {
        return [];
      },
      async get() {
        return undefined;
      },
      async remove() {},
      async clearAll() {},
    };

    const host = new FakeHost(demoSpec(), happyRun);
    const runs = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      historyStore: blockingHistory,
      cwd: "/tmp",
    });
    const server = createWebServer({ host, runs, workflowSource: () => "bundled" });
    servers.push(server);
    const base = await start(server);

    const created = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "demo", input: "x" }),
    });
    const { runId } = (await created.json()) as { runId: string };

    // Wait until drive() is parked mid-write: settled === true, terminal === false.
    await inWindow;
    const cancel = await fetch(`${base}/api/runs/${runId}/cancel`, { method: "POST" });
    expect(cancel.status).toBe(404);
    expect(((await cancel.json()) as { canceled: boolean }).canceled).toBe(false);

    // Let the write finish so the run reaches its terminal state and closes out.
    releaseWrite();
  });

  it("re-runs a past run via POST /api/history/:id/rerun", async () => {
    const host = new FakeHost(demoSpec(), happyRun);
    const historyStore = createWorkflowHistoryStore(
      mkdtempSync(join(tmpdir(), "steamtrain-web-rerun-")),
    );
    const runs = new WorkflowRunManager({ host, cacheStore: createInMemoryStore(), historyStore, cwd: "/tmp" });
    const server = createWebServer({
      host,
      runs,
      history: historyStore,
      workflowSource: () => "bundled",
    });
    servers.push(server);
    const base = await start(server);

    const created = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "demo", input: "world" }),
    });
    const { runId } = (await created.json()) as { runId: string };
    await readSse(`${base}/api/runs/${runId}/stream`);

    const rerun = await fetch(`${base}/api/history/${runId}/rerun`, { method: "POST" });
    expect(rerun.status).toBe(201);
    const body = (await rerun.json()) as { runId: string; downgraded?: string };
    expect(body.runId).toBeTruthy();
    expect(body.runId).not.toBe(runId);
    expect(runs.get(body.runId)?.workflow).toBe("demo");
  });

  it("retry-failed flags a drift downgrade when the spec changed", async () => {
    const host = new FakeHost(demoSpec(), happyRun);
    const historyStore = createWorkflowHistoryStore(
      mkdtempSync(join(tmpdir(), "steamtrain-web-retry-")),
    );
    const runs = new WorkflowRunManager({ host, cacheStore: createInMemoryStore(), historyStore, cwd: "/tmp" });
    const server = createWebServer({
      host,
      runs,
      history: historyStore,
      workflowSource: () => "bundled",
    });
    servers.push(server);
    const base = await start(server);

    // A record whose specHash does not match the current demo spec.
    const builder = new RunRecordBuilder({
      id: "stale-run",
      workflow: "demo",
      input: "world",
      cwd: "/tmp",
      specHash: "stale",
    });
    for await (const ev of happyRun("world")) builder.handle(ev);
    await historyStore.save(builder.build({ status: "done" }));

    const retry = await fetch(`${base}/api/history/stale-run/retry`, { method: "POST" });
    expect(retry.status).toBe(201);
    const body = (await retry.json()) as { runId: string; downgraded?: string };
    expect(body.downgraded).toBe("spec-changed");
  });

  it("rejects runs when concurrent limit is exceeded", async () => {
    const host = new FakeHost(demoSpec(), hangingRun);
    const runs = new WorkflowRunManager({ host, cacheStore: createInMemoryStore(), cwd: "/tmp", maxConcurrent: 1 });
    const server = createWebServer({ host, runs, workflowSource: () => "bundled" });
    servers.push(server);
    const base = await start(server);

    const first = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "demo", input: "a" }),
    });
    expect(first.status).toBe(201);

    const second = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "demo", input: "b" }),
    });
    expect(second.status).toBe(503);
    expect(((await second.json()) as { error: string }).error).toContain("too many concurrent");
  });

  it("rejects POST /api/runs with empty body", async () => {
    const { server } = makeServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "",
    });
    expect(res.status).toBe(400);
  });

  it("rejects POST /api/runs with missing workflow field", async () => {
    const { server } = makeServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "test" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects POST /api/runs with non-string workflow", async () => {
    const { server } = makeServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: 123, input: "test" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects PUT /api/workflows/:name when authoring not enabled", async () => {
    const { server } = makeServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const res = await fetch(`${base}/api/workflows/demo`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(501);
  });

  it("rejects PUT /api/workflows/:name with missing spec (501 without author)", async () => {
    const { server } = makeServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const res = await fetch(`${base}/api/workflows/demo`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(501);
  });

  it("returns 404 for unknown routes", async () => {
    const { server } = makeServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const res = await fetch(`${base}/api/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("rejects oversized payloads with 413", async () => {
    const { server } = makeServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const bigBody = "x".repeat(2 * 1024 * 1024);
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: bigBody,
    });
    expect(res.status).toBe(413);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("too large");
  });

  it("returns 404 for a rerun of an unknown run id", async () => {
    const host = new FakeHost(demoSpec(), happyRun);
    const historyStore = createWorkflowHistoryStore(
      mkdtempSync(join(tmpdir(), "steamtrain-web-rerun404-")),
    );
    const runs = new WorkflowRunManager({ host, cacheStore: createInMemoryStore(), historyStore, cwd: "/tmp" });
    const server = createWebServer({
      host,
      runs,
      history: historyStore,
      workflowSource: () => "bundled",
    });
    servers.push(server);
    const base = await start(server);

    const res = await fetch(`${base}/api/history/nope/rerun`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});
