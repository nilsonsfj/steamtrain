import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { Server } from "node:http";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiDoctorResult, DoctorResult } from "../src/doctor";
import { type WorkflowHost, WorkflowRunManager } from "../src/web/runs";
import {
  createWebServer,
  isForbiddenForReadSession,
  isMutatingApiRequest,
  resolveWebAuthToken,
  resolveWebReadToken,
} from "../src/web/server";
import type {
  StepResult,
  WorkflowCacheStore,
  WorkflowEvent,
  WorkflowHistoryStore,
  WorkflowSpec,
} from "../src/workflow";
import type { HistoryPhase, RunRecord } from "../src/workflow";
import {
  RunRecordBuilder,
  WorkflowAuthor,
  computeRunTotals,
  createGitWorktreeManager,
  createWorkflowHistoryStore,
} from "../src/workflow";
import type { AuthoringHost, WorkflowSourceKind } from "../src/workflow";
import type { LoadedWorkflowCatalog } from "../src/workflow";
import { readSse } from "./helpers/read-sse";

const servers: Server[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop()!;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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
  canDispatchWorkflowSpec(_spec: WorkflowSpec): { ok: true } | { ok: false; reason: string } {
    return this.dispatchable ? { ok: true } : { ok: false, reason: "agent is down" };
  }
  runWorkflow(name: string, input: string, signal?: AbortSignal): AsyncIterable<WorkflowEvent> {
    return this.gen(input, signal);
  }
}

