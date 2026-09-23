import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunOptions } from "../src/agents";
import type { AgentEvent, AgentId } from "../src/types/events";
import { type WorkflowHost, WorkflowRunManager } from "../src/web/runs";
import { createWebServer } from "../src/web/server";
import {
  type ApprovalProvider,
  type LiveRunStore,
  type StepResult,
  type WorkflowCacheStore,
  type WorkflowEvent,
  type WorkflowRunControl,
  type WorkflowSpec,
  createLiveRunStore,
  createWorkflowCacheStore,
  runWorkflow,
  workflowCacheKey,
} from "../src/workflow";
import { cacheLoopProgress, setCacheLoopProgress } from "../src/workflow/loop-progress";

/**
 * Mid-run detach from the web run manager: abort local work, hand the run off
 * to a background process under the same id, drop it from the manager, and
 * tell subscribers to reconnect. The detached child is a no-op script here —
 * we are verifying the manager's handoff, not the real `_detached-runner`.
 */

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  name: "detach-demo",
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

function makeEngineHost(): {
  host: WorkflowHost;
  state: { prompts: string[]; releaseA: () => void; abortSeen: boolean };
} {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = { prompts: [] as string[], releaseA: () => release(), abortSeen: false };
  const createAdapter = (id: AgentId): AgentAdapter => ({
    id,
    binary: "fake",
    defaultModel: "test",
    run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
      return (async function* () {
        state.prompts.push(opts.prompt);
        if (opts.model === "ma") {
          opts.signal?.addEventListener(
            "abort",
            () => {
              state.abortSeen = true;
            },
            { once: true },
          );
          await gate;
        }
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

let root: string;
let savedArgv1: string | undefined;
let liveRuns: LiveRunStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "steamtrain-webdetach-"));
  savedArgv1 = process.argv[1];
  // A no-op detached child: the manager only needs the spawn to succeed.
  const noop = join(root, "noop.mjs");
  writeFileSync(noop, "process.exit(0)\n");
  process.argv[1] = noop;
  liveRuns = createLiveRunStore(join(root, "runs"));
});

afterEach(() => {
  process.argv[1] = savedArgv1 as string;
  rmSync(root, { recursive: true, force: true });
});

describe("web run manager mid-run detach", () => {
  it("hands a running web run off to a background process and drops it", async () => {
    const { host, state } = makeEngineHost();
    const manager = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      cwd: root,
      config: { stepTimeoutSec: 60, workflowTimeoutSec: 3600 },
      liveRuns,
      detachIo: { projectDir: root },
    });

    const started = manager.start("detach-demo", "hi");
    expect(started.ok).toBe(true);
    const runId = started.runId as string;

    const frames: { type?: string; pid?: number }[] = [];
    manager.subscribe(runId, (payload) => {
      try {
        frames.push(JSON.parse(payload));
      } catch {
        /* ignore */
      }
    });

    // Wait until step "a" is in flight (blocked on the gate).
    for (let i = 0; i < 100 && state.prompts.length === 0; i++) await delay(10);
    expect(state.prompts).toEqual(["hi"]);

    // Detach commits ownership and aborts local in-flight work synchronously;
    // this deliberately uncooperative fake is then released so drive() can
    // finish draining and spawn the detached owner.
    expect(manager.detach(runId)).toEqual({ ok: true });
    expect(state.abortSeen).toBe(true);
    state.releaseA();

    // The run leaves the manager once the handoff completes.
    for (let i = 0; i < 200 && manager.get(runId); i++) await delay(10);
    expect(manager.get(runId)).toBeUndefined();

    // The registry entry is now a queued, owner-less cli-detached run carrying
    // the launch args the background child replays from.
    const meta = await liveRuns.get(runId);
    expect(meta).toMatchObject({
      source: "cli-detached",
      detached: true,
      status: "queued",
      pid: -1,
      paused: false,
    });
    expect(meta?.launch).toMatchObject({ workflow: "detach-demo", input: "hi", fresh: false });
    // The exact running spec is carried so the child reuses the same cache key.
    expect(meta?.launch?.spec?.name).toBe("detach-demo");
    expect(meta?.launch?.spec?.phases).toHaveLength(2);

    // Subscribers were told the run detached (so a browser reconnects to it).
    const detached = frames.find((f) => f.type === "detached");
    expect(detached).toBeTruthy();
    expect(detached?.pid).toBeGreaterThan(0);

    // No terminal status frame was emitted — the run did not end, it moved.
    expect(frames.some((f) => f.type === "status")).toBe(false);

    // The interrupted step is deliberately not recorded as completed; the real
    // detached child replays it because no successful cache entry exists.
    const events = await liveRuns.readEvents(runId);
    expect(events.some((e) => e.kind === "step_done" && e.stepId === "a")).toBe(false);
    // Immediate detach no longer injects a synthetic pause/resume pair.
    expect(events.some((e) => e.kind === "run_paused" || e.kind === "run_resumed")).toBe(false);
  });

  it("still saves what the engine changes in the cache while it unwinds", async () => {
    // A detach can land just as a spent loop fails its run: the engine,
    // unwinding, releases the loop's budget on the cache map. The detached
    // child starts only once the drain is over and reads the cache from disk,
    // so the release must reach disk first even though events are skipped.
    const cacheStore = createWorkflowCacheStore(join(root, "cache"));
    const key = workflowCacheKey("detach-demo", "hi", root, chainSpec);
    const seeded = new Map<string, StepResult>();
    setCacheLoopProgress(seeded, { phaseRuns: { p1: 1 }, gateIterations: { g: 2 } });
    await cacheStore.save(key, seeded);

    let started = false;
    const host: WorkflowHost = {
      listWorkflows: () => ({ [chainSpec.name]: chainSpec }),
      canDispatchWorkflowSpec: () => ({ ok: true }),
      runWorkflow: (_name, _input, signal, cache) =>
        (async function* () {
          yield { kind: "workflow_start", name: "detach-demo", phaseCount: 2, stepCount: 2, ts: 0 };
          started = true;
          while (!signal?.aborted) await delay(5);
          setCacheLoopProgress(cache!, { phaseRuns: { p1: 1 }, gateIterations: {} });
          yield { kind: "workflow_done", ok: false, results: [], ts: 0 } as WorkflowEvent;
        })(),
    };
    const manager = new WorkflowRunManager({
      host,
      cacheStore,
      cwd: root,
      config: { stepTimeoutSec: 60, workflowTimeoutSec: 3600 },
      liveRuns,
      detachIo: { projectDir: root },
    });
    const runId = manager.start("detach-demo", "hi").runId as string;
    for (let i = 0; i < 100 && !started; i++) await delay(10);
    expect(manager.detach(runId)).toEqual({ ok: true });
    for (let i = 0; i < 200 && manager.get(runId); i++) await delay(10);
    expect(manager.get(runId)).toBeUndefined();

    expect(cacheLoopProgress(await cacheStore.load(key))).toEqual({
      phaseRuns: { p1: 1 },
      gateIterations: {},
    });
  });

  it("carries a per-session spec override into the handoff (cache stays aligned)", async () => {
    const { host, state } = makeEngineHost();
    const manager = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      cwd: root,
      config: { stepTimeoutSec: 60, workflowTimeoutSec: 3600 },
      liveRuns,
      detachIo: { projectDir: root },
    });

    // A run launched with a session override: step "a" carries an overridden
    // prompt. The detached child must continue with THIS spec, not the
    // catalog's — otherwise it would re-run completed steps and drop the edit.
    // (The fake host ignores the passed spec at execution time; what matters
    // here is that the manager stores it and carries it into the handoff.)
    const overrideSpec: WorkflowSpec = {
      ...chainSpec,
      phases: [
        {
          ...chainSpec.phases[0]!,
          steps: [{ id: "a", agent: "claude", model: "ma", prompt: "OVERRIDDEN:{{input}}" }],
        },
        chainSpec.phases[1]!,
      ],
    };
    const started = manager.start("detach-demo", "hi", { specOverride: overrideSpec });
    const runId = started.runId as string;

    for (let i = 0; i < 100 && state.prompts.length === 0; i++) await delay(10);
    expect(state.prompts).toHaveLength(1); // step "a" is in flight

    expect(manager.detach(runId)).toEqual({ ok: true });
    state.releaseA();
    for (let i = 0; i < 200 && manager.get(runId); i++) await delay(10);
    expect(manager.get(runId)).toBeUndefined();

    const meta = await liveRuns.get(runId);
    // The overridden prompt survives in the carried spec.
    expect(meta?.launch?.spec?.phases[0]?.steps[0]).toMatchObject({
      prompt: "OVERRIDDEN:{{input}}",
    });
  });

  it("hands off a run parked on a human approval (nothing computing)", async () => {
    // A host that reaches an approval checkpoint and parks awaiting the
    // provider — the natural "step away while it waits for me" moment.
    const approvalSpec: WorkflowSpec = {
      name: "approve-demo",
      phases: [
        { id: "p1", title: "Approve", steps: [{ id: "chk", kind: "approval", prompt: "ok?" }] },
      ],
    };
    const host: WorkflowHost = {
      listWorkflows: () => ({ [approvalSpec.name]: approvalSpec }),
      canDispatchWorkflowSpec: () => ({ ok: true }),
      runWorkflow(_n, _i, signal, _c, _cwd, _s, _in, approval) {
        return (async function* () {
          const ts = () => Date.now();
          yield {
            kind: "workflow_start",
            name: "approve-demo",
            phaseCount: 1,
            stepCount: 1,
            ts: ts(),
          };
          yield {
            kind: "step_start",
            phaseId: "p1",
            stepId: "chk",
            blockKind: "approval",
            ts: ts(),
          };
          yield {
            kind: "approval_pending",
            phaseId: "p1",
            stepId: "chk",
            message: "ok?",
            onReject: "fail",
            iteration: 1,
            ts: ts(),
          };
          // Parks here until a decision arrives — or the abort signal fires on
          // detach, which settles it as canceled.
          const decision = approval
            ? await approval(
                { stepId: "chk", phaseId: "p1", iteration: 1, onReject: "fail" },
                signal,
              )
            : { approved: false };
          yield {
            kind: "approval_resolved",
            phaseId: "p1",
            stepId: "chk",
            approved: decision.approved,
            iteration: 1,
            ts: ts(),
          };
          yield { kind: "workflow_done", ok: decision.approved, results: [], ts: ts() };
        })();
      },
    };

    const manager = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      cwd: root,
      config: { stepTimeoutSec: 60, workflowTimeoutSec: 3600 },
      liveRuns,
      detachIo: { projectDir: root },
    });
    const runId = manager.start("approve-demo", "go").runId as string;

    // Wait until the run is parked on the approval checkpoint.
    for (let i = 0; i < 200 && !manager.get(runId)?.pendingApprovals?.length; i++) await delay(10);
    expect(manager.get(runId)?.pendingApprovals).toHaveLength(1);

    // Detach: an approval does no compute, so the run hands off immediately
    // (no releasing an in-flight step needed).
    expect(manager.detach(runId)).toEqual({ ok: true });
    for (let i = 0; i < 200 && manager.get(runId); i++) await delay(10);
    expect(manager.get(runId)).toBeUndefined();

    const meta = await liveRuns.get(runId);
    expect(meta).toMatchObject({ source: "cli-detached", detached: true, status: "queued" });
    // The pending approval is cleared for the new owner — the detached child
    // re-asks via the store provider, so no stale decision is inherited.
    expect(meta?.pendingApprovals ?? []).toHaveLength(0);
  });

  it("a re-issued detach on an already-detaching run is an idempotent no-op", async () => {
    const { host, state } = makeEngineHost();
    const manager = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      cwd: root,
      config: { stepTimeoutSec: 60, workflowTimeoutSec: 3600 },
      liveRuns,
      detachIo: { projectDir: root },
    });
    const runId = manager.start("detach-demo", "hi").runId as string;
    for (let i = 0; i < 100 && state.prompts.length === 0; i++) await delay(10);

    const frames: { type?: string }[] = [];
    manager.subscribe(runId, (payload) => {
      try {
        frames.push(JSON.parse(payload));
      } catch {
        /* ignore */
      }
    });

    // First call commits the handoff (emitting one "detaching" frame); a
    // second call while it's still settling must short-circuit before that
    // emit and must not re-trigger the abort/spawn machinery — just report
    // success, with no second "detaching"/"detached" frame reaching subscribers.
    expect(manager.detach(runId)).toEqual({ ok: true });
    expect(manager.detach(runId)).toEqual({ ok: true });
    state.releaseA();

    for (let i = 0; i < 200 && manager.get(runId); i++) await delay(10);
    expect(manager.get(runId)).toBeUndefined();
    // Exactly one background child was spawned, not two.
    const meta = await liveRuns.get(runId);
    expect(meta).toMatchObject({ source: "cli-detached", status: "queued" });
    expect(frames.filter((f) => f.type === "detaching")).toHaveLength(1);
    expect(frames.filter((f) => f.type === "detached")).toHaveLength(1);
  });

  it("refuses to detach an unknown or already-finished run", async () => {
    const { host } = makeEngineHost();
    const manager = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      cwd: root,
      config: { stepTimeoutSec: 60, workflowTimeoutSec: 3600 },
      liveRuns,
      detachIo: { projectDir: root },
    });
    expect(manager.detach("nope")).toMatchObject({ ok: false });
  });

  it("records an error terminal outcome when the background spawn fails", async () => {
    const { host, state } = makeEngineHost();
    const manager = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      cwd: root,
      config: { stepTimeoutSec: 60, workflowTimeoutSec: 3600 },
      liveRuns,
      detachIo: { projectDir: root },
    });
    const runId = manager.start("detach-demo", "hi").runId as string;
    for (let i = 0; i < 100 && state.prompts.length === 0; i++) await delay(10);

    const frames: { type?: string; status?: string; error?: string }[] = [];
    manager.subscribe(runId, (payload) => {
      try {
        frames.push(JSON.parse(payload));
      } catch {
        /* ignore */
      }
    });

    // No entry script ⇒ spawnDetachedRunner can't build a command line, so
    // finishHandoff's spawn fails and the manager must fall back to a normal
    // (error) terminal instead of silently dropping the run.
    process.argv[1] = "";
    expect(manager.detach(runId)).toEqual({ ok: true });
    state.releaseA();

    for (let i = 0; i < 200 && manager.get(runId)?.status !== "error"; i++) await delay(10);
    // The run is NOT silently dropped from the manager on a failed handoff.
    expect(manager.get(runId)).toMatchObject({ status: "error" });

    // A terminal status frame (not "detached") reached subscribers.
    for (let i = 0; i < 200 && !frames.some((f) => f.type === "status"); i++) await delay(10);
    const status = frames.find((f) => f.type === "status");
    expect(status).toMatchObject({ status: "error" });
    expect(String(status?.error)).toMatch(/detach failed/);
    expect(frames.some((f) => f.type === "detached")).toBe(false);

    // The live-run registry also reflects the failure, not a phantom "queued".
    // (handoffRunToDetached's own "could not detach the run: …" write lands
    // first; drive()'s finally then settles the mirror through the publisher,
    // which is the write that wins — same "detach failed: …" message as the
    // SSE frame.)
    const meta = await liveRuns.get(runId);
    expect(meta?.status).toBe("error");
    expect(String(meta?.error)).toMatch(/detach failed/);
  });
});

