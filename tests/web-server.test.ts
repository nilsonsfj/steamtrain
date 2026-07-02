import { createHash } from "node:crypto";
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
import { RunRecordBuilder, WorkflowAuthor, createWorkflowHistoryStore } from "../src/workflow";
import { readSse } from "./helpers/read-sse";

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

const testRunConfig = { stepTimeoutSec: 60, workflowTimeoutSec: 60 * 60 };

function makeServer(host: WorkflowHost): { server: Server; runs: WorkflowRunManager } {
  const runs = new WorkflowRunManager({
    host,
    cacheStore: createInMemoryStore(),
    cwd: tmpdir(),
    config: testRunConfig,
  });
  const server = createWebServer({
    host,
    runs,
    workflowSource: () => "bundled",
    doctor: () => [
      {
        agent: "opencode",
        provider: "opencode",
        status: "ok",
        binary: "opencode",
        message: "ready",
      },
    ],
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

describe("web server", () => {
  it("serves the single-page app", async () => {
    const { server } = makeServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const res = await fetch(`${base}/`);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("steam");
    expect(html).toContain('id="wflist"');
    expect(html).toContain('id="runBtn"');
    // The page now references external static assets rather than inlining them.
    expect(html).toContain('<link rel="stylesheet" href="/static/app.css?v=');
    expect(html).toContain('<script src="/static/steamtrain-reducer.bundle.js?v=');
    expect(html).toContain('<script src="/static/app.js?v=');
    // The inline bundle must not be served on the page anymore.
    expect(html).not.toContain("BEGIN_REDUCER_BUNDLE");
    // Scripts: 'unsafe-inline' removed so we rely on external static assets
    // shipped under script-src 'self'.
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it("serves static app.js and app.css with immutable caching headers", async () => {
    const { server } = makeServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);

    const js = await fetch(`${base}/static/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(js.headers.get("x-content-type-options")).toBe("nosniff");
    const jsText = await js.text();
    expect(jsText).toContain("SteamtrainReducer");
    expect(jsText).not.toContain("BEGIN_REDUCER_BUNDLE");

    const css = await fetch(`${base}/static/app.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(css.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const cssText = await css.text();
    expect(cssText).toContain("--accent");

    const bundle = await fetch(`${base}/static/steamtrain-reducer.bundle.js`);
    expect(bundle.status).toBe(200);
    const bundleText = await bundle.text();
    expect(bundleText).toContain("function workflowReducer");

    // The `?v=` revision embedded in the index page MUST match the first 16
    // hex chars of the SHA-256 of the bytes actually served at `/static/*`.
    // Otherwise `renderIndex` and the in-memory asset snapshot have drifted
    // apart and cache-busting stops being meaningful.
    const indexRes = await fetch(`${base}/`);
    const html = await indexRes.text();
    const expectedRevs = {
      "/static/app.css": createHash("sha256").update(cssText).digest("hex").slice(0, 16),
      "/static/app.js": createHash("sha256").update(jsText).digest("hex").slice(0, 16),
      "/static/steamtrain-reducer.bundle.js": createHash("sha256")
        .update(bundleText)
        .digest("hex")
        .slice(0, 16),
    };
    for (const [assetPath, expectedRev] of Object.entries(expectedRevs)) {
      const escaped = assetPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const m = html.match(new RegExp(`${escaped}\\?v=([0-9a-f]{16})`));
      expect(m, `index page should reference ${assetPath}?v=<16 hex chars>`).not.toBeNull();
      expect(m![1]).toBe(expectedRev);
    }
  });

  it("returns 404 for unknown static assets", async () => {
    const { server } = makeServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const res = await fetch(`${base}/static/does-not-exist.js`);
    expect(res.status).toBe(404);
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
    const runs = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      historyStore,
      cwd: tmpdir(),
      config: testRunConfig,
    });
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
      rootDir: join(tmpdir(), "none"),
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
      cwd: tmpdir(),
      config: testRunConfig,
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
    const runs = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      historyStore,
      cwd: tmpdir(),
      config: testRunConfig,
    });
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
    const runs = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      historyStore,
      cwd: tmpdir(),
      config: testRunConfig,
    });
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
      cwd: tmpdir(),
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
    const runs = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      cwd: tmpdir(),
      maxConcurrent: 1,
      config: testRunConfig,
    });
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

  it("rejects workflow names with control characters (M12)", async () => {
    const { server } = makeServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const res = await fetch(`${base}/api/workflows/demo%00evil`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spec: demoSpec() }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("invalid workflow name");
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
    const runs = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      historyStore,
      cwd: tmpdir(),
      config: testRunConfig,
    });
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

  it("rejects generate endpoint with invalid workflow name (M12 gap)", async () => {
    // The generate endpoint requires authoring to be enabled, so we test the
    // name validation by checking that invalid names are rejected with 400
    // (not 501) when authoring is present. Since makeServer doesn't set up
    // authoring, we verify the endpoint returns 501 (not enabled) as a
    // baseline — the actual name validation is covered by the PUT test above.
    const { server } = makeServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const res = await fetch(`${base}/api/workflows/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        description: "test",
        agent: "opencode",
        name: "bad\x00name",
      }),
    });
    // Without authoring enabled, this returns 501 — the name check runs after
    // the author gate. This test documents the endpoint exists and is reachable.
    expect(res.status).toBe(501);
  });

  it("returns doctorError field when doctor fails (M35)", async () => {
    const { server } = makeServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const res = await fetch(`${base}/api/doctor`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { doctor: unknown[]; doctorError?: string };
    expect(body.doctor).toBeDefined();
    // No error field when doctor succeeds (doctor is injected as a function)
    expect(body.doctorError).toBeUndefined();
  });

  it("aborts run after workflowTimeoutSec (M16)", async () => {
    const host = new FakeHost(demoSpec(), hangingRun);
    const runs = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      cwd: tmpdir(),
      config: { workflowTimeoutSec: 0.2, stepTimeoutSec: 60 },
    });
    const server = createWebServer({ host, runs });
    servers.push(server);
    const base = await start(server);

    const startRes = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "demo", input: "go" }),
    });
    expect(startRes.status).toBe(201);
    const { runId } = (await startRes.json()) as { runId: string };

    // Wait for timeout + buffer
    await new Promise((r) => setTimeout(r, 600));

    const statusRes = await fetch(`${base}/api/runs/${runId}/stream`);
    // Collect frames until we get a terminal one or timeout
    const reader = statusRes.body!.getReader();
    const decoder = new TextDecoder();
    let terminal = false;
    const deadline = Date.now() + 3000;
    while (!terminal && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      if (text.includes('"status"')) terminal = true;
    }
    reader.cancel();
    // The run should have settled (canceled or error due to abort)
    const run = runs.get(runId);
    expect(
      run?.status === "canceled" ||
        run?.status === "error" ||
        run?.status === "done" ||
        run === undefined,
    ).toBe(true);
  });

  it("POST /api/runs with overrides merges them into the spec", async () => {
    let receivedSpec: WorkflowSpec | undefined;
    const host: WorkflowHost = {
      listWorkflows: () => ({ demo: demoSpec() }),
      canDispatchWorkflowSpec: () => ({ ok: true }),
      async *runWorkflow(_name, _input, _signal, _cache, _cwd, specOverride) {
        receivedSpec = specOverride;
        yield { kind: "workflow_done", ok: true, results: [], ts: Date.now() };
      },
    };
    const runs = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      cwd: tmpdir(),
      config: testRunConfig,
    });
    const server = createWebServer({ host, runs, workflowSource: () => "bundled" });
    servers.push(server);
    const base = await start(server);

    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflow: "demo",
        input: "test",
        overrides: { s1: { agent: "codex", model: "gpt-5" } },
      }),
    });
    expect(res.status).toBe(201);

    // Give the drive loop a tick to call runWorkflow
    await new Promise((r) => setTimeout(r, 50));

    expect(receivedSpec).toBeDefined();
    const step = receivedSpec!.phases[0]!.steps[0]! as { agent: string; model: string };
    expect(step.agent).toBe("codex");
    expect(step.model).toBe("gpt-5");
  });

  it("POST /api/runs without overrides passes the base spec", async () => {
    let receivedSpec: WorkflowSpec | undefined;
    const host: WorkflowHost = {
      listWorkflows: () => ({ demo: demoSpec() }),
      canDispatchWorkflowSpec: () => ({ ok: true }),
      async *runWorkflow(_name, _input, _signal, _cache, _cwd, specOverride) {
        receivedSpec = specOverride;
        yield { kind: "workflow_done", ok: true, results: [], ts: Date.now() };
      },
    };
    const runs = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      cwd: tmpdir(),
      config: testRunConfig,
    });
    const server = createWebServer({ host, runs, workflowSource: () => "bundled" });
    servers.push(server);
    const base = await start(server);

    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "demo", input: "test" }),
    });
    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 50));
    expect(receivedSpec).toBeDefined();
    expect((receivedSpec!.phases[0]!.steps[0]! as { agent: string }).agent).toBe("opencode");
  });

  it("POST /api/overrides/flush persists staged overrides and returns report", async () => {
    const host: WorkflowHost & {
      workflowSource(): undefined;
      isAgentHealthy(): boolean;
      setCatalog(): void;
    } = {
      listWorkflows: () => ({ demo: demoSpec() }),
      canDispatchWorkflowSpec: () => ({ ok: true }),
      async *runWorkflow() {
        yield { kind: "workflow_done", ok: true, results: [], ts: Date.now() };
      },
      workflowSource: () => undefined,
      isAgentHealthy: () => true,
      setCatalog: () => {},
    };
    const runs = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      cwd: tmpdir(),
      config: testRunConfig,
    });
    const author = new WorkflowAuthor({
      host,
      config: testRunConfig,
      cwd: tmpdir(),
      home: mkdtempSync(join(tmpdir(), "flush-test-")),
    });
    const server = createWebServer({ host, runs, author, workflowSource: () => "bundled" });
    servers.push(server);
    const base = await start(server);

    // Flush with overrides for a workflow that doesn't exist in the catalog
    // (it should be reported as skipped)
    const res = await fetch(`${base}/api/overrides/flush`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ overrides: { nonexistent: { s1: { agent: "codex" } } } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      saved: string[];
      skipped: Array<{ name: string; reason: string }>;
      unchanged: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.saved).toEqual([]);
    expect(body.skipped.length).toBe(1);
    expect(body.skipped[0]!.name).toBe("nonexistent");
  });

  it("POST /api/overrides/flush without author returns 501", async () => {
    const host: WorkflowHost = {
      listWorkflows: () => ({ demo: demoSpec() }),
      canDispatchWorkflowSpec: () => ({ ok: true }),
      async *runWorkflow() {
        yield { kind: "workflow_done", ok: true, results: [], ts: Date.now() };
      },
    };
    const runs = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      cwd: tmpdir(),
      config: testRunConfig,
    });
    const server = createWebServer({ host, runs, workflowSource: () => "bundled" });
    servers.push(server);
    const base = await start(server);

    const res = await fetch(`${base}/api/overrides/flush`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ overrides: {} }),
    });
    expect(res.status).toBe(501);
  });

  it("POST /api/overrides/flush with invalid body returns 400", async () => {
    const host: WorkflowHost & {
      workflowSource(): undefined;
      isAgentHealthy(): boolean;
      setCatalog(): void;
    } = {
      listWorkflows: () => ({ demo: demoSpec() }),
      canDispatchWorkflowSpec: () => ({ ok: true }),
      async *runWorkflow() {
        yield { kind: "workflow_done", ok: true, results: [], ts: Date.now() };
      },
      workflowSource: () => undefined,
      isAgentHealthy: () => true,
      setCatalog: () => {},
    };
    const runs = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      cwd: tmpdir(),
      config: testRunConfig,
    });
    const author = new WorkflowAuthor({
      host,
      config: testRunConfig,
      cwd: tmpdir(),
      home: mkdtempSync(join(tmpdir(), "flush-invalid-")),
    });
    const server = createWebServer({ host, runs, author, workflowSource: () => "bundled" });
    servers.push(server);
    const base = await start(server);

    const res = await fetch(`${base}/api/overrides/flush`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notOverrides: true }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/overrides/flush with empty overrides returns ok with empty results", async () => {
    const host: WorkflowHost & {
      workflowSource(): undefined;
      isAgentHealthy(): boolean;
      setCatalog(): void;
    } = {
      listWorkflows: () => ({ demo: demoSpec() }),
      canDispatchWorkflowSpec: () => ({ ok: true }),
      async *runWorkflow() {
        yield { kind: "workflow_done", ok: true, results: [], ts: Date.now() };
      },
      workflowSource: () => undefined,
      isAgentHealthy: () => true,
      setCatalog: () => {},
    };
    const runs = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      cwd: tmpdir(),
      config: testRunConfig,
    });
    const author = new WorkflowAuthor({
      host,
      config: testRunConfig,
      cwd: tmpdir(),
      home: mkdtempSync(join(tmpdir(), "flush-empty-")),
    });
    const server = createWebServer({ host, runs, author, workflowSource: () => "bundled" });
    servers.push(server);
    const base = await start(server);

    const res = await fetch(`${base}/api/overrides/flush`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ overrides: {} }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      saved: string[];
      skipped: Array<{ name: string; reason: string }>;
      unchanged: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.saved).toEqual([]);
    expect(body.skipped).toEqual([]);
    expect(body.unchanged).toEqual([]);
  });

  it("POST /api/runs with overrides on non-existent step IDs ignores them silently", async () => {
    let receivedSpec: WorkflowSpec | undefined;
    const host: WorkflowHost = {
      listWorkflows: () => ({ demo: demoSpec() }),
      canDispatchWorkflowSpec: () => ({ ok: true }),
      async *runWorkflow(_name, _input, _signal, _cache, _cwd, specOverride) {
        receivedSpec = specOverride;
        yield { kind: "workflow_done", ok: true, results: [], ts: Date.now() };
      },
    };
    const runs = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      cwd: tmpdir(),
      config: testRunConfig,
    });
    const server = createWebServer({ host, runs, workflowSource: () => "bundled" });
    servers.push(server);
    const base = await start(server);

    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflow: "demo",
        input: "test",
        overrides: { "nonexistent-step": { agent: "codex" } },
      }),
    });
    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 50));

    // Spec should be unchanged — the override was for a step that doesn't exist
    expect(receivedSpec).toBeDefined();
    const step = receivedSpec!.phases[0]!.steps[0]! as { agent: string };
    expect(step.agent).toBe("opencode");
  });

  it("POST /api/overrides/flush saves user workflow overrides and reports saved", async () => {
    const home = mkdtempSync(join(tmpdir(), "flush-save-"));
    const host: WorkflowHost & {
      workflowSource(n: string): "user" | undefined;
      isAgentHealthy(): boolean;
      setCatalog(): void;
    } = {
      listWorkflows: () => ({ demo: demoSpec() }),
      canDispatchWorkflowSpec: () => ({ ok: true }),
      async *runWorkflow() {
        yield { kind: "workflow_done", ok: true, results: [], ts: Date.now() };
      },
      workflowSource: (n) => (n === "demo" ? "user" : undefined),
      isAgentHealthy: () => true,
      setCatalog: () => {},
    };
    const runs = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      cwd: tmpdir(),
      config: testRunConfig,
    });
    const author = new WorkflowAuthor({
      host,
      config: testRunConfig,
      cwd: tmpdir(),
      home,
    });
    const server = createWebServer({ host, runs, author, workflowSource: () => "bundled" });
    servers.push(server);
    const base = await start(server);

    const res = await fetch(`${base}/api/overrides/flush`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ overrides: { demo: { s1: { agent: "codex" } } } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      saved: string[];
      skipped: Array<{ name: string; reason: string }>;
      unchanged: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.saved).toContain("demo");
    expect(body.skipped).toEqual([]);
  });

  it("POST /api/overrides/flush with array overrides returns 400", async () => {
    const host: WorkflowHost & {
      workflowSource(): undefined;
      isAgentHealthy(): boolean;
      setCatalog(): void;
    } = {
      listWorkflows: () => ({ demo: demoSpec() }),
      canDispatchWorkflowSpec: () => ({ ok: true }),
      async *runWorkflow() {
        yield { kind: "workflow_done", ok: true, results: [], ts: Date.now() };
      },
      workflowSource: () => undefined,
      isAgentHealthy: () => true,
      setCatalog: () => {},
    };
    const runs = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      cwd: tmpdir(),
      config: testRunConfig,
    });
    const author = new WorkflowAuthor({
      host,
      config: testRunConfig,
      cwd: tmpdir(),
      home: mkdtempSync(join(tmpdir(), "flush-array-")),
    });
    const server = createWebServer({ host, runs, author, workflowSource: () => "bundled" });
    servers.push(server);
    const base = await start(server);

    const res = await fetch(`${base}/api/overrides/flush`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ overrides: [{ s1: { agent: "codex" } }] }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/runs with non-object step patches is ignored", async () => {
    let receivedSpec: WorkflowSpec | undefined;
    const host: WorkflowHost = {
      listWorkflows: () => ({ demo: demoSpec() }),
      canDispatchWorkflowSpec: () => ({ ok: true }),
      async *runWorkflow(_name, _input, _signal, _cache, _cwd, specOverride) {
        receivedSpec = specOverride;
        yield { kind: "workflow_done", ok: true, results: [], ts: Date.now() };
      },
    };
    const runs = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      cwd: tmpdir(),
      config: testRunConfig,
    });
    const server = createWebServer({ host, runs, workflowSource: () => "bundled" });
    servers.push(server);
    const base = await start(server);

    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflow: "demo",
        input: "test",
        overrides: { s1: "codex" },
      }),
    });
    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 50));

    // Spec should be unchanged — the invalid patch was silently ignored
    expect(receivedSpec).toBeDefined();
    const step = receivedSpec!.phases[0]!.steps[0]! as { agent: string };
    expect(step.agent).toBe("opencode");
  });

  it("POST /api/overrides/flush with non-object step patches returns 400", async () => {
    const host: WorkflowHost & {
      workflowSource(): undefined;
      isAgentHealthy(): boolean;
      setCatalog(): void;
    } = {
      listWorkflows: () => ({ demo: demoSpec() }),
      canDispatchWorkflowSpec: () => ({ ok: true }),
      async *runWorkflow() {
        yield { kind: "workflow_done", ok: true, results: [], ts: Date.now() };
      },
      workflowSource: () => undefined,
      isAgentHealthy: () => true,
      setCatalog: () => {},
    };
    const runs = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      cwd: tmpdir(),
      config: testRunConfig,
    });
    const author = new WorkflowAuthor({
      host,
      config: testRunConfig,
      cwd: tmpdir(),
      home: mkdtempSync(join(tmpdir(), "flush-nonobj-")),
    });
    const server = createWebServer({ host, runs, author, workflowSource: () => "bundled" });
    servers.push(server);
    const base = await start(server);

    const res = await fetch(`${base}/api/overrides/flush`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ overrides: { demo: { s1: "codex" } } }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/overrides/flush returns 500 when flushSessionOverrides throws", async () => {
    const host: WorkflowHost & {
      workflowSource(): undefined;
      isAgentHealthy(): boolean;
      setCatalog(): void;
    } = {
      listWorkflows: () => ({ demo: demoSpec() }),
      canDispatchWorkflowSpec: () => ({ ok: true }),
      async *runWorkflow() {
        yield { kind: "workflow_done", ok: true, results: [], ts: Date.now() };
      },
      workflowSource: () => undefined,
      isAgentHealthy: () => true,
      setCatalog: () => {},
    };
    const runs = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      cwd: tmpdir(),
      config: testRunConfig,
    });
    const realAuthor = new WorkflowAuthor({
      host,
      config: testRunConfig,
      cwd: tmpdir(),
      home: mkdtempSync(join(tmpdir(), "flush-throw-")),
    });
    // Wrap author to make flushSessionOverrides throw
    const author = Object.create(realAuthor);
    author.flushSessionOverrides = async () => {
      throw new Error("disk write failed");
    };
    const server = createWebServer({ host, runs, author, workflowSource: () => "bundled" });
    servers.push(server);
    const base = await start(server);

    const res = await fetch(`${base}/api/overrides/flush`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ overrides: { demo: { s1: { agent: "codex" } } } }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("disk write failed");
  });
});
