import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { refreshAgentCatalogCaches } from "../agents/models";
import type { SteamtrainConfig } from "../config";
import { type DoctorResult, runDoctor } from "../doctor";
import { Orchestrator } from "../orchestrator";
import {
  type LoadedWorkflowCatalog,
  WORKFLOW_CACHE_DIR,
  WORKFLOW_HISTORY_DIR,
  WorkflowAuthor,
  type WorkflowHistoryStore,
  type WorkflowSourceKind,
  type WorkflowSpec,
  createWorkflowCacheStore,
  createWorkflowHistoryStore,
  isAgentBackedStep,
  workflowStepKind,
} from "../workflow";
import type { WorkspaceConfig } from "../workspace";
import { PAGE_HTML } from "./html";
import { type WorkflowHost, WorkflowRunManager } from "./runs";

export interface WebServerDeps {
  host: WorkflowHost;
  runs: WorkflowRunManager;
  /** Optional authoring service; when absent, create/edit/delete routes 501. */
  author?: WorkflowAuthor;
  /** Optional run history; when absent, history routes return empty/404. */
  history?: WorkflowHistoryStore;
  workflowSource?: (name: string) => WorkflowSourceKind | undefined;
  doctor?: () => DoctorResult[];
  configLabel?: string;
}

interface WorkflowListItem {
  name: string;
  source: WorkflowSourceKind | "unknown";
  description?: string;
  phaseCount: number;
  stepCount: number;
  kinds: Record<string, number>;
  agents: string[];
}

function summarizeWorkflow(
  name: string,
  spec: WorkflowSpec,
  source: WorkflowSourceKind | undefined,
): WorkflowListItem {
  const kinds: Record<string, number> = {};
  const agents = new Set<string>();
  let stepCount = 0;
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      stepCount += 1;
      const kind = workflowStepKind(step);
      kinds[kind] = (kinds[kind] ?? 0) + 1;
      if (isAgentBackedStep(step)) agents.add(step.agent);
    }
  }
  return {
    name,
    source: source ?? "unknown",
    description: spec.description,
    phaseCount: spec.phases.length,
    stepCount,
    kinds,
    agents: [...agents],
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(text);
}

/** Maximum body size: 1 MiB. Rejects larger payloads with HTTP 413. */
const MAX_BODY_BYTES = 1 * 1024 * 1024;