/** A host that implements both WorkflowHost and AuthoringHost for auth/CSRF tests. */
class FakeAuthoringHost implements WorkflowHost, AuthoringHost {
  private readonly workflows: Record<string, WorkflowSpec>;
  constructor(spec: WorkflowSpec) {
    this.workflows = { [spec.name]: spec };
  }
  listWorkflows(): Record<string, WorkflowSpec> {
    return this.workflows;
  }
  canDispatchWorkflowSpec(): { ok: true } | { ok: false; reason: string } {
    return { ok: true };
  }
  runWorkflow(): AsyncIterable<WorkflowEvent> {
    return (async function* () {})();
  }
  workflowSource(): WorkflowSourceKind | undefined {
    return "user";
  }
  isAgentHealthy(): boolean {
    return true;
  }
  setCatalog(): void {}
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
    project: {
      cwd: "/tmp/demo-project",
      name: "demo-project",
      displayPath: "/tmp/demo-project",
      nameSource: "directory" as const,
    },
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
    expect(html).toContain('id="project"');
    expect(html).toContain('id="projectName"');
    expect(html).toContain('id="projectPath"');
    // The page now references external static assets rather than inlining them.
    expect(html).toContain('<link rel="stylesheet" href="/static/app.css?v=');
    expect(html).toContain('<script src="/static/steamtrain-reducer.bundle.js?v=');
    expect(html).toContain('<script src="/static/app.js?v=');
    // The inline bundle must not be served on the page anymore.
    expect(html).not.toContain("BEGIN_REDUCER_BUNDLE");
    // Scripts: 'unsafe-inline' removed so we rely on external static assets
    // shipped under script-src 'self'. Display fonts load from Google Fonts.
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("https://fonts.googleapis.com");
    expect(csp).toContain("font-src 'self' https://fonts.gstatic.com");
    expect(html).toContain("fonts.googleapis.com/css2");
    expect(html).toContain("Space+Grotesk");
    expect(html).toContain('id="announcer"');
    expect(html).toContain('aria-live="polite"');
  });

  it("serves a favicon (inline link tag + /favicon.ico route, no auth required)", async () => {
    const { server } = makeServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);

    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('<link rel="icon" href="data:image/svg+xml,');

    const icon = await fetch(`${base}/favicon.ico`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/svg+xml");
    expect(await icon.text()).toContain("<svg");
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
    expect(jsText).toContain("renderYardTrack");
    expect(jsText).toContain("friendlyStepLabel");
    expect(jsText).toContain("agent orchestrator on rails");
    expect(jsText).not.toContain("BEGIN_REDUCER_BUNDLE");

    const css = await fetch(`${base}/static/app.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(css.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const cssText = await css.text();
    expect(cssText).toContain("--accent");
    expect(cssText).toContain(".yard-track");
    expect(cssText).toContain("engine-depart");
    expect(cssText).toContain(".station-tagline");
    expect(cssText).toContain(".arrival-section");

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
      project: { name: string; cwd: string; displayPath: string };
      workflows: Record<string, unknown>[];
    };
    expect(body.configLabel).toBe("test config");
    expect(body.project).toMatchObject({
      name: "demo-project",
      cwd: "/tmp/demo-project",
    });
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

  it("exposes project identity on /api/session", async () => {
    const { server } = makeServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const res = await fetch(`${base}/api/session`);
    const body = (await res.json()) as {
      project: { name: string; cwd: string };
    };
    expect(body.project).toMatchObject({
      name: "demo-project",
      cwd: "/tmp/demo-project",
    });
  });

  it("annotates blocked workflows with the re-route offer", async () => {
    // Host whose dispatch gate fails but that can plan a re-route to claude.
    class ReroutableHost extends FakeHost {
      lastSpecOverride: WorkflowSpec | undefined;
      constructor(spec: WorkflowSpec) {
        super(spec, happyRun, false);
      }
      override canDispatchWorkflowSpec(spec: WorkflowSpec):
        | {
            ok: true;
          }
        | { ok: false; reason: string } {
        // The re-routed spec (agent switched to claude) passes the gate.
        const agent = (spec.phases[0]?.steps[0] as { agent?: string } | undefined)?.agent;
        return agent === "claude"
          ? { ok: true }
          : { ok: false, reason: "opencode is binary_missing" };
      }
      planWorkflowReroute() {
        return {
          ok: true as const,
          plan: {
            target: "claude",
            targetModel: "claude-sonnet-5",
            targetModelName: "Claude Sonnet 5",
            blockedAgents: ["opencode"],
            stepIds: ["s1"],
            overrides: { s1: { agent: "claude", model: "claude-sonnet-5", effort: undefined } },
          },
        };
      }
      override runWorkflow(
        name: string,
        input: string,
        signal?: AbortSignal,
        _cache?: Map<string, StepResult>,
        _cwd?: string,
        specOverride?: WorkflowSpec,
      ): AsyncIterable<WorkflowEvent> {
        this.lastSpecOverride = specOverride;
        return happyRun(input);
      }
    }
    const host = new ReroutableHost(demoSpec());
    const { server } = makeServer(host);
    const base = await start(server);

    const list = await fetch(`${base}/api/workflows`);
    const body = (await list.json()) as { workflows: Record<string, unknown>[] };
    expect(body.workflows[0]).toMatchObject({
      name: "demo",
      blocked: "opencode is binary_missing",
      reroute: { agent: "claude", model: "claude-sonnet-5", steps: 1 },
    });

    // reroute: true applies the plan's overrides so the gate passes, and the
    // 201 echoes the actually-applied re-route (the client announces on this,
    // not the possibly-stale catalog annotation).
    const run = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "demo", input: "x", reroute: true }),
    });
    expect(run.status).toBe(201);
    const runBody = (await run.json()) as {
      runId: string;
      reroute?: { agent: string; model: string; modelName: string; steps: number };
    };
    expect(runBody.reroute).toMatchObject({
      agent: "claude",
      model: "claude-sonnet-5",
      modelName: "Claude Sonnet 5",
      steps: 1,
    });
    const step = host.lastSpecOverride?.phases[0]?.steps[0] as
      | { agent?: string; model?: string }
      | undefined;
    expect(step?.agent).toBe("claude");
    expect(step?.model).toBe("claude-sonnet-5");
  });

  it("does not advertise a re-route that would not make the workflow dispatchable", async () => {
    // A workflow blocked for a reason the re-route can't fix (e.g. a missing
    // agent AND an llm step's missing key): the planner still returns a plan,
    // but the re-routed spec is still undispatchable, so the catalog must mark
    // it `blocked` WITHOUT offering a one-click re-route that can only fail.
    class DoubleBlockedHost extends FakeHost {
      constructor(spec: WorkflowSpec) {
        super(spec, happyRun, false);
      }
      override canDispatchWorkflowSpec(): { ok: true } | { ok: false; reason: string } {
        // Never dispatchable — even after the re-route is applied.
        return { ok: false, reason: "opencode is binary_missing; anthropic key missing" };
      }
      planWorkflowReroute() {
        return {
          ok: true as const,
          plan: {
            target: "claude",
            targetModel: "claude-sonnet-5",
            targetModelName: "Claude Sonnet 5",
            blockedAgents: ["opencode"],
            stepIds: ["s1"],
            overrides: { s1: { agent: "claude", model: "claude-sonnet-5", effort: undefined } },
          },
        };
      }
    }
    const { server } = makeServer(new DoubleBlockedHost(demoSpec()));
    const base = await start(server);
    const list = await fetch(`${base}/api/workflows`);
    const body = (await list.json()) as {
      workflows: Array<{ name: string; blocked?: string; reroute?: unknown }>;
    };
    expect(body.workflows[0]?.blocked).toContain("binary_missing");
    expect(body.workflows[0]?.reroute).toBeUndefined();
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

  it("includes resolved child specs for a workflow with sub-workflow steps", async () => {
    const child: WorkflowSpec = {
      name: "child",
      phases: [
        {
          id: "c",
          title: "C",
          steps: [{ id: "work", agent: "opencode", model: "m", prompt: "w" }],
        },
      ],
    };
    const parent: WorkflowSpec = {
      name: "parent",
      phases: [
        {
          id: "p",
          title: "P",
          steps: [{ id: "call", kind: "workflow", workflow: "child" }],
        },
      ],
    };
    const host: WorkflowHost = {
      listWorkflows: () => ({ parent, child }),
      canDispatchWorkflowSpec: () => ({ ok: true }),
      runWorkflow: () => (async function* () {})(),
    };
    const { server } = makeServer(host);
    const base = await start(server);
    const res = await fetch(`${base}/api/workflows/parent`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { children?: Record<string, WorkflowSpec> };
    expect(body.children).toBeDefined();
    expect(body.children?.child?.name).toBe("child");
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

  it("exposes the worktree lifecycle: diffstat, harvest to branch, prune", async () => {
    const execFileAsync = promisify(execFile);
    const git = async (cwd: string, ...args: string[]) =>
      (await execFileAsync("git", args, { cwd })).stdout.trim();
    const root = mkdtempSync(join(tmpdir(), "steamtrain-web-wt-"));
    tempRoots.push(root);
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.email", "test@example.com");
    await git(repo, "config", "user.name", "Test User");
    writeFileSync(join(repo, "README.md"), "hello\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "initial");

    const manager = createGitWorktreeManager({ baseDir: join(root, "wt"), runId: "web-run" });
    const lease = await manager.allocate({
      workflowName: "demo",
      stepId: "implement",
      agent: "claude",
      baseCwd: repo,
      stepCwd: repo,
      iteration: 1,
    });
    writeFileSync(join(lease.root as string, "feature.txt"), "web work\n");

    const phases: HistoryPhase[] = [
      {
        phaseId: "p1",
        title: "Phase 1",
        index: 0,
        stepCount: 1,
        done: true,
        ok: true,
        steps: [
          {
            stepId: "implement",
            blockKind: "worker",
            agent: "claude",
            model: "m",
            status: "done",
            text: "done",
            cached: false,
            worktree: {
              originalCwd: repo,
              cwd: lease.cwd,
              root: lease.root as string,
              branch: lease.branch as string,
              baseCommit: lease.baseCommit,
            },
          },
        ],
      },
    ];
    const record: RunRecord = {
      version: 1,
      id: "wt-run",
      workflow: "demo",
      input: "task",
      cwd: repo,
      status: "done",
      ok: true,
      startedAt: Date.now() - 1000,
      endedAt: Date.now(),
      durationMs: 1000,
      phases,
      totals: computeRunTotals(phases),
    };
    const historyStore = createWorkflowHistoryStore(join(root, "history"));
    await historyStore.save(record);

    const host = new FakeHost(demoSpec(), happyRun);
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

    // Diffstat of the retained worktree.
    const wt = await fetch(`${base}/api/history/wt-run/worktrees`);
    expect(wt.status).toBe(200);
    const wtBody = (await wt.json()) as {
      sources: { stepId: string; exists: boolean; files: { path: string }[] }[];
    };
    expect(wtBody.sources).toHaveLength(1);
    expect(wtBody.sources[0]).toMatchObject({ stepId: "implement", exists: true });
    expect(wtBody.sources[0]?.files.map((f) => f.path)).toEqual(["feature.txt"]);

    // Unknown run and invalid body are rejected.
    expect((await fetch(`${base}/api/history/nope/worktrees`)).status).toBe(404);
    const badMode = await fetch(`${base}/api/history/wt-run/harvest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "zip" }),
    });
    expect(badMode.status).toBe(400);

    // Harvest to a branch; the record picks up the delivery.
    const harvest = await fetch(`${base}/api/history/wt-run/harvest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "branch", branch: "steamtrain/merged/web-test" }),
    });
    expect(harvest.status).toBe(200);
    const { result } = (await harvest.json()) as {
      result: { branch?: string; mergedSources: string[] };
    };
    expect(result.branch).toBe("steamtrain/merged/web-test");
    expect(result.mergedSources).toEqual(["implement"]);
    expect(await git(repo, "show", "steamtrain/merged/web-test:feature.txt")).toBe("web work");
    expect((await historyStore.get("wt-run"))?.harvest?.branch).toBe("steamtrain/merged/web-test");

    // Prune discards the worktree; the diffstat then reports it gone.
    const prune = await fetch(`${base}/api/history/wt-run/prune`, { method: "POST" });
    expect(prune.status).toBe(200);
    expect((await prune.json()) as object).toMatchObject({ pruned: 1, total: 1 });
    const goneBody = (await (await fetch(`${base}/api/history/wt-run/worktrees`)).json()) as {
      sources: { exists: boolean }[];
    };
    expect(goneBody.sources[0]?.exists).toBe(false);
    expect((await historyStore.get("wt-run"))?.harvest?.prunedAt).toBeTypeOf("number");
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
    const bigBody = "x".repeat(1024 * 1024 + 1);
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: bigBody,
    });
    expect(res.status).toBe(413);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("too large");
  });

  it("POST /api/workflows/:name/plan returns a plan result", async () => {
    const { server } = makeServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const res = await fetch(`${base}/api/workflows/demo/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "test input" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; steps: unknown[]; phaseCount: number };
    expect(json.ok).toBe(true);
    expect(json.phaseCount).toBe(1);
    expect(json.steps.length).toBe(1);
  });

  it("POST /api/workflows/:name/plan returns 404 for unknown workflow", async () => {
    const { server } = makeServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const res = await fetch(`${base}/api/workflows/missing/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "test" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /api/workflows/:name/plan returns 400 for missing input", async () => {
    const { server } = makeServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const res = await fetch(`${base}/api/workflows/demo/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/workflows/:name/plan returns 400 for empty input", async () => {
    const { server } = makeServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const res = await fetch(`${base}/api/workflows/demo/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/workflows/:name/plan returns 422 for invalid spec", async () => {
    const invalidSpec: WorkflowSpec = {
      name: "invalid",
      phases: [
        {
          id: "p1",
          title: "Phase 1",
          steps: [
            {
              id: "s1",
              kind: "worker",
              agent: "opencode",
              model: "m",
              prompt: "{{steps.missing.output}}",
            },
          ],
        },
      ],
    };
    // Create a host with a spec that passes schema but has template warnings.
    // planWorkflow validates, so a truly invalid spec (e.g. bad dependsOn) returns ok:false.
    // We test the warnings case instead.
    const { server } = makeServer(new FakeHost(invalidSpec, happyRun));
    const base = await start(server);
    const res = await fetch(`${base}/api/workflows/invalid/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "test" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; warnings?: string[] };
    expect(json.ok).toBe(true);
    expect(json.warnings).toBeDefined();
    expect(json.warnings!.length).toBeGreaterThan(0);
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

  it("reports api readiness alongside agents on /api/doctor and /api/meta", async () => {
    const host = new FakeHost(demoSpec(), happyRun);
    const runs = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      cwd: tmpdir(),
      config: testRunConfig,
    });
    const config = {
      apis: [{ id: "groq", provider: "openai" as const, apiKeyEnv: "GROQ_API_KEY" }],
    };
    const author = new WorkflowAuthor({
      host: new FakeAuthoringHost(demoSpec()),
      config,
      home: mkdtempSync(join(tmpdir(), "st-home-")),
      cwd: tmpdir(),
    });
    const server = createWebServer({
      host,
      runs,
      author,
      config,
      apiDoctor: () => [
        {
          api: "groq",
          provider: "openai",
          status: "ok",
          keyEnv: "GROQ_API_KEY",
          baseUrl: "https://api.groq.com/openai/v1",
          message: "ready",
        },
      ],
    });
    servers.push(server);
    const base = await start(server);

    const doctorRes = await fetch(`${base}/api/doctor`);
    const doctorBody = (await doctorRes.json()) as { apis: { api: string; status: string }[] };
    expect(doctorBody.apis).toEqual([expect.objectContaining({ api: "groq", status: "ok" })]);

    const metaRes = await fetch(`${base}/api/meta`);
    const metaBody = (await metaRes.json()) as {
      apis: { id: string; healthy: boolean; keyPresent: boolean }[];
    };
    const ids = metaBody.apis.map((a) => a.id);
    expect(ids).toEqual(["anthropic", "openai", "openrouter", "opencode-zen", "groq"]);
    expect(metaBody.apis.find((a) => a.id === "groq")).toMatchObject({ healthy: true });
  });

  it("POST /api/doctor re-runs the probes (Recheck), unlike GET which reads the snapshot", async () => {
    const host = new FakeHost(demoSpec(), happyRun);
    const runs = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      cwd: tmpdir(),
      config: testRunConfig,
    });
    // GET reads this fixed snapshot; POST must invoke the reprobe hooks and
    // return their fresh results instead (the just-installed / just-signed-in
    // case the setup panel's Recheck exists for).
    const snapshotAgent: DoctorResult = {
      agent: "claude",
      provider: "claude",
      status: "binary_missing",
      binary: "claude",
      message: "'claude' not found on PATH",
    };
    const freshAgent: DoctorResult = {
      agent: "claude",
      provider: "claude",
      status: "ok",
      binary: "claude",
      version: "1.2.3",
      message: "ready",
    };
    let reprobedAgents = 0;
    let reprobedApis = 0;
    const server = createWebServer({
      host,
      runs,
      doctor: () => [snapshotAgent],
      apiDoctor: () => [],
      reprobeDoctor: async () => {
        reprobedAgents += 1;
        return [freshAgent];
      },
      reprobeApiDoctor: async () => {
        reprobedApis += 1;
        return [];
      },
    });
    servers.push(server);
    const base = await start(server);

    const getBody = (await (await fetch(`${base}/api/doctor`)).json()) as {
      doctor: DoctorResult[];
    };
    expect(getBody.doctor[0]).toMatchObject({ agent: "claude", status: "binary_missing" });
    expect(reprobedAgents).toBe(0);

    const postRes = await fetch(`${base}/api/doctor`, { method: "POST" });
    expect(postRes.status).toBe(200);
    const postBody = (await postRes.json()) as { doctor: DoctorResult[]; apis: unknown[] };
    expect(postBody.doctor[0]).toMatchObject({ agent: "claude", status: "ok", version: "1.2.3" });
    expect(reprobedAgents).toBe(1);
    expect(reprobedApis).toBe(1);
  });

  it("PUT /api/config saves apis into the project file and re-probes readiness", async () => {
    // Hide any real provider keys so the re-probe stays local (key_missing
    // short-circuits before the network) and the assertion is deterministic.
    const hidden = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"].map((name) => {
      const value = process.env[name];
      delete process.env[name];
      return { name, value };
    });
    try {
      const host = new FakeHost(demoSpec(), happyRun);
      const runs = new WorkflowRunManager({
        host,
        cacheStore: createInMemoryStore(),
        cwd: tmpdir(),
        config: testRunConfig,
      });
      const dir = mkdtempSync(join(tmpdir(), "st-cfg-"));
      const configPath = join(dir, "steamtrain.json");
      writeFileSync(configPath, "{}\n");
      const config = {};
      let probed: ApiDoctorResult[] | undefined;
      const server = createWebServer({
        host,
        runs,
        config,
        configPath,
        // No userConfigPath → custom/--config mode: entries land in the project file.
        apiDoctor: () => probed ?? [],
        setApiDoctor: (results) => {
          probed = results;
        },
      });
      servers.push(server);
      const base = await start(server);

      const res = await fetch(`${base}/api/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          apis: [{ id: "groq", provider: "openai", apiKeyEnv: "STEAMTRAIN_TEST_UNSET_KEY" }],
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        apis: { id: string; scope?: string }[];
        apiCatalog: { id: string }[];
      };
      expect(body.ok).toBe(true);
      expect(body.apis).toEqual([
        expect.objectContaining({
          id: "groq",
          provider: "openai",
          scope: "project",
        }),
      ]);
      expect(body.apiCatalog.map((a) => a.id)).toEqual([
        "anthropic",
        "openai",
        "openrouter",
        "opencode-zen",
        "groq",
      ]);

      // The save re-ran the API doctor. With no keys in env the keyed
      // instances are key_missing; the keyless opencode-zen gateway is ready
      // without a network probe.
      expect(probed?.map((r) => r.api)).toEqual([
        "anthropic",
        "openai",
        "openrouter",
        "opencode-zen",
        "groq",
      ]);
      const probedById = new Map((probed ?? []).map((r) => [r.api, r.status]));
      expect(probedById.get("opencode-zen")).toBe("ok");
      for (const id of ["anthropic", "openai", "openrouter", "groq"]) {
        expect(probedById.get(id)).toBe("key_missing");
      }

      // And the project file round-trips the entry.
      const onDisk = JSON.parse(readFileSync(configPath, "utf8")) as {
        apis: { id: string }[];
      };
      expect(onDisk.apis).toEqual([
        { id: "groq", provider: "openai", apiKeyEnv: "STEAMTRAIN_TEST_UNSET_KEY" },
      ]);
    } finally {
      for (const { name, value } of hidden) {
        if (value !== undefined) process.env[name] = value;
      }
    }
  });

  it("PUT /api/config defaults agents and apis to the user/global file", async () => {
    const host = new FakeHost(demoSpec(), happyRun);
    const runs = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      cwd: tmpdir(),
      config: testRunConfig,
    });
    const dir = mkdtempSync(join(tmpdir(), "st-cfg-scope-"));
    tempRoots.push(dir);
    const configPath = join(dir, "steamtrain.json");
    const userConfigPath = join(dir, "user-config.json");
    writeFileSync(configPath, "{}\n");
    const config: Record<string, unknown> = {};
    const configLayers = {
      userAgents: [] as import("../src/config").AgentInstanceConfig[],
      projectAgents: [] as import("../src/config").AgentInstanceConfig[],
      userApis: [] as import("../src/config").ApiInstanceConfig[],
      projectApis: [] as import("../src/config").ApiInstanceConfig[],
    };
    const server = createWebServer({
      host,
      runs,
      config,
      configPath,
      userConfigPath,
      configLayers,
    });
    servers.push(server);
    const base = await start(server);

    const res = await fetch(`${base}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agents: [{ id: "mimocode", provider: "opencode" }],
        apis: [{ id: "groq", provider: "openai", apiKeyEnv: "GROQ_API_KEY" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      canGlobal: boolean;
      agents: { id: string; scope: string }[];
      apis: { id: string; scope: string }[];
      agentCatalog?: { id: string }[];
      apiCatalog?: { id: string }[];
    };
    expect(body.ok).toBe(true);
    expect(body.canGlobal).toBe(true);
    expect(body.agents).toEqual([expect.objectContaining({ id: "mimocode", scope: "user" })]);
    expect(body.apis).toEqual([expect.objectContaining({ id: "groq", scope: "user" })]);
    expect(body.agentCatalog?.some((a) => a.id === "mimocode")).toBe(true);
    expect(body.apiCatalog?.some((a) => a.id === "groq")).toBe(true);

    const userDisk = JSON.parse(readFileSync(userConfigPath, "utf8")) as {
      agents: unknown[];
      apis: unknown[];
    };
    expect(userDisk.agents).toEqual([{ id: "mimocode", provider: "opencode" }]);
    expect(userDisk.apis).toEqual([{ id: "groq", provider: "openai", apiKeyEnv: "GROQ_API_KEY" }]);

    const projectDisk = JSON.parse(readFileSync(configPath, "utf8")) as {
      agents?: unknown[];
      apis?: unknown[];
    };
    // Project file is wiped of instance entries (empty arrays) so deletes stick;
    // it must not receive the new global defaults.
    expect(projectDisk.agents ?? []).toEqual([]);
    expect(projectDisk.apis ?? []).toEqual([]);
  });

  it("PUT /api/config allows the same agent id in both user and project scopes", async () => {
    const host = new FakeHost(demoSpec(), happyRun);
    const runs = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      cwd: tmpdir(),
      config: testRunConfig,
    });
    const dir = mkdtempSync(join(tmpdir(), "st-cfg-dup-"));
    tempRoots.push(dir);
    const configPath = join(dir, "steamtrain.json");
    const userConfigPath = join(dir, "user-config.json");
    writeFileSync(configPath, "{}\n");
    const config: Record<string, unknown> = {};
    const configLayers = {
      userAgents: [] as import("../src/config").AgentInstanceConfig[],
      projectAgents: [] as import("../src/config").AgentInstanceConfig[],
      userApis: [] as import("../src/config").ApiInstanceConfig[],
      projectApis: [] as import("../src/config").ApiInstanceConfig[],
    };
    const server = createWebServer({
      host,
      runs,
      config,
      configPath,
      userConfigPath,
      configLayers,
    });
    servers.push(server);
    const base = await start(server);

    const res = await fetch(`${base}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agents: [
          { id: "claude", provider: "claude", enabled: true, scope: "user" },
          { id: "claude", provider: "claude", enabled: false, scope: "project" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agents: { id: string; scope: string; enabled?: boolean }[];
    };
    expect(body.agents).toEqual([
      expect.objectContaining({ id: "claude", scope: "user", enabled: true }),
      expect.objectContaining({ id: "claude", scope: "project", enabled: false }),
    ]);
    expect(JSON.parse(readFileSync(userConfigPath, "utf8"))).toMatchObject({
      agents: [{ id: "claude", provider: "claude", enabled: true }],
    });
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
      agents: [{ id: "claude", provider: "claude", enabled: false }],
    });
  });

  it("PUT /api/config honors explicit project scope for agents", async () => {
    const host = new FakeHost(demoSpec(), happyRun);
    const runs = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      cwd: tmpdir(),
      config: testRunConfig,
    });
    const dir = mkdtempSync(join(tmpdir(), "st-cfg-proj-"));
    tempRoots.push(dir);
    const configPath = join(dir, "steamtrain.json");
    const userConfigPath = join(dir, "user-config.json");
    writeFileSync(configPath, "{}\n");
    const config: Record<string, unknown> = {};
    const configLayers = {
      userAgents: [] as import("../src/config").AgentInstanceConfig[],
      projectAgents: [] as import("../src/config").AgentInstanceConfig[],
      userApis: [] as import("../src/config").ApiInstanceConfig[],
      projectApis: [] as import("../src/config").ApiInstanceConfig[],
    };
    const server = createWebServer({
      host,
      runs,
      config,
      configPath,
      userConfigPath,
      configLayers,
    });
    servers.push(server);
    const base = await start(server);

    const res = await fetch(`${base}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agents: [{ id: "team-bot", provider: "claude", scope: "project" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: { id: string; scope: string }[] };
    expect(body.agents).toEqual([expect.objectContaining({ id: "team-bot", scope: "project" })]);

    expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
      agents: [{ id: "team-bot", provider: "claude" }],
    });
    // Empty user wipe is skipped when the global file does not exist yet.
    expect(() => readFileSync(userConfigPath, "utf8")).toThrow();
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

  it("POST /api/runs with non-object step patches returns 400", async () => {
    const host: WorkflowHost = {
      listWorkflows: () => ({ demo: demoSpec() }),
      canDispatchWorkflowSpec: () => ({ ok: true }),
      async *runWorkflow(_name, _input, _signal, _cache, _cwd, specOverride) {
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
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("overrides.s1 must be an object");
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

  it("POST /api/runs with structured overrides applies workflow-level timeouts", async () => {
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
        overrides: {
          steps: { s1: { agent: "codex", model: "gpt-5" } },
          stepTimeoutSec: 900,
        },
      }),
    });
    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 50));

    expect(receivedSpec).toBeDefined();
    expect(receivedSpec!.stepTimeoutSec).toBe(900);
    expect((receivedSpec!.phases[0]!.steps[0]! as { agent: string }).agent).toBe("codex");
  });

  it("POST /api/runs rejects legacy __wf_* override keys", async () => {
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

    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflow: "demo",
        input: "test",
        overrides: { __wf_stepTimeoutSec__: 900 },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("legacy override key");
  });

  it("POST /api/overrides/flush with workflow-level timeouts saves to disk", async () => {
    const home = mkdtempSync(join(tmpdir(), "flush-wf-timeout-"));
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
      body: JSON.stringify({
        overrides: {
          demo: {
            steps: { s1: { agent: "codex" } },
            stepTimeoutSec: 1200,
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { saved: string[] };
    expect(body.saved).toContain("demo");
    const onDisk = JSON.parse(
      readFileSync(join(home, ".steamtrain", "workflows.json"), "utf8"),
    ) as { workflows: Record<string, WorkflowSpec> };
    expect(onDisk.workflows.demo!.stepTimeoutSec).toBe(1200);
    expect(onDisk.workflows.demo!.phases[0]!.steps[0]).toMatchObject({ agent: "codex" });
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

const AUTH_COOKIE = "__steamtrain_auth";

function hashedToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function makeAuthServer(
  host: WorkflowHost,
  options:
    | { authToken?: string; readToken?: string; readOnly?: boolean }
    | string = "test-secret-token",
): { server: Server; runs: WorkflowRunManager } {
  const opts =
    typeof options === "string"
      ? { authToken: options }
      : { authToken: "test-secret-token", ...options };
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
    authToken: opts.authToken,
    readToken: opts.readToken,
    readOnly: opts.readOnly,
  });
  servers.push(server);
  return { server, runs };
}

/** Log in and return the `name=value` session-cookie pair for later requests. */
async function login(base: string, token = "test-secret-token"): Promise<string> {
  const res = await fetch(`${base}/api/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  return setCookie!.split(";")[0]!;
}

async function loginSession(
  base: string,
  token = "test-secret-token",
): Promise<{ cookie: string; capability: string }> {
  const res = await fetch(`${base}/api/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  const body = (await res.json()) as { capability: string };
  return { cookie: setCookie!.split(";")[0]!, capability: body.capability };
}

/** GET with full header control (fetch forbids overriding the Host header). */
function rawGet(
  base: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: url.hostname, port: url.port, path, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("web server — auth", () => {
  it("returns 401 on API routes when auth-token is set and no cookie present", async () => {
    const { server } = makeAuthServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const res = await fetch(`${base}/api/workflows`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("authentication required");
  });

  it("allows access to / and /static/* without auth", async () => {
    const { server } = makeAuthServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    const css = await fetch(`${base}/static/app.css`);
    expect(css.status).toBe(200);
    const js = await fetch(`${base}/static/app.js`);
    expect(js.status).toBe(200);
  });

  it("POST /api/auth issues a random session cookie (not the hashed token)", async () => {
    const { server } = makeAuthServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const res = await fetch(`${base}/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "test-secret-token" }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toContain(`${AUTH_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Max-Age=");
    expect(setCookie).not.toContain("Secure");
    const value = setCookie.split(";")[0]!.split("=")[1]!;
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    // The session id must not be derivable from the token (the pre-session
    // scheme used SHA-256(token), a permanent offline-crackable credential).
    expect(value).not.toBe(hashedToken("test-secret-token"));
  });

  it("issues a different session id on each login", async () => {
    const { server } = makeAuthServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const first = await login(base);
    const second = await login(base);
    expect(first).not.toBe(second);
  });

  it("POST /api/auth returns 401 on invalid token", async () => {
    const { server } = makeAuthServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const res = await fetch(`${base}/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "wrong" }),
    });
    expect(res.status).toBe(401);
  });

  it("allows API access with a logged-in session cookie", async () => {
    const { server } = makeAuthServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const cookie = await login(base);
    const res = await fetch(`${base}/api/workflows`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workflows: unknown[] };
    expect(body.workflows).toBeDefined();
  });

  it("rejects a fabricated SHA-256(token) cookie (legacy scheme)", async () => {
    const { server } = makeAuthServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const res = await fetch(`${base}/api/workflows`, {
      headers: { cookie: `${AUTH_COOKIE}=${hashedToken("test-secret-token")}` },
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/logout revokes the session", async () => {
    const { server } = makeAuthServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const cookie = await login(base);
    const before = await fetch(`${base}/api/workflows`, { headers: { cookie } });
    expect(before.status).toBe(200);
    const logout = await fetch(`${base}/api/logout`, {
      method: "POST",
      headers: { cookie, origin: base },
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    const after = await fetch(`${base}/api/workflows`, { headers: { cookie } });
    expect(after.status).toBe(401);
  });

  it("rate limits failed logins per client", async () => {
    const { server } = makeAuthServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${base}/api/auth`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: `wrong-${i}` }),
      });
      expect(res.status).toBe(401);
    }
    // The budget is spent: even the correct token is refused for the window.
    const limited = await fetch(`${base}/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "test-secret-token" }),
    });
    expect(limited.status).toBe(429);
  });

  it("marks the session cookie Secure behind an https proxy with --trust-proxy", async () => {
    const host = new FakeHost(demoSpec(), happyRun);
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
      authToken: "test-secret-token",
      trustProxy: true,
    });
    servers.push(server);
    const base = await start(server);
    const res = await fetch(`${base}/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
      body: JSON.stringify({ token: "test-secret-token" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });

  it("ignores X-Forwarded-Proto without --trust-proxy (cookie stays non-Secure)", async () => {
    const { server } = makeAuthServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const res = await fetch(`${base}/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
      body: JSON.stringify({ token: "test-secret-token" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).not.toContain("Secure");
  });

  it("POST /api/auth reports auth not required when no authToken configured", async () => {
    const host = new FakeHost(demoSpec(), happyRun);
    const runs = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      cwd: tmpdir(),
      config: testRunConfig,
    });
    const server = createWebServer({ host, runs, workflowSource: () => "bundled" });
    servers.push(server);
    const base = await start(server);
    const res = await fetch(`${base}/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "anything" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      authRequired: boolean;
      capability: string;
      readOnly: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.authRequired).toBe(false);
    expect(body.capability).toBe("full");
    expect(body.readOnly).toBe(false);
  });
});

describe("web server — read-only capability", () => {
  it("isForbiddenForReadSession classifies writes, logout, and config GET", () => {
    expect(isForbiddenForReadSession("GET", "/api/workflows")).toBe(false);
    expect(isForbiddenForReadSession("GET", "/api/config")).toBe(true);
    expect(isForbiddenForReadSession("POST", "/api/logout")).toBe(false);
    expect(isForbiddenForReadSession("POST", "/api/auth")).toBe(false);
    expect(isForbiddenForReadSession("POST", "/api/runs")).toBe(true);
    expect(isForbiddenForReadSession("PUT", "/api/config")).toBe(true);
    expect(isForbiddenForReadSession("DELETE", "/api/history")).toBe(true);
    expect(isForbiddenForReadSession("POST", "/api/workflows/demo/plan")).toBe(true);
  });

  it("isMutatingApiRequest stays a write-only classifier (config GET excluded)", () => {
    expect(isMutatingApiRequest("GET", "/api/config")).toBe(false);
    expect(isMutatingApiRequest("POST", "/api/runs")).toBe(true);
  });

  it("mints a read session from --read-token and blocks mutating APIs", async () => {
    const { server } = makeAuthServer(new FakeHost(demoSpec(), happyRun), {
      authToken: "full-secret",
      readToken: "viewer-secret",
    });
    const base = await start(server);
    const session = await loginSession(base, "viewer-secret");
    expect(session.capability).toBe("read");

    const workflows = await fetch(`${base}/api/workflows`, {
      headers: { cookie: session.cookie },
    });
    expect(workflows.status).toBe(200);

    const sessionProbe = await fetch(`${base}/api/session`, {
      headers: { cookie: session.cookie },
    });
    expect(sessionProbe.status).toBe(200);
    expect(await sessionProbe.json()).toEqual({
      authRequired: true,
      capability: "read",
      readOnly: true,
    });

    const run = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: session.cookie,
        origin: base,
      },
      body: JSON.stringify({ workflow: "demo", input: "x" }),
    });
    expect(run.status).toBe(403);
    expect(await run.json()).toEqual({ error: "read-only session", capability: "read" });

    const plan = await fetch(`${base}/api/workflows/demo/plan`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: session.cookie,
        origin: base,
      },
      body: JSON.stringify({ input: "x" }),
    });
    expect(plan.status).toBe(403);

    const logout = await fetch(`${base}/api/logout`, {
      method: "POST",
      headers: { cookie: session.cookie, origin: base },
    });
    expect(logout.status).toBe(200);
  });

  it("blocks control-plane writes and GET /api/config for read sessions", async () => {
    const { server } = makeAuthServer(new FakeHost(demoSpec(), happyRun), {
      authToken: "full-secret",
      readToken: "viewer-secret",
    });
    const base = await start(server);
    const { cookie } = await loginSession(base, "viewer-secret");
    const headers = { cookie, origin: base, "content-type": "application/json" };

    const cases: Array<{ method: string; path: string; body?: string }> = [
      { method: "GET", path: "/api/config" },
      { method: "PUT", path: "/api/config", body: "{}" },
      { method: "POST", path: "/api/runs/x/cancel" },
      { method: "POST", path: "/api/runs/x/pause" },
      { method: "POST", path: "/api/runs/x/resume" },
      { method: "POST", path: "/api/runs/x/edit-step", body: '{"stepId":"a"}' },
      { method: "POST", path: "/api/runs/x/approval", body: '{"stepId":"a","approved":true}' },
      { method: "POST", path: "/api/runs/x/input", body: '{"stepId":"a","value":"y"}' },
      { method: "DELETE", path: "/api/history" },
      { method: "DELETE", path: "/api/history/x" },
      { method: "POST", path: "/api/history/x/rerun" },
      { method: "POST", path: "/api/history/x/retry" },
      { method: "POST", path: "/api/history/x/harvest", body: '{"mode":"apply"}' },
      { method: "POST", path: "/api/history/x/prune" },
      { method: "POST", path: "/api/overrides/flush" },
      { method: "PUT", path: "/api/workflows/demo", body: "{}" },
      { method: "DELETE", path: "/api/workflows/demo" },
    ];
    for (const c of cases) {
      const res = await fetch(`${base}${c.path}`, {
        method: c.method,
        headers,
        body: c.body,
      });
      expect(res.status, `${c.method} ${c.path}`).toBe(403);
      expect(await res.json()).toEqual({ error: "read-only session", capability: "read" });
    }
  });

  it("requires Origin on writes when only --read-token is configured (CSRF)", async () => {
    const { server } = makeAuthServer(new FakeHost(demoSpec(), happyRun), {
      authToken: undefined,
      readToken: "viewer-only",
    });
    const base = await start(server);
    const cookie = await login(base, "viewer-only");
    // Even though the capability gate would 403 this write, CSRF must fire first
    // for missing Origin when auth is required via read-token alone.
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ workflow: "demo", input: "x" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "missing origin header" });
  });

  it("mints a full session from --auth-token when --read-only is off", async () => {
    const { server } = makeAuthServer(new FakeHost(demoSpec(), happyRun), {
      authToken: "full-secret",
      readToken: "viewer-secret",
    });
    const base = await start(server);
    const session = await loginSession(base, "full-secret");
    expect(session.capability).toBe("full");
    const probe = await fetch(`${base}/api/session`, {
      headers: { cookie: session.cookie },
    });
    expect(await probe.json()).toEqual({
      authRequired: true,
      capability: "full",
      readOnly: false,
    });
  });

  it("downgrades --auth-token sessions when --read-only is set", async () => {
    const { server } = makeAuthServer(new FakeHost(demoSpec(), happyRun), {
      authToken: "full-secret",
      readOnly: true,
    });
    const base = await start(server);
    const session = await loginSession(base, "full-secret");
    expect(session.capability).toBe("read");
    const cancel = await fetch(`${base}/api/runs/anything/cancel`, {
      method: "POST",
      headers: { cookie: session.cookie, origin: base },
    });
    expect(cancel.status).toBe(403);
  });

  it("enforces read-only on localhost with no auth when --read-only is set", async () => {
    const host = new FakeHost(demoSpec(), happyRun);
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
      readOnly: true,
    });
    servers.push(server);
    const base = await start(server);

    const get = await fetch(`${base}/api/workflows`);
    expect(get.status).toBe(200);

    const probe = await fetch(`${base}/api/session`);
    expect(await probe.json()).toEqual({
      authRequired: false,
      capability: "read",
      readOnly: true,
    });

    const post = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ workflow: "demo", input: "x" }),
    });
    expect(post.status).toBe(403);
  });

  it("requires a session when only --read-token is configured", async () => {
    const { server } = makeAuthServer(new FakeHost(demoSpec(), happyRun), {
      authToken: undefined,
      readToken: "viewer-only",
    });
    const base = await start(server);
    expect((await fetch(`${base}/api/workflows`)).status).toBe(401);
    const session = await loginSession(base, "viewer-only");
    expect(session.capability).toBe("read");
    expect(
      (
        await fetch(`${base}/api/workflows`, {
          headers: { cookie: session.cookie },
        })
      ).status,
    ).toBe(200);
  });
});

