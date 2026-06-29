import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgentMeta } from "../agents/agent-meta";
import { refreshAgentCatalogCaches } from "../agents/models";
import type { SteamtrainConfig } from "../config";
import { saveProjectConfig } from "../config/project-config";
import { type DoctorResult, runDoctor } from "../doctor";
import { Orchestrator } from "../orchestrator";
import {
  DEFAULT_STEP_TIMEOUT_SEC,
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
  resolveStepTimeoutSec,
  workflowSpecSchema,
  workflowStepKind,
} from "../workflow";
import type { WorkspaceConfig } from "../workspace";
import { type PageAssetRevisions, renderIndex } from "./html";
import { TooManyRuns, type WorkflowHost, WorkflowRunManager } from "./runs";

const DEFAULT_MAX_CONCURRENT_GENERATIONS = 2;
let activeGenerations = 0;
let maxConcurrentGenerations = DEFAULT_MAX_CONCURRENT_GENERATIONS;

/**
 * Locate the static web-assets directory.
 *
 * In development (`bun src/index.tsx`) the running module is `src/web/server.ts`
 * and the assets live next to it at `src/web/public/`. After the production
 * build (`tsup`) every web file is bundled into `dist/index.js` and the assets
 * are copied next to it at `dist/public/` by `scripts/copy-assets.ts`, so
 * `import.meta.url` resolves there and the same lookup works at runtime.
 */
function resolvePublicDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "public"), resolve(here, "..", "web", "public")];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "app.js"))) return candidate;
  }
  // Fall back to the first candidate so the error surfaced to the operator
  // points at the expected location.
  return candidates[0]!;
}

const PUBLIC_DIR = resolvePublicDir();

interface StaticAsset {
  /** Filesystem-relative path inside {@link PUBLIC_DIR} (e.g. `app.js`). */
  relPath: string;
  body: Buffer;
  /** First 16 hex chars of the asset's SHA-256, used in cache-busting URLs.
   * 16 chars (64 bits) is well beyond any plausible collision space for three
   * small files and keeps the `?v=` token short enough to live in any cache
   * key or log line. */
  rev: string;
  mime: string;
}

function loadAsset(relPath: string, mime: string): StaticAsset | null {
  const file = join(PUBLIC_DIR, relPath);
  if (!existsSync(file)) return null;
  const body = readFileSync(file);
  const rev = createHash("sha256").update(body).digest("hex").slice(0, 16);
  return { relPath, body, rev, mime };
}

// Loaded once at module init and never re-read. Tests and production serve
// from this in-memory snapshot, so the immutable /static/* cache headers are
// always consistent with the `?v=` revisions embedded by renderIndex(). The
// trade-off: editing `app.js` / `app.css` on disk while the dev server is
// running will NOT take effect until the process restarts (bun src/index.tsx).
const STATIC_ASSETS: Record<string, StaticAsset | null> = {
  "/static/app.css": loadAsset("app.css", "text/css; charset=utf-8"),
  "/static/app.js": loadAsset("app.js", "text/javascript; charset=utf-8"),
  "/static/steamtrain-reducer.bundle.js": loadAsset(
    "steamtrain-reducer.bundle.js",
    "text/javascript; charset=utf-8",
  ),
};

const PUBLIC_REVISIONS: PageAssetRevisions = {
  bundle: STATIC_ASSETS["/static/steamtrain-reducer.bundle.js"]?.rev ?? "",
  appJs: STATIC_ASSETS["/static/app.js"]?.rev ?? "",
  appCss: STATIC_ASSETS["/static/app.css"]?.rev ?? "",
};

/**
 * Status reported by {@link publicAssetsLoaded}. Useful for diagnostics when
 * the static assets can't be found (e.g., a stale build).
 */
export function publicAssetsLoaded(): boolean {
  return Object.values(STATIC_ASSETS).every((a) => a !== null);
}

/**
 * Names of the static web assets that were not found on disk at module init,
 * in the form they appear in `/static/*` URLs (e.g. `"/static/app.js"`).
 * Empty when every asset loaded successfully.
 */