class PayloadTooLarge extends Error {
  constructor() {
    super("payload too large");
    this.name = "PayloadTooLarge";
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    totalBytes += buf.length;
    if (totalBytes > MAX_BODY_BYTES) throw new PayloadTooLarge();
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Build the steamtrain web-UI HTTP server. Pure wiring over an injected
 * {@link WorkflowHost} and {@link WorkflowRunManager}, so it can be exercised in
 * tests with fakes and started for real by {@link startWebUi}.
 *
 * Routes:
 *   GET    /                        the single-page app
 *   GET    /api/workflows           catalog summaries
 *   GET    /api/workflows/:name     full spec (for visualization)
 *   PUT    /api/workflows/:name     save a created/edited workflow (authoring)
 *   DELETE /api/workflows/:name     delete a user workflow (authoring)
 *   POST   /api/workflows/generate  SSE: LLM-draft a workflow + save (authoring)
 *   GET    /api/meta                agents, models, efforts, health (authoring)
 *   GET    /api/doctor              agent health
 *   GET    /api/history             past-run summaries (newest first)
 *   GET    /api/history/:id         one past run's full record
 *   DELETE /api/history             clear all past runs
 *   DELETE /api/history/:id         delete one past run
 *   POST   /api/history/:id/rerun   re-run a past run -> { runId }
 *   POST   /api/history/:id/retry   retry failed steps -> { runId, downgraded? }
 *   POST   /api/runs                { workflow, input, fresh? } -> { runId }
 *   GET    /api/runs/:id/stream     SSE of WorkflowEvents + terminal status
 *   POST   /api/runs/:id/cancel     abort a run
 */
export function createWebServer(deps: WebServerDeps): Server {
  return createServer((req, res) => {
    void handle(req, res, deps).catch((err) => {
      if (!res.headersSent) {
        const status = err instanceof PayloadTooLarge ? 413 : 500;
        const error =
          err instanceof PayloadTooLarge
            ? "payload too large"
            : "internal server error";
        sendJson(res, status, { error });
      } else {
        res.end();
      }
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebServerDeps,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && (path === "/" || path === "/index.html")) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
    });
    res.end(PAGE_HTML);
    return;
  }

  if (method === "GET" && path === "/api/workflows") {
    const all = deps.host.listWorkflows();
    const items = Object.entries(all)
      .map(([name, spec]) => summarizeWorkflow(name, spec, deps.workflowSource?.(name)))
      .sort((a, b) => a.name.localeCompare(b.name));
    sendJson(res, 200, { workflows: items, configLabel: deps.configLabel });
    return;
  }

  if (method === "GET" && path === "/api/meta") {
    if (!deps.author) {
      sendJson(res, 200, { agents: [] });
      return;
    }
    sendJson(res, 200, { agents: deps.author.agentMeta() });
    return;
  }

  // Draft a workflow from a description; streams the agent's output as SSE and a
  // terminal `done` frame with the saved spec (or an error).
  if (method === "POST" && path === "/api/workflows/generate") {
    if (!deps.author) {
      sendJson(res, 501, { error: "workflow authoring is not enabled" });
      return;
    }
    await streamGenerate(req, res, deps.author);
    return;
  }

  const wfMatch = path.match(/^\/api\/workflows\/([^/]+)$/);
  if (wfMatch) {
    const name = decodeURIComponent(wfMatch[1]!);

    if (method === "GET") {
      const spec = deps.host.listWorkflows()[name];
      if (!spec) {
        sendJson(res, 404, { error: `unknown workflow '${name}'` });
        return;
      }
      sendJson(res, 200, { name, source: deps.workflowSource?.(name) ?? "unknown", spec });
      return;
    }

    if (method === "PUT") {
      if (!deps.author) {
        sendJson(res, 501, { error: "workflow authoring is not enabled" });
        return;
      }
      const body = await readBody(req);
      let parsed: { spec?: unknown; previousName?: unknown; scope?: unknown };
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        sendJson(res, 400, { error: "invalid JSON body" });
        return;
      }
      if (!parsed.spec || typeof parsed.spec !== "object") {
        sendJson(res, 400, { error: "body must include a 'spec' object" });
        return;
      }
      const previousName =
        typeof parsed.previousName === "string" ? parsed.previousName : undefined;
      const scope = parsed.scope === "project" ? "project" : "user";
      const result = deps.author.save(name, parsed.spec as WorkflowSpec, previousName, scope);
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }

    if (method === "DELETE") {
      if (!deps.author) {
        sendJson(res, 501, { error: "workflow authoring is not enabled" });
        return;
      }
      const result = deps.author.remove(name);
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }
  }

  if (method === "GET" && path === "/api/doctor") {
    sendJson(res, 200, { doctor: deps.doctor?.() ?? [] });
    return;
  }

  if (path === "/api/history") {
    if (method === "GET") {
      const runs = deps.history ? await deps.history.list() : [];
      sendJson(res, 200, { runs });
      return;
    }
    if (method === "DELETE") {
      if (deps.history) await deps.history.clearAll();
      sendJson(res, 200, { cleared: true });
      return;
    }
  }

  const historyMatch = path.match(/^\/api\/history\/([^/]+)$/);
  if (historyMatch) {
    const id = decodeURIComponent(historyMatch[1]!);
    if (method === "GET") {
      const record = await deps.history?.get(id);
      if (!record) {
        sendJson(res, 404, { error: `unknown run '${id}'` });
        return;
      }
      sendJson(res, 200, { record });
      return;
    }
    if (method === "DELETE") {
      if (deps.history) await deps.history.remove(id);
      sendJson(res, 200, { deleted: true });
      return;
    }
  }

  const rerunMatch = path.match(/^\/api\/history\/([^/]+)\/(rerun|retry)$/);
  if (method === "POST" && rerunMatch) {
    const id = decodeURIComponent(rerunMatch[1]!);
    const mode = rerunMatch[2] === "retry" ? "retry-failed" : "rerun";
    const record = await deps.history?.get(id);
    if (!record) {
      sendJson(res, 404, { error: `unknown run '${id}'` });
      return;
    }
    const result = deps.runs.rerunFromRecord(record, mode);
    if (!result.ok) {
      sendJson(res, 400, { error: result.error });
      return;
    }
    sendJson(res, 201, { runId: result.runId, downgraded: result.downgraded });
    return;
  }

  if (method === "POST" && path === "/api/runs") {
    const body = await readBody(req);
    let parsed: { workflow?: unknown; input?: unknown; fresh?: unknown };
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    if (typeof parsed.workflow !== "string" || typeof parsed.input !== "string") {
      sendJson(res, 400, { error: "body must include string 'workflow' and 'input'" });
      return;
    }
    const result = deps.runs.start(parsed.workflow, parsed.input, {
      fresh: parsed.fresh === true,
    });
    if (!result.ok) {
      sendJson(res, 400, { error: result.error });
      return;
    }
    sendJson(res, 201, { runId: result.runId });
    return;
  }

  const streamMatch = path.match(/^\/api\/runs\/([^/]+)\/stream$/);
  if (method === "GET" && streamMatch) {
    streamRun(streamMatch[1]!, deps.runs, res);
    return;
  }

  const cancelMatch = path.match(/^\/api\/runs\/([^/]+)\/cancel$/);
  if (method === "POST" && cancelMatch) {
    const ok = deps.runs.cancel(cancelMatch[1]!);
    sendJson(res, ok ? 200 : 404, { canceled: ok });
    return;
  }

  sendJson(res, 404, { error: `not found: ${method} ${path}` });
}

/**
 * Run an LLM-delegated workflow generation over a streaming response. Each
 * `delta` frame carries a chunk of the drafting agent's output; the single
 * terminal `done` frame carries the validated/saved spec or an error. Aborting
 * the request (client navigates away / cancels) cancels the generation.
 */
async function streamGenerate(
  req: IncomingMessage,
  res: ServerResponse,
  author: WorkflowAuthor,
): Promise<void> {
  const body = await readBody(req);
  let parsed: {
    description?: unknown;
    agent?: unknown;
    model?: unknown;
    effort?: unknown;
    name?: unknown;
    scope?: unknown;
  };
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch {
    sendJson(res, 400, { error: "invalid JSON body" });
    return;
  }
  if (typeof parsed.description !== "string" || typeof parsed.agent !== "string") {
    sendJson(res, 400, { error: "body must include string 'description' and 'agent'" });
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "x-content-type-options": "nosniff",
    connection: "keep-alive",
  });
  res.write(": open\n\n");