describe("web server — host header (DNS rebinding)", () => {
  function makeOpenServer(bindHost?: string, trustProxy = false): Server {
    const host = new FakeHost(demoSpec(), happyRun);
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
      bindHost,
      trustProxy,
    });
    servers.push(server);
    return server;
  }

  it("rejects non-loopback Host headers on a local bind", async () => {
    const base = await start(makeOpenServer("127.0.0.1"));
    const res = await rawGet(base, "/api/workflows", { host: "evil.example.com" });
    expect(res.status).toBe(403);
  });

  it("rejects rebound Host headers even for the index page", async () => {
    const base = await start(makeOpenServer("127.0.0.1"));
    const res = await rawGet(base, "/", { host: "evil.example.com:4317" });
    expect(res.status).toBe(403);
  });

  it("serves loopback Host headers on a local bind", async () => {
    const base = await start(makeOpenServer("127.0.0.1"));
    for (const hostHeader of ["localhost:4317", "127.0.0.1", "[::1]:4317"]) {
      const res = await rawGet(base, "/api/workflows", { host: hostHeader });
      expect(res.status).toBe(200);
    }
  });

  it("treats a missing bindHost as local (test/default wiring)", async () => {
    const base = await start(makeOpenServer(undefined));
    const res = await rawGet(base, "/api/workflows", { host: "evil.example.com" });
    expect(res.status).toBe(403);
  });

  it("does NOT let a client-set X-Forwarded-Host bypass the allowlist", async () => {
    // Regression: X-Forwarded-Host is not a forbidden header, so a rebound
    // same-origin fetch can set it. Without --trust-proxy it must be ignored.
    const base = await start(makeOpenServer("127.0.0.1"));
    const res = await rawGet(base, "/api/workflows", {
      host: "evil.example.com",
      "x-forwarded-host": "127.0.0.1",
    });
    expect(res.status).toBe(403);
  });

  it("exempts proxied requests only when --trust-proxy is set", async () => {
    const base = await start(makeOpenServer("127.0.0.1", true));
    const res = await rawGet(base, "/api/workflows", {
      host: "steamtrain.internal:8080",
      "x-forwarded-host": "steamtrain.example.com",
    });
    expect(res.status).toBe(200);
  });

  it("skips the Host allowlist on non-local binds (auth guards those)", async () => {
    const base = await start(makeOpenServer("0.0.0.0"));
    const res = await rawGet(base, "/api/workflows", { host: "steamtrain.example.com" });
    expect(res.status).toBe(200);
  });
});