describe("POST /api/runs/:id/detach", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    while (servers.length) {
      const server = servers.pop()!;
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function start(server: Server): Promise<string> {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it("accepts a live run (202) and 404s an unknown one", async () => {
    const { host, state } = makeEngineHost();
    const runs = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      cwd: root,
      config: { stepTimeoutSec: 60, workflowTimeoutSec: 3600 },
      liveRuns,
      detachIo: { projectDir: root },
    });
    const base = await start(
      createWebServer({ host, runs, liveRuns, workflowSource: () => "bundled", doctor: () => [] }),
    );

    const post = (path: string) =>
      fetch(`${base}${path}`, { method: "POST" }).then(async (r) => ({
        status: r.status,
        body: (await r.json()) as Record<string, unknown>,
      }));

    expect((await post("/api/runs/nope/detach")).status).toBe(404);

    const startedRes = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "detach-demo", input: "hi" }),
    });
    const runId = ((await startedRes.json()) as { runId: string }).runId;
    for (let i = 0; i < 100 && state.prompts.length === 0; i++) await delay(10);

    const accepted = await post(`/api/runs/${runId}/detach`);
    expect(accepted).toMatchObject({ status: 202, body: { detaching: true } });

    // Let the handoff complete cleanly so no stray engine keeps running.
    state.releaseA();
    for (let i = 0; i < 200 && runs.get(runId); i++) await delay(10);
    expect(runs.get(runId)).toBeUndefined();
  });

  it("forbids detach from a read-only session", async () => {
    const { host } = makeEngineHost();
    const runs = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      cwd: root,
      config: { stepTimeoutSec: 60, workflowTimeoutSec: 3600 },
      liveRuns,
      detachIo: { projectDir: root },
    });
    const base = await start(
      createWebServer({
        host,
        runs,
        liveRuns,
        workflowSource: () => "bundled",
        doctor: () => [],
        readOnly: true,
      }),
    );
    const res = await fetch(`${base}/api/runs/anything/detach`, { method: "POST" });
    expect(res.status).toBe(403);
  });
});
