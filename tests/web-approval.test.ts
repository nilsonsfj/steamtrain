import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { type WorkflowHost, WorkflowRunManager } from "../src/web/runs";
import { createWebServer } from "../src/web/server";
import type {
  ApprovalProvider,
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

const approvalSpec: WorkflowSpec = {
  name: "approve-demo",
  phases: [{ id: "p1", title: "Approve", steps: [{ id: "chk", kind: "approval", prompt: "ok?" }] }],
};

/** A host whose runWorkflow pauses on an approval, awaiting the injected provider. */
class ApprovalHost implements WorkflowHost {
  listWorkflows(): Record<string, WorkflowSpec> {
    return { [approvalSpec.name]: approvalSpec };
  }
  canDispatchWorkflowSpec(): { ok: true } | { ok: false; reason: string } {
    return { ok: true };
  }
  runWorkflow(
    _name: string,
    _input: string,
    _signal?: AbortSignal,
    _cache?: Map<string, StepResult>,
    _cwd?: string,
    _spec?: WorkflowSpec,
    _inputs?: Record<string, string | number | boolean>,
    approval?: ApprovalProvider,
  ): AsyncIterable<WorkflowEvent> {
    return (async function* () {
      const ts = () => Date.now();
      yield { kind: "workflow_start", name: "approve-demo", phaseCount: 1, stepCount: 1, ts: ts() };
      yield {
        kind: "phase_start",
        phaseId: "p1",
        title: "Approve",
        index: 0,
        stepCount: 1,
        ts: ts(),
      };
      yield { kind: "step_start", phaseId: "p1", stepId: "chk", blockKind: "approval", ts: ts() };
      yield {
        kind: "approval_pending",
        phaseId: "p1",
        stepId: "chk",
        message: "ok?",
        onReject: "fail",
        iteration: 1,
        ts: ts(),
      };
      const decision = approval
        ? await approval({ stepId: "chk", phaseId: "p1", iteration: 1, onReject: "fail" }, _signal)
        : { approved: false };
      yield {
        kind: "approval_resolved",
        phaseId: "p1",
        stepId: "chk",
        approved: decision.approved,
        by: decision.by,
        note: decision.note,
        iteration: 1,
        ts: ts(),
      };
      const result: StepResult = {
        stepId: "chk",
        ok: decision.approved,
        output: decision.approved ? "approved" : "rejected",
        gate: { passed: decision.approved, onFalse: "fail" },
        durationMs: 1,
      };
      yield { kind: "step_done", phaseId: "p1", stepId: "chk", result, cached: false, ts: ts() };
      yield { kind: "phase_done", phaseId: "p1", ok: decision.approved, ts: ts() };
      yield { kind: "workflow_done", ok: decision.approved, results: [result], ts: ts() };
    })();
  }
}

function makeServer(): { server: Server; runs: WorkflowRunManager } {
  const host = new ApprovalHost();
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
  return { server, runs };
}

async function start(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("web approval endpoint", () => {
  it("resolves a pending checkpoint via POST /api/runs/:id/approval", async () => {
    const { server } = makeServer();
    const base = await start(server);

    const startRes = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "approve-demo", input: "go" }),
    });
    expect(startRes.status).toBe(201);
    const { runId } = (await startRes.json()) as { runId: string };

    // Read the SSE stream to completion in the background.
    const streamRes = await fetch(`${base}/api/runs/${runId}/stream`);
    const framesP = readSseFromResponse(streamRes);

    // Poll the approval endpoint until the checkpoint has registered.
    let resolved = false;
    for (let i = 0; i < 50 && !resolved; i++) {
      const res = await fetch(`${base}/api/runs/${runId}/approval`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stepId: "chk", approved: true }),
      });
      const body = (await res.json()) as { resolved?: boolean };
      resolved = res.status === 200 && body.resolved === true;
      if (!resolved) await delay(20);
    }
    expect(resolved).toBe(true);

    const frames = await framesP;
    const pending = frames.find(
      (f) => f.type === "event" && (f.event as WorkflowEvent).kind === "approval_pending",
    );
    const done = frames.find((f) => f.type === "status");
    expect(pending).toBeDefined();
    expect(done).toMatchObject({ status: "done", ok: true });
  });

  it("returns 404 for an unknown run", async () => {
    const { server } = makeServer();
    const base = await start(server);
    const res = await fetch(`${base}/api/runs/nope/approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stepId: "chk", approved: true }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects a malformed approval body", async () => {
    const { server } = makeServer();
    const base = await start(server);
    const startRes = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "approve-demo", input: "go" }),
    });
    const { runId } = (await startRes.json()) as { runId: string };
    const res = await fetch(`${base}/api/runs/${runId}/approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stepId: "chk" }),
    });
    expect(res.status).toBe(400);
    // Clean up: cancel the still-pending run.
    await fetch(`${base}/api/runs/${runId}/cancel`, { method: "POST" });
  });
});