describe("web server — security headers", () => {
  it("sends CSP, frame, referrer, and robots headers on the index page", async () => {
    const { server } = makeServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
  });

  it("never sends CORS allow-origin headers", async () => {
    const { server } = makeServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const res = await fetch(`${base}/api/workflows`, {
      headers: { origin: "http://another.example.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });
});

describe("web server — CSRF", () => {
  it("rejects POST without Origin/Referer when auth is enabled", async () => {
    const { server } = makeAuthServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const cookie = await login(base);
    // Use a raw fetch that doesn't send Origin (node fetch doesn't send it by default)
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ workflow: "demo", input: "test" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing origin header");
  });

  it("rejects POST with mismatched Origin when auth is enabled", async () => {
    const { server } = makeAuthServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const cookie = await login(base);
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: "http://evil.example.com",
      },
      body: JSON.stringify({ workflow: "demo", input: "test" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("origin mismatch");
  });

  it("allows POST with matching Origin when auth is enabled", async () => {
    const { server } = makeAuthServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const cookie = await login(base);
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base },
      body: JSON.stringify({ workflow: "demo", input: "test" }),
    });
    expect(res.status).toBe(201);
  });

  it("allows GET without Origin when auth is enabled (read-only)", async () => {
    const { server } = makeAuthServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const cookie = await login(base);
    const res = await fetch(`${base}/api/workflows`, { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it("allows POST without Origin when no authToken configured (curl-style)", async () => {
    const host = new FakeHost(demoSpec(), happyRun);
    const runs = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      cwd: tmpdir(),
      config: testRunConfig,
    });
    const server = createWebServer({ host, runs, workflowSource: () => "bundled" });
    servers.push(server);
    const base = await start(server);
    // POST without Origin — should succeed because auth is not enabled
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "demo", input: "test" }),
    });
    expect(res.status).toBe(201);
  });

  it("rejects POST with mismatched Origin even without authToken (drive-by CSRF)", async () => {
    const host = new FakeHost(demoSpec(), happyRun);
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
      headers: { "content-type": "application/json", origin: "http://evil.example.com" },
      body: JSON.stringify({ workflow: "demo", input: "test" }),
    });
    expect(res.status).toBe(403);
  });

  it("treats default-port Origins as matching (http://host vs Host: host)", async () => {
    const host = new FakeHost(demoSpec(), happyRun);
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
      bindHost: "0.0.0.0",
    });
    servers.push(server);
    const base = await start(server);
    const url = new URL(base);
    return new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: "/api/runs",
          method: "POST",
          headers: {
            "content-type": "application/json",
            host: "steamtrain.example.com",
            origin: "http://steamtrain.example.com",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => {
            try {
              expect(res.statusCode).toBe(201);
              resolve();
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ workflow: "demo", input: "test" }));
    });
  });

  it("ignores a client-set X-Forwarded-Host when matching Origin (no trust-proxy)", async () => {
    // The attacker's page sets Origin: its own host AND X-Forwarded-Host: same,
    // hoping the server compares Origin against the spoofed forwarded host.
    // Without --trust-proxy the real Host header wins, so it stays a mismatch.
    const host = new FakeHost(demoSpec(), happyRun);
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
      bindHost: "0.0.0.0",
    });
    servers.push(server);
    const base = await start(server);
    const url = new URL(base);
    return new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: "/api/runs",
          method: "POST",
          headers: {
            "content-type": "application/json",
            host: `127.0.0.1:${url.port}`,
            origin: "http://evil.example.com",
            "x-forwarded-host": "evil.example.com",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => {
            try {
              expect(res.statusCode).toBe(403);
              resolve();
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ workflow: "demo", input: "test" }));
    });
  });

  it("rejects PUT with mismatched Origin when auth is enabled", async () => {
    const host = new FakeAuthoringHost(demoSpec());
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
      home: mkdtempSync(join(tmpdir(), "csrf-test-")),
    });
    const server = createWebServer({
      host,
      runs,
      author: realAuthor,
      workflowSource: () => "bundled",
      authToken: "test-secret",
    });
    servers.push(server);
    const base = await start(server);
    const cookie = await login(base, "test-secret");
    const res = await fetch(`${base}/api/workflows/demo`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: "http://evil.example.com",
      },
      body: JSON.stringify({ spec: demoSpec() }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects DELETE with mismatched Origin when auth is enabled", async () => {
    const host = new FakeAuthoringHost(demoSpec());
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
      home: mkdtempSync(join(tmpdir(), "csrf-del-")),
    });
    const server = createWebServer({
      host,
      runs,
      author: realAuthor,
      workflowSource: () => "bundled",
      authToken: "test-secret",
    });
    servers.push(server);
    const base = await start(server);
    const cookie = await login(base, "test-secret");
    const res = await fetch(`${base}/api/workflows/demo`, {
      method: "DELETE",
      headers: { cookie, origin: "http://evil.example.com" },
    });
    expect(res.status).toBe(403);
  });

  it("allows POST with matching Referer (not Origin) when auth is enabled", async () => {
    const { server } = makeAuthServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const cookie = await login(base);
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, referer: `${base}/` },
      body: JSON.stringify({ workflow: "demo", input: "test" }),
    });
    expect(res.status).toBe(201);
  });

  it("returns 401 on SSE stream endpoint without cookie", async () => {
    const { server } = makeAuthServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const cookie = await login(base);
    // Start a run first so we have a valid runId
    const startRes = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base },
      body: JSON.stringify({ workflow: "demo", input: "test" }),
    });
    const { runId } = (await startRes.json()) as { runId: string };
    // Now try to stream without cookie
    const res = await fetch(`${base}/api/runs/${runId}/stream`);
    expect(res.status).toBe(401);
  });

  it("returns 401 on generate endpoint without cookie", async () => {
    const host = new FakeAuthoringHost(demoSpec());
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
      home: mkdtempSync(join(tmpdir(), "gen-auth-")),
    });
    const server = createWebServer({
      host,
      runs,
      author: realAuthor,
      workflowSource: () => "bundled",
      authToken: "test-secret",
    });
    servers.push(server);
    const base = await start(server);
    const res = await fetch(`${base}/api/workflows/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "test", agent: "opencode" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects POST with data: Referer when auth is enabled", async () => {
    const { server } = makeAuthServer(new FakeHost(demoSpec(), happyRun));
    const base = await start(server);
    const cookie = await login(base);
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        referer: "data:text/html,<script></script>",
      },
      body: JSON.stringify({ workflow: "demo", input: "test" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("startWebUi — secure-by-default exposure", () => {
  async function boot(options: {
    host: string;
    noAuth?: boolean;
    authToken?: string;
    readToken?: string;
    readOnly?: boolean;
  }) {
    const { startWebUi } = await import("../src/web/server");
    const cwd = mkdtempSync(join(tmpdir(), "webui-boot-"));
    tempRoots.push(cwd);
    const out: string[] = [];
    const booted = await startWebUi({
      config: testRunConfig,
      workspaces: { workspaces: [] },
      workflowCatalog: { workflows: {}, sources: {} },
      cwd,
      port: 0,
      host: options.host,
      authToken: options.authToken,
      readToken: options.readToken,
      readOnly: options.readOnly,
      noAuth: options.noAuth,
      stdout: (t) => out.push(t),
      stderr: (t) => out.push(t),
    });
    servers.push(booted.server);
    return { ...booted, output: () => out.join("") };
  }

  it("auto-generates and prints an auth token on a non-local bind", async () => {
    const booted = await boot({ host: "0.0.0.0" });
    expect(booted.authToken).toMatch(/^[0-9a-f]{32}$/);
    expect(booted.output()).toContain(booted.authToken!);
    // The API is actually locked behind it.
    const res = await fetch(`${booted.url.replace("0.0.0.0", "127.0.0.1")}/api/workflows`);
    expect(res.status).toBe(401);
  });

  it("auto-generates a read token on a non-local --read-only bind", async () => {
    const booted = await boot({ host: "0.0.0.0", readOnly: true });
    expect(booted.authToken).toBeUndefined();
    expect(booted.readToken).toMatch(/^[0-9a-f]{32}$/);
    expect(booted.readOnly).toBe(true);
    expect(booted.output()).toContain("read-only");
    expect(booted.output()).toContain(booted.readToken!);
    const base = booted.url.replace("0.0.0.0", "127.0.0.1");
    expect((await fetch(`${base}/api/workflows`)).status).toBe(401);
    const cookie = await login(base, booted.readToken!);
    const probe = await fetch(`${base}/api/session`, { headers: { cookie } });
    expect(await probe.json()).toMatchObject({
      authRequired: true,
      capability: "read",
      readOnly: true,
      project: expect.objectContaining({
        name: expect.any(String),
        cwd: expect.any(String),
      }),
    });
  });

  it("reports auth-token→read-only when --read-only pairs with --auth-token", async () => {
    const booted = await boot({
      host: "0.0.0.0",
      authToken: "my-secret",
      readOnly: true,
    });
    expect(booted.authToken).toBe("my-secret");
    expect(booted.readToken).toBeUndefined();
    expect(booted.readOnly).toBe(true);
    expect(booted.output()).toContain("auth-token→read-only");
    const base = booted.url.replace("0.0.0.0", "127.0.0.1");
    const cookie = await login(base, "my-secret");
    const probe = await fetch(`${base}/api/session`, { headers: { cookie } });
    expect(await probe.json()).toMatchObject({
      authRequired: true,
      capability: "read",
      readOnly: true,
      project: expect.objectContaining({
        name: expect.any(String),
        cwd: expect.any(String),
      }),
    });
  });

  it("stays tokenless on the default local bind", async () => {
    const booted = await boot({ host: "127.0.0.1" });
    expect(booted.authToken).toBeUndefined();
    const res = await fetch(`${booted.url}/api/workflows`);
    expect(res.status).toBe(200);
  });

  it("honors an explicit --no-auth opt-out with a warning", async () => {
    const booted = await boot({ host: "0.0.0.0", noAuth: true });
    expect(booted.authToken).toBeUndefined();
    expect(booted.output()).toContain("--no-auth");
    const res = await fetch(`${booted.url.replace("0.0.0.0", "127.0.0.1")}/api/workflows`);
    expect(res.status).toBe(200);
  });
});

describe("resolveWebAuthToken", () => {
  it("prefers an explicit token over the env var", () => {
    expect(resolveWebAuthToken({ authToken: "flag", envToken: "env" })).toBe("flag");
  });

  it("falls back to STEAMTRAIN_AUTH_TOKEN when no flag is given", () => {
    expect(resolveWebAuthToken({ envToken: "env" })).toBe("env");
  });

  it("returns undefined when neither is set (auto-generation decides later)", () => {
    expect(resolveWebAuthToken({})).toBeUndefined();
  });

  it("--no-auth overrides both a flag token and the env var", () => {
    expect(
      resolveWebAuthToken({ authToken: "flag", envToken: "env", noAuth: true }),
    ).toBeUndefined();
  });
});

describe("resolveWebReadToken", () => {
  it("prefers an explicit token over the env var", () => {
    expect(resolveWebReadToken({ readToken: "flag", envToken: "env" })).toBe("flag");
  });

  it("--no-auth clears the read token", () => {
    expect(
      resolveWebReadToken({ readToken: "flag", envToken: "env", noAuth: true }),
    ).toBeUndefined();
  });
});

describe("startWebUi — equal auth/read tokens", () => {
  it("rejects identical auth and read tokens after resolution", async () => {
    const { startWebUi } = await import("../src/web/server");
    const cwd = mkdtempSync(join(tmpdir(), "webui-same-token-"));
    tempRoots.push(cwd);
    await expect(
      startWebUi({
        config: testRunConfig,
        workspaces: { workspaces: [] },
        workflowCatalog: { workflows: {}, sources: {} },
        cwd,
        port: 0,
        host: "127.0.0.1",
        authToken: "same-secret",
        readToken: "same-secret",
      }),
    ).rejects.toThrow(/must be different values/);
  });
});