  const controller = new AbortController();
  res.on("close", () => controller.abort());

  const send = (frame: unknown): void => {
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  };

  const result = await author.generate(
    {
      description: parsed.description,
      agent: parsed.agent as never,
      model: typeof parsed.model === "string" ? parsed.model : "",
      effort: typeof parsed.effort === "string" ? parsed.effort : undefined,
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      scope: parsed.scope === "project" ? "project" : "user",
    },
    (text) => send({ type: "delta", text }),
    controller.signal,
    // Auto-repair retry: tell the client to clear the live draft buffer so a
    // rejected draft and its repair don't concatenate.
    (attempt) => send({ type: "attempt", attempt }),
  );

  if (!res.writableEnded) {
    send({ type: "done", ...result });
    res.end();
  }
}

function streamRun(runId: string, runs: WorkflowRunManager, res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "x-content-type-options": "nosniff",
    connection: "keep-alive",
  });
  // A first comment line opens the stream promptly for the browser.
  res.write(": open\n\n");

  const write = (payload: string, terminal: boolean): void => {
    res.write(`data: ${payload}\n\n`);
    if (terminal) res.end();
  };

  const unsubscribe = runs.subscribe(runId, write);
  if (!unsubscribe) {
    res.write(
      `data: ${JSON.stringify({ type: "status", status: "error", error: "unknown run" })}\n\n`,
    );
    res.end();
    return;
  }
  res.on("close", () => unsubscribe());
}

