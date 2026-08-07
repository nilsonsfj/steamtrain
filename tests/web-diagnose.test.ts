import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/workflow/postmortem", () => ({
  diagnoseRun: vi.fn(),
}));

import { DEFAULT_CONFIG } from "../src/config/defaults";
import { type WorkflowHost, WorkflowRunManager } from "../src/web/runs";
import { createWebServer } from "../src/web/server";
import {
  type PostmortemResult,
  type StepResult,
  type WorkflowCacheStore,
  type WorkflowEvent,
  type WorkflowSpec,
  computeRunTotals,
  createWorkflowHistoryStore,
} from "../src/workflow";
import type { HistoryPhase, RunRecord } from "../src/workflow";
import { diagnoseRun } from "../src/workflow/postmortem";

const servers: Server[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  vi.mocked(diagnoseRun).mockReset();
  while (servers.length) {
    const server = servers.pop()!;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function demoSpec(): WorkflowSpec {
  return {
    name: "demo",
    phases: [
      {
        id: "p1",
        title: "Phase 1",
        steps: [{ id: "check", kind: "command", cmd: "npm test" }],
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
  listWorkflows(): Record<string, WorkflowSpec> {
    return { demo: demoSpec() };
  }
  canDispatchWorkflowSpec(): { ok: true } {
    return { ok: true };
  }
  runWorkflow(): AsyncIterable<WorkflowEvent> {
    return (async function* () {})();
  }
}

function failedRecord(): RunRecord {
  const phases: HistoryPhase[] = [
    {
      phaseId: "p1",
      title: "Phase 1",
      index: 0,
      stepCount: 1,
      done: true,
      ok: false,
      steps: [
        {
          stepId: "check",
          blockKind: "command",
          status: "error",
          text: "exit 1",
          cached: false,
          result: {
            stepId: "check",
            ok: false,
            output: "exit 1",
            error: "exit 1",
            exitCode: 1,
            durationMs: 2,
          },
        },
      ],
    },
  ];
  return {
    version: 1,
    id: "diag-run",
    workflow: "demo",
    input: "task",
    cwd: tmpdir(),
    status: "error",
    ok: false,
    startedAt: Date.now() - 1000,
    endedAt: Date.now(),
    durationMs: 1000,
    phases,
    totals: computeRunTotals(phases),
  };
}

async function makeDiagnoseServer(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "steamtrain-web-diagnose-"));
  tempRoots.push(root);
  const historyStore = createWorkflowHistoryStore(join(root, "history"));
  await historyStore.save(failedRecord());
  const host = new FakeHost();
  const runs = new WorkflowRunManager({
    host,
    cacheStore: createInMemoryStore(),
    historyStore,
    cwd: tmpdir(),
    config: DEFAULT_CONFIG,
  });
  const server = createWebServer({ host, runs, history: historyStore });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("POST /api/history/:id/diagnose", () => {
  it("returns the postmortem result on success", async () => {
    const diagnosis: PostmortemResult = {
      ok: true,
      diagnosis: {
        summary: "the test script is missing",
        category: "spec-bug",
        confidence: "high",
        rootStepId: "check",
      },
      api: "anthropic",
      model: "claude-sonnet-5",
      specDrift: false,
    };
    vi.mocked(diagnoseRun).mockResolvedValue(diagnosis);
    const base = await makeDiagnoseServer();
    const res = await fetch(`${base}/api/history/diag-run/diagnose`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PostmortemResult;
    expect(body.ok).toBe(true);
    if (body.ok) expect(body.diagnosis.category).toBe("spec-bug");
    // The route hands the record + resolved spec to the postmortem.
    const arg = vi.mocked(diagnoseRun).mock.calls[0]![0];
    expect(arg.record.id).toBe("diag-run");
    expect(arg.spec?.name).toBe("demo");
  });

  it("passes through api/model overrides from the body", async () => {
    vi.mocked(diagnoseRun).mockResolvedValue({ ok: false, error: "no key" });
    const base = await makeDiagnoseServer();
    await fetch(`${base}/api/history/diag-run/diagnose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api: "openai", model: "gpt-5.5" }),
    });
    const arg = vi.mocked(diagnoseRun).mock.calls[0]![0];
    expect(arg.api).toBe("openai");
    expect(arg.model).toBe("gpt-5.5");
  });

  it("returns ok:false (still 200) when the postmortem fails", async () => {
    vi.mocked(diagnoseRun).mockResolvedValue({ ok: false, error: "needs an API key" });
    const base = await makeDiagnoseServer();
    const res = await fetch(`${base}/api/history/diag-run/diagnose`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PostmortemResult;
    expect(body.ok).toBe(false);
    if (!body.ok) expect(body.error).toContain("API key");
  });

  it("404s on an unknown run", async () => {
    vi.mocked(diagnoseRun).mockResolvedValue({ ok: false, error: "unused" });
    const base = await makeDiagnoseServer();
    const res = await fetch(`${base}/api/history/nope/diagnose`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(vi.mocked(diagnoseRun)).not.toHaveBeenCalled();
  });

  it("400s on a non-string api field", async () => {
    vi.mocked(diagnoseRun).mockResolvedValue({ ok: false, error: "unused" });
    const base = await makeDiagnoseServer();
    const res = await fetch(`${base}/api/history/diag-run/diagnose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api: 42 }),
    });
    expect(res.status).toBe(400);
    expect(vi.mocked(diagnoseRun)).not.toHaveBeenCalled();
  });
});
