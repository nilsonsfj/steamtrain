import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DoctorResult } from "../src/doctor";
import { type WorkflowHost, WorkflowRunManager } from "../src/web/runs";
import { createWebServer } from "../src/web/server";
import type {
  HistoryPhase,
  RunRecord,
  RunRecordSummary,
  StepResult,
  WorkflowCacheStore,
  WorkflowEvent,
  WorkflowHistoryStore,
  WorkflowSpec,
} from "../src/workflow";
import { RUN_RECORD_VERSION, computeRunTotals, workflowCacheKey } from "../src/workflow";

const servers: Server[] = [];

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop()!;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await delay(10);
  }
}

function createInMemoryCacheStore(): WorkflowCacheStore {
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

function createInMemoryHistoryStore(): WorkflowHistoryStore {
  const records = new Map<string, RunRecord>();
  return {
    rootDir: "/memory-history",
    async save(record) {
      records.set(record.id, record);
    },
    async list(): Promise<RunRecordSummary[]> {
      return [...records.values()]
        .sort((a, b) => b.startedAt - a.startedAt)
        .map(({ phases: _phases, ...summary }) => summary);
    },
    async get(id) {
      return records.get(id);
    },
    async remove(id) {
      records.delete(id);
    },
    async clearAll() {
      records.clear();
    },
  };
}

const launchSpec: WorkflowSpec = {
  name: "launch-demo",
  phases: [
    {
      id: "p1",
      title: "Work",
      steps: [
        { id: "scan", kind: "worker", prompt: "scan", agent: "claude", model: "sonnet-latest" },
        { id: "report", kind: "worker", prompt: "report", agent: "north", model: "north-mini" },
      ],
    },
  ],
};

/** Records what the run manager hands the engine; runs finish immediately. */
class LaunchHost implements WorkflowHost {
  readonly launched: Array<{ maxConcurrency?: number }> = [];

  listWorkflows(): Record<string, WorkflowSpec> {
    return { [launchSpec.name]: launchSpec };
  }

  canDispatchWorkflowSpec(): { ok: true } | { ok: false; reason: string } {
    return { ok: true };
  }

  stepDispatchIssues(): Array<{ stepId: string; issue: string }> {
    return [{ stepId: "report", issue: "north needs auth" }];
  }

  runWorkflow(
    name: string,
    _input: string,
    _signal?: AbortSignal,
    _cache?: Map<string, StepResult>,
    _cwd?: string,
    _spec?: WorkflowSpec,
    _inputs?: Record<string, string | number | boolean>,
    _approval?: unknown,
    _control?: unknown,
    _humanInput?: unknown,
    maxConcurrency?: number,
  ): AsyncIterable<WorkflowEvent> {
    this.launched.push({ maxConcurrency });
    return (async function* () {
      yield { kind: "workflow_start", name, phaseCount: 1, stepCount: 2, ts: Date.now() };
      yield { kind: "workflow_done", ok: true, results: [], ts: Date.now() };
    })();
  }
}

const READY_DOCTOR: DoctorResult[] = [
  { agent: "claude", provider: "claude", status: "ok", binary: "claude", message: "ready" },
  {
    agent: "north",
    provider: "claude",
    status: "not_authenticated",
    binary: "north",
    message: "not logged in",
  },
];

/** A recorded run whose steps retained worktrees (roots need not exist). */
function keptWorktreeRecord(id: string, startedAt: number, stepIds: string[]): RunRecord {
  const phases: HistoryPhase[] = [
    {
      phaseId: "p1",
      title: "Work",
      index: 0,
      stepCount: stepIds.length,
      done: true,
      ok: true,
      steps: stepIds.map((stepId) => ({
        stepId,
        blockKind: "worker" as const,
        agent: "claude",
        status: "done" as const,
        text: "done",
        cached: false,
        worktree: {
          originalCwd: "/repo",
          cwd: `/wt/${id}/${stepId}`,
          root: join(tmpdir(), `st-launch-test-${id}-${stepId}`),
          branch: `steamtrain/${id}/${stepId}`,
          baseCommit: "abc123",
        },
      })),
    },
  ];
  return {
    version: RUN_RECORD_VERSION,
    id,
    workflow: launchSpec.name,
    input: "fix the bug",
    cwd: tmpdir(),
    status: "done",
    ok: true,
    startedAt,
    endedAt: startedAt + 10,
    durationMs: 10,
    phases,
    totals: computeRunTotals(phases),
  };
}

function makeServer(options?: {
  doctor?: DoctorResult[];
  history?: WorkflowHistoryStore;
  maxConcurrency?: number;
}): { server: Server; runs: WorkflowRunManager; host: LaunchHost; cacheStore: WorkflowCacheStore } {
  const host = new LaunchHost();
  const cacheStore = createInMemoryCacheStore();
  const runs = new WorkflowRunManager({
    host,
    cacheStore,
    cwd: tmpdir(),
    config: { maxConcurrency: options?.maxConcurrency ?? 5 },
    historyStore: options?.history,
  });
  const server = createWebServer({
    host,
    runs,
    history: options?.history,
    workflowSource: () => "bundled",
    doctor: () => options?.doctor ?? [],
    config: { maxConcurrency: options?.maxConcurrency ?? 5 },
    configLabel: "test",
  });
  servers.push(server);
  return { server, runs, host, cacheStore };
}

async function start(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("launch sheet predictions (plan endpoint `launch` block)", () => {
  it("reports cached steps, per-step issues, kept worktrees, and runner readiness", async () => {
    const history = createInMemoryHistoryStore();
    const { server, cacheStore } = makeServer({ doctor: READY_DOCTOR, history, maxConcurrency: 4 });
    const base = await start(server);

    // A prior run left two retained worktrees; a newer run was pruned (so the
    // kept one, though older, is the discard target).
    await history.save(keptWorktreeRecord("run-old", 1000, ["scan", "report"]));
    const pruned = keptWorktreeRecord("run-new", 2000, ["scan"]);
    pruned.harvest = { prunedAt: 2500 };
    await history.save(pruned);

    // The manager's cache holds a result for `scan` under this launch shape.
    await cacheStore.save(
      workflowCacheKey(launchSpec.name, "fix the bug", tmpdir(), launchSpec),
      new Map([["scan", { stepId: "scan", ok: true, output: "cached", durationMs: 1 }]]),
    );

    const res = await postJson(`${base}/api/workflows/${launchSpec.name}/plan`, {
      input: "fix the bug",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      launch?: {
        cachedSteps: string[];
        stepIssues: Array<{ stepId: string; issue: string }>;
        worktrees: { runId: string; count: number } | null;
        runners: { ready: number; limit: number };
      };
    };
    expect(body.launch).toBeTruthy();
    const launch = body.launch!;
    expect(launch.cachedSteps).toEqual(["scan"]);
    expect(launch.stepIssues).toEqual([{ stepId: "report", issue: "north needs auth" }]);
    expect(launch.worktrees).toEqual({ runId: "run-old", count: 2 });
    expect(launch.runners).toEqual({ ready: 1, limit: 4 });
  });

  it("keys the cache prediction to the exact launch shape", async () => {
    const { server, cacheStore } = makeServer({ doctor: READY_DOCTOR });
    const base = await start(server);
    await cacheStore.save(
      workflowCacheKey(launchSpec.name, "fix the bug", tmpdir(), launchSpec),
      new Map([["scan", { stepId: "scan", ok: true, output: "cached", durationMs: 1 }]]),
    );

    // Same cache, different input — nothing is predicted.
    const res = await postJson(`${base}/api/workflows/${launchSpec.name}/plan`, {
      input: "a different job",
    });
    const body = (await res.json()) as { launch?: { cachedSteps: string[] } };
    expect(body.launch?.cachedSteps).toEqual([]);
  });

  it("omits step issues until the doctor has run", async () => {
    const { server } = makeServer({ doctor: [] });
    const base = await start(server);
    const res = await postJson(`${base}/api/workflows/${launchSpec.name}/plan`, {
      input: "fix the bug",
    });
    const body = (await res.json()) as {
      launch?: { stepIssues: Array<{ stepId: string }>; runners: { ready: number } };
    };
    expect(body.launch?.stepIssues).toEqual([]);
    expect(body.launch?.runners.ready).toBe(0);
  });
});

describe("POST /api/runs launch options", () => {
  it("rejects an out-of-range maxParallel", async () => {
    const { server } = makeServer();
    const base = await start(server);
    for (const maxParallel of [0, 17, -1, 2.5, "3"]) {
      const res = await postJson(`${base}/api/runs`, {
        workflow: launchSpec.name,
        input: "fix the bug",
        maxParallel,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/maxParallel/);
    }
  });

  it("threads maxParallel through to the engine deps", async () => {
    const { server, host } = makeServer();
    const base = await start(server);
    const res = await postJson(`${base}/api/runs`, {
      workflow: launchSpec.name,
      input: "fix the bug",
      maxParallel: 2,
    });
    expect(res.status).toBe(201);
    await waitFor(() => host.launched.length === 1);
    expect(host.launched[0]!.maxConcurrency).toBe(2);
  });

  it("accepts the MAX_CONCURRENCY boundary value of 16", async () => {
    const { server, host } = makeServer();
    const base = await start(server);
    const res = await postJson(`${base}/api/runs`, {
      workflow: launchSpec.name,
      input: "fix the bug",
      maxParallel: 16,
    });
    expect(res.status).toBe(201);
    await waitFor(() => host.launched.length === 1);
    expect(host.launched[0]!.maxConcurrency).toBe(16);
  });

  it("leaves maxConcurrency to config when maxParallel is omitted", async () => {
    const { server, host } = makeServer();
    const base = await start(server);
    const res = await postJson(`${base}/api/runs`, {
      workflow: launchSpec.name,
      input: "fix the bug",
    });
    expect(res.status).toBe(201);
    await waitFor(() => host.launched.length === 1);
    expect(host.launched[0]!.maxConcurrency).toBeUndefined();
  });

  it("freshWorktrees prunes the previous run's trees and launches regardless", async () => {
    // Retained worktrees with roots that do not exist: every git call fails,
    // yet the record is still marked pruned and the run goes ahead (best
    // effort, never blocks the launch).
    const history = createInMemoryHistoryStore();
    await history.save(keptWorktreeRecord("run-kept", 1000, ["scan", "report"]));
    const { server, host, runs } = makeServer({ history });
    const base = await start(server);
    const res = await postJson(`${base}/api/runs`, {
      workflow: launchSpec.name,
      input: "fix the bug",
      freshWorktrees: true,
    });
    expect(res.status).toBe(201);
    // The prune is awaited before the engine starts, so by the time the host
    // has been called the record's prune bookkeeping is done too.
    await waitFor(() => host.launched.length === 1);
    const record = await history.get("run-kept");
    expect(record?.harvest?.prunedAt).toEqual(expect.any(Number));
    // And the pruned run is no longer a kept-worktrees target.
    expect(await runs.lastKeptWorktrees(launchSpec.name)).toBeNull();
  });
});

describe("WorkflowRunManager launch predictions", () => {
  it("lastKeptWorktrees picks the newest unpruned run with trees", async () => {
    const history = createInMemoryHistoryStore();
    const { runs } = makeServer({ history });
    await history.save(keptWorktreeRecord("run-a", 1000, ["scan", "report"]));
    const pruned = keptWorktreeRecord("run-b", 2000, ["scan"]);
    pruned.harvest = { prunedAt: 2500 };
    await history.save(pruned);
    await history.save(keptWorktreeRecord("run-c", 3000, ["scan"]));
    expect(await runs.lastKeptWorktrees(launchSpec.name)).toEqual({ runId: "run-c", count: 1 });
  });

  it("lastKeptWorktrees skips pruned and treeless runs, null when nothing kept", async () => {
    const history = createInMemoryHistoryStore();
    const { runs } = makeServer({ history });
    const pruned = keptWorktreeRecord("run-a", 1000, ["scan"]);
    pruned.harvest = { prunedAt: 1500 };
    await history.save(pruned);
    expect(await runs.lastKeptWorktrees(launchSpec.name)).toBeNull();

    // A treeless newer run lets the search fall through to the older keeper.
    await history.save(keptWorktreeRecord("run-b", 2000, []));
    await history.save(keptWorktreeRecord("run-c", 500, ["report"]));
    expect(await runs.lastKeptWorktrees(launchSpec.name)).toEqual({ runId: "run-c", count: 1 });
  });

  it("lastKeptWorktrees is null without a history store", async () => {
    const { runs } = makeServer();
    expect(await runs.lastKeptWorktrees(launchSpec.name)).toBeNull();
  });

  it("cachedStepIds reads the cache for the exact launch shape", async () => {
    const { runs, cacheStore } = makeServer();
    await cacheStore.save(
      workflowCacheKey(launchSpec.name, "fix the bug", tmpdir(), launchSpec),
      new Map([
        ["scan", { stepId: "scan", ok: true, output: "cached", durationMs: 1 }],
        ["report", { stepId: "report", ok: true, output: "cached", durationMs: 1 }],
      ]),
    );
    expect((await runs.cachedStepIds(launchSpec.name, "fix the bug", launchSpec)).sort()).toEqual([
      "report",
      "scan",
    ]);
    // Input is trimmed before keying.
    expect((await runs.cachedStepIds(launchSpec.name, "  fix the bug  ", launchSpec)).length).toBe(
      2,
    );
    // A different spec (draft edits) invalidates the prediction.
    const edited: WorkflowSpec = {
      ...launchSpec,
      phases: launchSpec.phases.map((p) => ({ ...p, title: "Edited" })),
    };
    expect(await runs.cachedStepIds(launchSpec.name, "fix the bug", edited)).toEqual([]);
  });
});
