import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunOptions } from "../src/agents";
import type { AgentEvent, AgentId } from "../src/types/events";
import { type WorkflowHost, WorkflowRunManager } from "../src/web/runs";
import { createWebServer } from "../src/web/server";
import type {
  ApprovalProvider,
  StepResult,
  WorkflowCacheStore,
  WorkflowEvent,
  WorkflowRunControl,
  WorkflowSpec,
} from "../src/workflow";
import { runWorkflow } from "../src/workflow";
import { readSseFromResponse } from "./helpers/read-sse";

const servers: Server[] = [];

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop()!;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function createInMemoryStore(): WorkflowCacheStore {
  const store = new Map<string, Map<string, StepResult>>();
  return {
    rootDir: "/memory",
    async load(key) {
      return new Map(store.get(JSON.stringify(key)) ?? new Map());
    },
    async save(key, cache) {
      store.set(JSON.stringify(key), new Map(cache));
    },
    async clear(key) {
      store.delete(JSON.stringify(key));
    },
    async clearAll() {
      store.clear();
    },
  };
}

const chainSpec: WorkflowSpec = {
  name: "steer-demo",
  phases: [
    {
      id: "p1",
      title: "P1",
      steps: [{ id: "a", agent: "claude", model: "ma", prompt: "{{input}}" }],
    },
    {
      id: "p2",
      title: "P2",
      steps: [
        { id: "b", agent: "claude", model: "mb", dependsOn: ["a"], prompt: "b:{{steps.a.output}}" },
      ],
    },
  ],
};

interface HostState {
  prompts: string[];
  /** Step "a" blocks until this resolves, so the test can steer deterministically. */
  releaseA: () => void;
}

/** A host that runs the REAL engine over a gated fake adapter. */
function makeEngineHost(): { host: WorkflowHost; state: HostState } {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state: HostState = { prompts: [], releaseA: () => release() };
  const createAdapter = (id: AgentId): AgentAdapter => ({
    id,
    binary: "fake",
    defaultModel: "test",
    run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
      return (async function* () {
        state.prompts.push(opts.prompt);
        if (opts.model === "ma") await gate;
        yield { kind: "session_start", agent: "claude", ts: 0 } as AgentEvent;
        yield {
          kind: "result",
          agent: "claude",
          ts: 0,
          isError: false,
          text: `out:${opts.prompt}`,
        } as AgentEvent;
      })();
    },
  });
  const host: WorkflowHost = {
    listWorkflows() {
      return { [chainSpec.name]: chainSpec };
    },
    canDispatchWorkflowSpec() {
      return { ok: true };
    },
    runWorkflow(
      _name: string,
      input: string,
      signal?: AbortSignal,
      cache?: Map<string, StepResult>,
      cwd?: string,
      _spec?: WorkflowSpec,
      _inputs?: Record<string, string | number | boolean>,
      _approval?: ApprovalProvider,
      control?: WorkflowRunControl,
    ): AsyncIterable<WorkflowEvent> {
      return runWorkflow(
        chainSpec,
        { input, cache },
        { createAdapter, maxConcurrency: 2, cwd: cwd ?? "/", control },
        signal,
      );
    },
  };
  return { host, state };
}

function makeServer(): { server: Server; state: HostState } {
  const { host, state } = makeEngineHost();
  const runs = new WorkflowRunManager({
    host,
    cacheStore: createInMemoryStore(),
    cwd: tmpdir(),
    config: { stepTimeoutSec: 60, workflowTimeoutSec: 3600 },
  });
  const server = createWebServer({
    host,
    runs,
    workflowSource: () => "bundled",
    doctor: () => [],
    configLabel: "test",
  });
  servers.push(server);
  return { server, state };
}

async function start(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(base: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("web mid-run steering endpoints", () => {
  it("pause → edit-step → resume steers a live run end to end", async () => {
    const { server, state } = makeServer();
    const base = await start(server);

    const started = await post(base, "/api/runs", { workflow: "steer-demo", input: "hi" });
    expect(started.status).toBe(201);
    const runId = started.body.runId as string;

    const streamRes = await fetch(`${base}/api/runs/${runId}/stream`);
    const framesP = readSseFromResponse(streamRes);

    // Wait until step "a" is in flight (blocked on the gate), then pause.
    for (let i = 0; i < 100 && state.prompts.length === 0; i++) await delay(10);
    expect(state.prompts).toEqual(["hi"]);
    const paused = await post(base, `/api/runs/${runId}/pause`);
    expect(paused).toMatchObject({ status: 200, body: { requested: true, paused: true } });

    // The run registry reflects the requested pause immediately.
    const listed = (await (await fetch(`${base}/api/runs`)).json()) as {
      runs: { id: string; paused?: boolean }[];
    };
    expect(listed.runs.find((r) => r.id === runId)?.paused).toBe(true);

    // Pending step "b" can be edited while paused; the engine validates.
    const edited = await post(base, `/api/runs/${runId}/edit-step`, {
      stepId: "b",
      prompt: "EDITED:{{steps.a.output}}",
    });
    expect(edited).toMatchObject({ status: 200, body: { applied: true } });

    // A started step is rejected with the engine's reason.
    const rejected = await post(base, `/api/runs/${runId}/edit-step`, {
      stepId: "a",
      prompt: "nope",
    });
    expect(rejected.status).toBe(400);
    expect(String(rejected.body.error)).toMatch(/already started/);

    // Let the in-flight step finish; the run parks paused, then resume it.
    state.releaseA();
    await delay(50);
    const resumed = await post(base, `/api/runs/${runId}/resume`);
    expect(resumed).toMatchObject({ status: 200, body: { requested: true, paused: false } });

    const frames = await framesP;
    const eventKinds = frames
      .filter((f) => f.type === "event")
      .map((f) => (f.event as WorkflowEvent).kind);
    expect(eventKinds).toContain("run_paused");
    expect(eventKinds).toContain("step_edited");
    expect(eventKinds).toContain("run_resumed");
    expect(frames.find((f) => f.type === "status")).toMatchObject({ status: "done", ok: true });

    // The edited prompt is what step "b" actually ran with.
    expect(state.prompts).toEqual(["hi", "EDITED:out:hi"]);
  });

  it("validates the edit body and 404s unknown runs", async () => {
    const { server, state } = makeServer();
    const base = await start(server);

    expect((await post(base, "/api/runs/nope/pause")).status).toBe(404);
    expect((await post(base, "/api/runs/nope/resume")).status).toBe(404);
    expect(
      (await post(base, "/api/runs/nope/edit-step", { stepId: "a", prompt: "x" })).status,
    ).toBe(404);

    const started = await post(base, "/api/runs", { workflow: "steer-demo", input: "hi" });
    const runId = started.body.runId as string;
    const streamRes = await fetch(`${base}/api/runs/${runId}/stream`);
    const framesP = readSseFromResponse(streamRes);

    const noStep = await post(base, `/api/runs/${runId}/edit-step`, { prompt: "x" });
    expect(noStep.status).toBe(400);
    const noFields = await post(base, `/api/runs/${runId}/edit-step`, { stepId: "b" });
    expect(noFields.status).toBe(400);
    // Editing without a pause is refused by the engine.
    const unpaused = await post(base, `/api/runs/${runId}/edit-step`, {
      stepId: "b",
      prompt: "x",
    });
    expect(unpaused.status).toBe(400);
    expect(String(unpaused.body.error)).toMatch(/pause the run/);

    state.releaseA();
    await framesP;
  });
});