export interface StartWebUiOptions {
  config: SteamtrainConfig;
  workspaces: WorkspaceConfig;
  workflowCatalog: LoadedWorkflowCatalog;
  configLabel?: string;
  cwd?: string;
  /** Resolved project `steamtrain.json` path for project-scope authoring. */
  configPath?: string;
  port?: number;
  host?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export const DEFAULT_WEB_PORT = 4317;
export const DEFAULT_WEB_HOST = "127.0.0.1";

/**
 * Boot the full web UI: build an orchestrator over the loaded catalog, run the
 * doctor once (so the picker shows agent health and runs are gated exactly like
 * the CLI), then serve until the process is stopped.
 */
export async function startWebUi(
  options: StartWebUiOptions,
): Promise<{ server: Server; url: string; doctor: DoctorResult[] }> {
  const out = options.stdout ?? ((t: string) => process.stdout.write(t));
  const err = options.stderr ?? ((t: string) => process.stderr.write(t));
  const cwd = options.cwd ?? process.cwd();
  const port = options.port ?? DEFAULT_WEB_PORT;
  const host = options.host ?? DEFAULT_WEB_HOST;

  const orchestrator = new Orchestrator(
    options.config,
    options.workspaces,
    [],
    options.workflowCatalog,
  );

  // Health is reported live via /api/doctor; the page must not wait on it (the
  // doctor probes agent binaries and can take seconds), so we serve immediately
  // and let the catalog/health populate in the background.
  let doctor: DoctorResult[] = [];

  const cacheStore = createWorkflowCacheStore(join(cwd, WORKFLOW_CACHE_DIR));
  const historyStore = createWorkflowHistoryStore(join(cwd, WORKFLOW_HISTORY_DIR));
  const runs = new WorkflowRunManager({ host: orchestrator, cacheStore, historyStore, cwd });
  const author = new WorkflowAuthor({
    host: orchestrator,
    config: options.config,
    home: homedir(),
    cwd,
    projectConfigPath: options.configPath,
    projectWorkflows: options.config.workflows,
  });
  const server = createWebServer({
    host: orchestrator,
    runs,
    author,
    history: historyStore,
    workflowSource: (name) => orchestrator.workflowSource(name),
    doctor: () => doctor,
    configLabel: options.configLabel,
  });

  const url = `http://${host}:${port}`;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  out(`\n🚂 steamtrain web UI running at ${url}\n`);
  out("   open it in your browser; press Ctrl+C to stop.\n");
  out("   checking agent health in the background…\n");

  void (async () => {
    try {
      const results = await runDoctor(options.config);
      orchestrator.setDoctor(results);
      await refreshAgentCatalogCaches(options.config, results);
      doctor = results;
      const bad = results.filter((d) => d.status !== "ok").map((d) => d.agent);
      out(
        bad.length
          ? `   agent health: ${results.length - bad.length}/${results.length} ok (down: ${bad.join(", ")})\n`
          : `   agent health: all ${results.length} agents ok\n`,
      );
    } catch (e) {
      err(`   doctor failed: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  })();

  return { server, url, doctor };
}