export function missingPublicAssets(): string[] {
  return Object.entries(STATIC_ASSETS)
    .filter(([, a]) => a === null)
    .map(([path]) => path);
}

export interface WebServerDeps {
  host: WorkflowHost;
  runs: WorkflowRunManager;
  /** Optional authoring service; when absent, create/edit/delete routes 501. */
  author?: WorkflowAuthor;
  /** Optional run history; when absent, history routes return empty/404. */
  history?: WorkflowHistoryStore;
  workflowSource?: (name: string) => WorkflowSourceKind | undefined;
  doctor?: () => DoctorResult[];
  doctorError?: () => string | null;
  setDoctor?: (doctor: DoctorResult[]) => void;
  configLabel?: string;
  /** The host address the server is bound to. Used for CORS decisions. */
  bindHost?: string;
  /** Live project config (mutated in place when saved via /api/config). */
  config?: SteamtrainConfig;
  configPath?: string;
}

function isNonLocalHost(host?: string): boolean {
  if (!host) return false;
  return host !== "127.0.0.1" && host !== "::1" && host !== "localhost";
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

/** Maximum workflow name length. */
const MAX_WORKFLOW_NAME = 128;

function isValidWorkflowName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_WORKFLOW_NAME) return false;
  // Reject control characters and null bytes.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control char rejection
  return !/[\x00-\x1f\x7f]/.test(name);
}

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
    if (totalBytes > MAX_BODY_BYTES) {
      throw new PayloadTooLarge();
    }
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
          err instanceof PayloadTooLarge ? "payload too large" : "internal server error";
        sendJson(res, status, { error });
        // Drain any remaining body data to free memory
        if (err instanceof PayloadTooLarge) req.destroy();
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

  if (isNonLocalHost(deps.bindHost)) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
  }

  if (method === "GET" && (path === "/" || path === "/index.html")) {
    // The page itself is `no-store` so a fresh release swaps in the new
    // cache-busted asset hashes on the next navigation.
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      // Scripts are now external; only inline `style="..."` attributes remain
      // (marking `style-src 'unsafe-inline'` keeps those painting).
      "content-security-policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'",
    });
    res.end(renderIndex(PUBLIC_REVISIONS));
    return;
  }

  if (method === "GET" && path.startsWith("/static/")) {
    const asset = STATIC_ASSETS[path];
    if (!asset) {
      sendJson(res, 404, { error: `unknown static asset: ${path}` });
      return;
    }
    // Immutable content-hashed URLs let every cache between the server and the
    // browser keep the asset forever; the index page changes its `?v=`
    // whenever the bytes do.
    res.writeHead(200, {
      "content-type": asset.mime,
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    });
    res.end(asset.body);
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

  if (method === "GET" && path === "/api/config") {
    const cfg = deps.config;
    if (!cfg) {
      sendJson(res, 404, { error: "config is not available" });
      return;
    }
    const stepTimeoutSec = resolveStepTimeoutSec(undefined, undefined, cfg);
    sendJson(res, 200, {
      stepTimeoutSec,
      workflowTimeoutSec: cfg.workflowTimeoutSec,
      defaultStepTimeoutSec: DEFAULT_STEP_TIMEOUT_SEC,
      configPath: deps.configPath,
      agents: buildAgentMeta(
        cfg,
        (agent) => (deps.doctor?.() ?? []).some((d) => d.agent === agent && d.status === "ok"),
        { includeDisabled: true, includeConfig: true },
      ),
    });
    return;
  }

  if (method === "PUT" && path === "/api/config") {
    if (!deps.config || !deps.configPath) {
      sendJson(res, 501, { error: "project config is not writable" });
      return;
    }
    const body = await readBody(req);
    let parsed: {
      stepTimeoutSec?: unknown;
      workflowTimeoutSec?: unknown;
      clearWorkflowTimeout?: unknown;
      agents?: unknown;
    };
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    const hasStep = typeof parsed.stepTimeoutSec === "number" && parsed.stepTimeoutSec > 0;
    const hasWf = typeof parsed.workflowTimeoutSec === "number" && parsed.workflowTimeoutSec > 0;
    const clearWf = Boolean(parsed.clearWorkflowTimeout);
    const hasAgents = parsed.agents !== undefined;
    if (!hasStep && !hasWf && !clearWf && !hasAgents) {
      sendJson(res, 400, {
        error:
          "body must include stepTimeoutSec, workflowTimeoutSec, clearWorkflowTimeout, or agents",
      });
      return;
    }
    const patch: Partial<
      Pick<SteamtrainConfig, "stepTimeoutSec" | "workflowTimeoutSec" | "agents">
    > = {};
    if (hasStep) patch.stepTimeoutSec = parsed.stepTimeoutSec as number;
    if (clearWf) patch.workflowTimeoutSec = undefined;
    else if (hasWf) patch.workflowTimeoutSec = parsed.workflowTimeoutSec as number;
    if (hasAgents) patch.agents = parsed.agents as SteamtrainConfig["agents"];
    const saved = saveProjectConfig(patch, deps.configPath);
    if (!saved.ok || !saved.config) {
      sendJson(res, 400, { error: saved.error ?? "save failed" });
      return;
    }
    Object.assign(deps.config, saved.config);
    if (hasAgents) {
      try {
        const results = await runDoctor(deps.config);
        deps.setDoctor?.(results);
        await refreshAgentCatalogCaches(deps.config, results);
      } catch {
        // The regular doctor polling endpoint will report the previous state if refresh fails.
      }
    }
    sendJson(res, 200, {
      ok: true,
      stepTimeoutSec: resolveStepTimeoutSec(undefined, undefined, deps.config),
      workflowTimeoutSec: deps.config.workflowTimeoutSec,
      agents: buildAgentMeta(
        deps.config,
        (agent) => (deps.doctor?.() ?? []).some((d) => d.agent === agent && d.status === "ok"),
        { includeDisabled: true, includeConfig: true },
      ),
    });
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

    if (!isValidWorkflowName(name)) {
      sendJson(res, 400, { error: "invalid workflow name" });
      return;
    }

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
      const specCheck = workflowSpecSchema.safeParse(parsed.spec);
      if (!specCheck.success) {
        sendJson(res, 400, {
          error: `invalid workflow spec: ${specCheck.error.issues[0]?.message ?? "schema error"}`,
        });
        return;
      }
      const previousName =
        typeof parsed.previousName === "string" ? parsed.previousName : undefined;
      const scope = parsed.scope === "project" ? "project" : "user";
      const result = await deps.author.save(name, { ...specCheck.data, name }, previousName, scope);
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }

    if (method === "DELETE") {
      if (!deps.author) {
        sendJson(res, 501, { error: "workflow authoring is not enabled" });
        return;
      }
      const result = await deps.author.remove(name);
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }
  }

  if (method === "GET" && path === "/api/doctor") {
    const doctorError = deps.doctorError?.();
    sendJson(res, 200, {
      doctor: deps.doctor?.() ?? [],
      ...(doctorError ? { doctorError } : {}),
    });
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
    try {
      const result = deps.runs.rerunFromRecord(record, mode);
      if (!result.ok) {
        sendJson(res, 400, { error: result.error });
        return;
      }
      sendJson(res, 201, { runId: result.runId, downgraded: result.downgraded });
    } catch (err) {
      if (err instanceof TooManyRuns) {
        sendJson(res, 503, { error: err.message });
      } else {
        throw err;
      }
    }
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
    try {
      const result = deps.runs.start(parsed.workflow, parsed.input, {
        fresh: parsed.fresh === true,
      });
      if (!result.ok) {
        sendJson(res, 400, { error: result.error });
        return;
      }
      sendJson(res, 201, { runId: result.runId });
    } catch (err) {
      if (err instanceof TooManyRuns) {
        sendJson(res, 503, { error: err.message });
      } else {
        throw err;
      }
    }
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
  if (typeof parsed.name === "string" && !isValidWorkflowName(parsed.name)) {
    sendJson(res, 400, { error: "invalid workflow name" });
    return;
  }

  if (maxConcurrentGenerations > 0 && activeGenerations >= maxConcurrentGenerations) {
    sendJson(res, 503, {
      error: `too many concurrent generations (max ${maxConcurrentGenerations})`,
    });
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

  activeGenerations += 1;
  try {
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

    if (!res.writableEnded && !controller.signal.aborted) {
      send({ type: "done", ...result });
      res.end();
    } else if (!res.writableEnded) {
      res.end();
    }
  } finally {
    activeGenerations -= 1;
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
  /** Maximum concurrent workflow runs. 0 = unlimited. */
  maxConcurrent?: number;
  /** Maximum concurrent LLM generations. 0 = unlimited. Default 2. */
  maxConcurrentGenerations?: number;
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

  const liveConfig: SteamtrainConfig = { ...options.config };
  const orchestrator = new Orchestrator(
    liveConfig,
    options.workspaces,
    [],
    options.workflowCatalog,
  );

  // Health is reported live via /api/doctor; the page must not wait on it (the
  // doctor probes agent binaries and can take seconds), so we serve immediately
  // and let the catalog/health populate in the background.
  const doctorState = { results: [] as DoctorResult[], error: null as string | null };

  const cacheStore = createWorkflowCacheStore(join(cwd, WORKFLOW_CACHE_DIR));
  const historyStore = createWorkflowHistoryStore(join(cwd, WORKFLOW_HISTORY_DIR));
  maxConcurrentGenerations = options.maxConcurrentGenerations ?? DEFAULT_MAX_CONCURRENT_GENERATIONS;
  const runs = new WorkflowRunManager({
    host: orchestrator,
    cacheStore,
    historyStore,
    cwd,
    maxConcurrent: options.maxConcurrent ?? 5,
    config: liveConfig,
  });
  const author = new WorkflowAuthor({
    host: orchestrator,
    config: liveConfig,
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
    doctor: () => doctorState.results,
    doctorError: () => doctorState.error,
    setDoctor: (results) => {
      doctorState.results = results;
      doctorState.error = null;
      orchestrator.setDoctor(results);
    },
    configLabel: options.configLabel,
    bindHost: host,
    config: liveConfig,
    configPath: options.configPath,
  });

  // Fail loudly and early when the static web assets are missing instead of
  // silently serving a broken UI (empty `?v=` revisions + 404 on every
  // /static/* request). This typically means `bun scripts/copy-assets.ts`
  // wasn't run after `tsup`, or the dev source tree was modified without
  // re-running `bun scripts/build-reducer.ts`.
  const missing = missingPublicAssets();
  if (missing.length > 0) {
    err(
      `\n⚠️  steamtrain web UI is missing static assets: ${missing.join(", ")}\n   Rebuild them with \`bun scripts/build-reducer.ts\` (dev) or \`bun scripts/copy-assets.ts\` (after \`tsup\`).\n   Expected location: ${PUBLIC_DIR}\n`,
    );
  }

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
      const results = await runDoctor(liveConfig);
      orchestrator.setDoctor(results);
      await refreshAgentCatalogCaches(liveConfig, results);
      doctorState.results = results;
      const bad = results.filter((d) => d.status !== "ok").map((d) => d.agent);
      out(
        bad.length
          ? `   agent health: ${results.length - bad.length}/${results.length} ok (down: ${bad.join(", ")})\n`
          : `   agent health: all ${results.length} agents ok\n`,
      );
    } catch (e) {
      doctorState.error = e instanceof Error ? e.message : String(e);
      err(`   doctor failed: ${doctorState.error}\n`);
    }
  })();

  return {
    server,
    url,
    get doctor() {
      return doctorState.results;
    },
  };
}
