import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { type WorkflowHost, WorkflowRunManager } from "../src/web/runs";
import { createWebServer } from "../src/web/server";
import type {
  HumanInputProvider,
  HumanInputResponse,
  StepResult,
  WorkflowCacheStore,
  WorkflowEvent,
  WorkflowSpec,
} from "../src/workflow";
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

const humanSpec: WorkflowSpec = {
  name: "human-demo",
  phases: [
    { id: "p1", title: "Ask", steps: [{ id: "ask", kind: "human", prompt: "what color?" }] },
  ],
};

/** A host whose runWorkflow pauses on a human-input request, awaiting the provider. */
class HumanInputHost implements WorkflowHost {
  constructor(private readonly onResponse?: (response: HumanInputResponse) => void) {}
  listWorkflows(): Record<string, WorkflowSpec> {
    return { [humanSpec.name]: humanSpec };
  }
  canDispatchWorkflowSpec(): { ok: true } | { ok: false; reason: string } {
    return { ok: true };
  }
  runWorkflow(
    _name: string,
    _input: string,
    signal?: AbortSignal,
    _cache?: Map<string, StepResult>,
    _cwd?: string,
    _spec?: WorkflowSpec,
    _inputs?: Record<string, string | number | boolean>,
    _approval?: unknown,
    _control?: unknown,
    humanInput?: HumanInputProvider,
  ): AsyncIterable<WorkflowEvent> {
    const onResponse = this.onResponse;
    return (async function* () {
      const ts = () => Date.now();
      yield { kind: "workflow_start", name: "human-demo", phaseCount: 1, stepCount: 1, ts: ts() };
      yield { kind: "phase_start", phaseId: "p1", title: "Ask", index: 0, stepCount: 1, ts: ts() };
      yield { kind: "step_start", phaseId: "p1", stepId: "ask", blockKind: "human", ts: ts() };
      yield {
        kind: "human_input_pending",
        phaseId: "p1",
        stepId: "ask",
        attempt: 1,
        prompt: "what color?",
        origin: "human-step",
        iteration: 1,
        ts: ts(),
      };
      const response: HumanInputResponse = humanInput
        ? await humanInput(
            {
              stepId: "ask",
              phaseId: "p1",
              iteration: 1,
              attempt: 1,
              prompt: "what color?",
              origin: "human-step",
            },
            signal,
          )
        : { canceled: true };
      onResponse?.(response);
      const ok = !response.canceled;
      yield {
        kind: "human_input_resolved",
        phaseId: "p1",
        stepId: "ask",
        value: response.canceled ? undefined : response.value,
        by: response.by,
        canceled: response.canceled || undefined,
        origin: "human-step",
        iteration: 1,
        ts: ts(),
      };
      const result: StepResult = {
        stepId: "ask",
        ok,
        output: response.canceled ? "canceled" : response.value,
        durationMs: 1,
      };
      yield { kind: "step_done", phaseId: "p1", stepId: "ask", result, cached: false, ts: ts() };
      yield { kind: "phase_done", phaseId: "p1", ok, ts: ts() };
      yield { kind: "workflow_done", ok, results: [result], ts: ts() };
    })();
  }
}

function makeServer(onResponse?: (r: HumanInputResponse) => void): { server: Server } {
  const host = new HumanInputHost(onResponse);
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
  return { server };
}

async function start(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("web human-input endpoint", () => {
  it("answers a pending request via POST /api/runs/:id/input", async () => {
    let captured: HumanInputResponse | undefined;
    const { server } = makeServer((r) => {
      captured = r;
    });
    const base = await start(server);

    const startRes = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "human-demo", input: "go" }),
    });
    expect(startRes.status).toBe(201);
    const { runId } = (await startRes.json()) as { runId: string };

    let listedPending:
      | {
          stepId: string;
          iteration: number;
          attempt: number;
          origin?: string;
          prompt?: string;
          choices?: string[];
        }[]
      | undefined;
    for (let i = 0; i < 250 && !listedPending; i++) {
      const list = (await (await fetch(`${base}/api/runs`)).json()) as {
        runs: {
          id: string;
          pendingInputs?: {
            stepId: string;
            iteration: number;
            attempt: number;
            origin?: string;
            prompt?: string;
            choices?: string[];
          }[];
        }[];
      };
      listedPending = list.runs.find((run) => run.id === runId)?.pendingInputs;
      if (!listedPending) await delay(20);
    }
    expect(listedPending).toEqual([
      {
        stepId: "ask",
        iteration: 1,
        attempt: 1,
        origin: "human-step",
        prompt: "what color?",
      },
    ]);

    const streamRes = await fetch(`${base}/api/runs/${runId}/stream`);
    const framesP = readSseFromResponse(streamRes);

    let resolved = false;
    for (let i = 0; i < 50 && !resolved; i++) {
      const res = await fetch(`${base}/api/runs/${runId}/input`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stepId: "ask", value: "green" }),
      });
      const body = (await res.json()) as { resolved?: boolean };
      resolved = res.status === 200 && body.resolved === true;
      if (!resolved) await delay(20);
    }
    expect(resolved).toBe(true);
    expect(captured).toMatchObject({ value: "green", by: "human:web" });

    const frames = await framesP;
    const pending = frames.find(
      (f) => f.type === "event" && (f.event as WorkflowEvent).kind === "human_input_pending",
    );
    const done = frames.find((f) => f.type === "status");
    expect(pending).toBeDefined();
    expect(done).toMatchObject({ status: "done", ok: true });

    const settledList = (await (await fetch(`${base}/api/runs`)).json()) as {
      runs: { id: string; pendingInputs?: unknown[] }[];
    };
    expect(settledList.runs.find((run) => run.id === runId)?.pendingInputs).toBeUndefined();
  });

  it("rejects a blank value and unknown runs", async () => {
    const { server } = makeServer();
    const base = await start(server);
    const missing = await fetch(`${base}/api/runs/nope/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stepId: "ask", value: "x" }),
    });
    expect(missing.status).toBe(404);

    const startRes = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "human-demo", input: "go" }),
    });
    const { runId } = (await startRes.json()) as { runId: string };
    const blank = await fetch(`${base}/api/runs/${runId}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stepId: "ask", value: "   " }),
    });
    expect(blank.status).toBe(400);
    await fetch(`${base}/api/runs/${runId}/cancel`, { method: "POST" });
  });
});
