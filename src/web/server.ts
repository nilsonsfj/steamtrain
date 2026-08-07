import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgentMeta } from "../agents/agent-meta";
import { listModelClasses, listModelFamilyMeta } from "../agents/model-resolve";
import { refreshAgentCatalogCaches } from "../agents/models";
import { buildApiMeta } from "../apis";
import type { AgentInstanceConfig, ApiInstanceConfig, SteamtrainConfig } from "../config";
import {
  DEFAULT_CONFIG,
  loadConfig,
  parseAgentsConfig,
  parseApisConfig,
  parseScopedInstancePayload,
  saveUserConfig,
  tagAgentsWithScope,
  tagApisWithScope,
  userConfigExists,
} from "../config";
import { saveProjectConfig } from "../config/project-config";
import {
  type ApiDoctorResult,
  type DoctorResult,
  describeEffectivePath,
  runApiDoctor,
  runDoctor,
} from "../doctor";
import { STEAMTRAIN_VERSION } from "../version";

import { Orchestrator } from "../orchestrator";
import type { ProjectIdentity } from "../project";
import { resolveProjectIdentity } from "../project";
import {
  DEFAULT_STEP_TIMEOUT_SEC,
  type LiveRunMeta,
  type LiveRunStore,
  type LoadedWorkflowCatalog,
  MAX_CONCURRENCY,
  MAX_WORKFLOW_NESTING_DEPTH,
  MergeConflictError,
  type PermissionSummary,
  WORKFLOW_CACHE_DIR,
  WORKFLOW_HISTORY_DIR,
  WORKFLOW_RUNS_DIR,
  WorkflowAuthor,
  type WorkflowAutonomy,
  type WorkflowHistoryStore,
  type WorkflowSessionOverrides,
  type WorkflowSourceKind,
  type WorkflowSpec,
  applyWorkflowSessionOverrides,
  applyWorkflowStepOverrides,
  createLiveRunStore,
  createWorkflowCacheStore,
  createWorkflowHistoryStore,
  finalRunWorktrees,
  formatPermissionSummary,
  harvestRunWorktrees,
  isAgentBackedStep,
  isTerminalLiveRunStatus,
  matchPendingApproval,
  matchPendingInput,
  mergeConflictGuidance,
  parseSessionOverrides,
  planHistoryContext,
  planWorkflow,
  pruneRunWorktrees,
  resolveInputs,
  resolveStepTimeoutSec,
  reviewShareWorkflow,
  workflowAutonomy,
  workflowPermissionPreflight,
  workflowPermissionSummary,
  workflowSpecSchema,
  workflowStepKind,
  worktreeDiff,
} from "../workflow";
import { diagnoseRun } from "../workflow";
import { isValidPathId } from "../workflow/fs-util";
import { DEFAULT_PATCH_CAP, capPatch } from "../workflow/unified-diff";
import type { WorkspaceConfig } from "../workspace";
import { FAVICON_SVG, type PageAssetRevisions, WEB_ASSETS, renderIndex } from "./html";
import { TooManyRuns, type WorkflowHost, WorkflowRunManager } from "./runs";

const DEFAULT_MAX_CONCURRENT_GENERATIONS = 2;

/** How long POST /api/runs/:id/edit-step waits for an external owner's verdict. */
const EXTERNAL_EDIT_RESULT_WAIT_MS = 2_500;
const EXTERNAL_EDIT_RESULT_POLL_MS = 150;

interface GenerationGate {
  active: number;
  max: number;
}

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
  // Probe the first manifest asset — whatever the client is split into, the
  // manifest's head is always present in a correctly built tree.
  const probe = WEB_ASSETS[0]!.file;
  for (const candidate of candidates) {
    if (existsSync(join(candidate, probe))) return candidate;
  }
  // Fall back to the first candidate so the error surfaced to the operator
  // points at the expected location.
  return candidates[0]!;
}

const PUBLIC_DIR = resolvePublicDir();

interface StaticAsset {
  /** Filesystem-relative path inside {@link PUBLIC_DIR} (e.g. `st-core.js`). */
  relPath: string;
  body: Buffer;
  /** First 16 hex chars of the asset's SHA-256, used in cache-busting URLs.
   * 16 chars (64 bits) is well beyond any plausible collision space for the
   * handful of small files in {@link WEB_ASSETS} and keeps the `?v=` token
   * short enough to live in any cache key or log line. */
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
// trade-off: editing a WEB_ASSETS file on disk while the dev server is
// running will NOT take effect until the process restarts (bun src/index.tsx).
const STATIC_ASSETS: Record<string, StaticAsset | null> = Object.fromEntries(
  WEB_ASSETS.map((a) => [`/static/${a.file}`, loadAsset(a.file, a.mime)]),
);

const PUBLIC_REVISIONS: PageAssetRevisions = Object.fromEntries(
  WEB_ASSETS.map((a) => [a.file, STATIC_ASSETS[`/static/${a.file}`]?.rev ?? ""]),
);

/**
 * Status reported by {@link publicAssetsLoaded}. Useful for diagnostics when
 * the static assets can't be found (e.g., a stale build).
 */
export function publicAssetsLoaded(): boolean {
  return Object.values(STATIC_ASSETS).every((a) => a !== null);
}

/**
 * Names of the static web assets that were not found on disk at module init,
 * in the form they appear in `/static/*` URLs (e.g. `"/static/st-core.js"`).
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
  /**
   * Optional shared live-run registry: lists CLI/TUI-owned in-flight runs
   * alongside the manager's own, and lets the stream/cancel/approval routes
   * reach runs owned by other processes.
   */
  liveRuns?: LiveRunStore;
  workflowSource?: (name: string) => WorkflowSourceKind | undefined;
  doctor?: () => DoctorResult[];
  doctorError?: () => string | null;
  setDoctor?: (doctor: DoctorResult[]) => void;
  /** Live API-instance readiness (direct-inference llm steps), like `doctor` for agents. */
  apiDoctor?: () => ApiDoctorResult[];
  setApiDoctor?: (apis: ApiDoctorResult[]) => void;
  /**
   * Re-run the agent doctor on demand (POST /api/doctor — the setup panel's
   * Recheck). The implementation persists the fresh results (updates the live
   * snapshot + orchestrator + catalog caches) and returns them. When absent,
   * the route falls back to `runDoctor(config)` + `setDoctor`.
   */
  reprobeDoctor?: () => Promise<DoctorResult[]>;
  /** Re-run the API readiness probes on demand; persists and returns them. */
  reprobeApiDoctor?: () => Promise<ApiDoctorResult[]>;
  configLabel?: string;
  /** Current project identity for chrome (name + directory). */
  project?: ProjectIdentity;
  /**
   * The host address the server is bound to. Local binds get a Host-header
   * allowlist (DNS-rebinding defense); non-local binds rely on auth instead.
   */
  bindHost?: string;
  /**
   * The operator has placed a trusted reverse proxy in front of the server.
   * Only then are `X-Forwarded-*` headers believed: for the cookie Secure
   * flag, origin comparison, rate-limit client identity, and lifting the
   * local-bind Host allowlist. Off by default, since those headers are
   * otherwise fully client-controlled.
   */
  trustProxy?: boolean;
  /** Live project config (mutated in place when saved via /api/config). */
  config?: SteamtrainConfig;
  configPath?: string;
  /**
   * Global `~/.steamtrain/config.json` path. Absent when running with a custom
   * `--config` file (no global layer). Agents/APIs default to this scope.
   */
  userConfigPath?: string;
  /**
   * Raw per-scope agent/API layers for the config editor. Mutated in place
   * after scoped saves so subsequent GET/PUT rounds see the latest entries.
   */
  configLayers?: {
    userAgents?: AgentInstanceConfig[];
    projectAgents?: AgentInstanceConfig[];
    userApis?: ApiInstanceConfig[];
    projectApis?: ApiInstanceConfig[];
  };
  /**
   * Reload defaults → user → project into {@link config} + {@link configLayers}
   * after a scoped save. Required so the live orchestrator sees merged state.
   */
  reloadConfig?: () => void;
  /**
   * When set, all API routes require a valid `__steamtrain_auth` session cookie.
   * POST /api/auth with the matching token creates a random, server-side
   * session and sets the cookie; sessions expire after {@link SESSION_TTL_MS}
   * and die with the process. Full-capability sessions unless {@link readOnly}
   * is also set.
   */
  authToken?: string;
  /**
   * Optional second credential. POST /api/auth with this token creates a
   * **read-only** session: GET routes and logout work; every state-changing
   * route returns 403. Intended for sharing a run view with teammates without
   * handing them the full control-plane token. Auth is required when either
   * this or {@link authToken} is set.
   */
  readToken?: string;
  /**
   * Force every session (and the no-auth localhost path) into read-only
   * capability. Useful for a dedicated share bind: even the full auth token
   * yields a viewer session. Mutating routes always 403.
   */
  readOnly?: boolean;
  /** Maximum concurrent LLM workflow generations. 0 = unlimited. Default 2. */
  maxConcurrentGenerations?: number;
}

/** What a session (or the no-auth process) is allowed to do. */
export type SessionCapability = "full" | "read";

/** True when the server requires a login session for `/api/*` routes. */
export function webAuthRequired(deps: Pick<WebServerDeps, "authToken" | "readToken">): boolean {
  return Boolean(deps.authToken || deps.readToken);
}

export function isNonLocalHost(host?: string): boolean {
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
  /** Autonomy potential: runs unattended, needs approvals, or needs input. */
  autonomy: WorkflowAutonomy;
  /**
   * Sandbox posture: agent steps per permission profile, plus how many run with
   * no profile at all. Rendered as a badge + a one-line summary on the workflow
   * card so "will this touch my repo?" is answerable before launching.
   */
  permissions: PermissionSummary & { summary?: string };
  /** Non-blocking permission notes (profiles running unenforced / partially). */
  permissionWarnings?: string[];
  /** Dispatch-gate failure reason (absent when runnable or health is still unknown). */
  blocked?: string;
  /** Present when the blocked steps can be re-routed to a ready agent for a run. */
  reroute?: {
    agent: string;
    model: string;
    modelName: string;
    /** How many steps the re-route would retarget. */
    steps: number;
    blockedAgents: string[];
  };
}

function summarizeWorkflow(
  name: string,
  spec: WorkflowSpec,
  source: WorkflowSourceKind | undefined,
  resolve?: (child: string) => WorkflowSpec | undefined,
  config?: SteamtrainConfig,
): WorkflowListItem {
  const kinds: Record<string, number> = {};
  const agents = new Set<string>();
  let stepCount = 0;
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      stepCount += 1;
      const kind = workflowStepKind(step);
      kinds[kind] = (kinds[kind] ?? 0) + 1;
      if (isAgentBackedStep(step) && step.agent) agents.add(step.agent);
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
    autonomy: workflowAutonomy(spec, resolve),
    permissions: (() => {
      const summary = workflowPermissionSummary(spec, config);
      const line = formatPermissionSummary(summary);
      return line ? { ...summary, summary: line } : summary;
    })(),
    permissionWarnings: (() => {
      const warnings = workflowPermissionPreflight(spec, config).warnings;
      return warnings.length > 0 ? warnings : undefined;
    })(),
  };
}

/**
 * Collect the base specs of every sub-workflow a spec invokes, transitively.
 * Cycle-guarded via `seen`; depth-bounded by the same nesting cap the engine
 * enforces. The result keys by workflow name (base catalog specs — the browser
 * layers the call step's own `overrides` client-side, exactly like the engine).
 */
function collectChildWorkflows(
  spec: WorkflowSpec,
  resolve: (name: string) => WorkflowSpec | undefined,
  out: Record<string, WorkflowSpec> = {},
  seen: Set<string> = new Set(),
  depth = 0,
): Record<string, WorkflowSpec> {
  if (depth >= MAX_WORKFLOW_NESTING_DEPTH) return out;
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      if (step.kind !== "workflow" || seen.has(step.workflow)) continue;
      seen.add(step.workflow);
      const child = resolve(step.workflow);
      if (!child) continue;
      out[step.workflow] = child;
      collectChildWorkflows(child, resolve, out, seen, depth + 1);
    }
  }
  return out;
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

/**
 * Validate a full-spec override sent by the web plan editor (an unsaved draft
 * run or planned as-is). The draft must name the workflow it was sent for —
 * otherwise a spec copied from elsewhere would execute under this workflow's
 * name, history, and budget context.
 */
function parseSpecOverride(
  raw: unknown,
  workflowName: string,
): { ok: true; spec: WorkflowSpec } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "'spec' must be a workflow spec object" };
  }
  const check = workflowSpecSchema.safeParse(raw);
  if (!check.success) {
    return {
      ok: false,
      error: `invalid workflow spec: ${check.error.issues[0]?.message ?? "schema error"}`,
    };
  }
  if (check.data.name !== undefined && check.data.name !== workflowName) {
    return { ok: false, error: `'spec' name must match workflow '${workflowName}'` };
  }
  return { ok: true, spec: { ...check.data, name: workflowName } };
}

/** Maximum body size: 1 MiB. Rejects larger payloads with HTTP 413. */
const MAX_BODY_BYTES = 1 * 1024 * 1024;

/**
 * Maximum unified-patch size served per step by the history worktree diff
 * endpoint. Larger patches are truncated (with `patchTruncated: true`) so a
 * huge generated diff cannot stall the UI; the CLI `history show --diff`
 * always has the full text. The slicing itself lives in the shared
 * {@link capPatch}; this is the endpoint's named policy (same default).
 */
export const HISTORY_PATCH_CAP = DEFAULT_PATCH_CAP;

/** Maximum workflow name length. */
const MAX_WORKFLOW_NAME = 128;

/** Maximum run / history id length (URL path params). */
const MAX_RUN_ID_LENGTH = 256;

function isValidWorkflowName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_WORKFLOW_NAME) return false;
  // Reject control characters and null bytes.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control char rejection
  return !/[\x00-\x1f\x7f]/.test(name);
}

function isValidRunId(id: string): boolean {
  return isValidPathId(id, MAX_RUN_ID_LENGTH);
}

class PayloadTooLarge extends Error {
  constructor() {
    super("payload too large");
    this.name = "PayloadTooLarge";
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  // Fast-reject: check the Content-Length header before consuming any bytes.
  // This avoids buffering a multi-MiB body only to throw, and also works
  // around a Bun-specific quirk where throwing mid-stream causes the response
  // status to be lost by the client.
  // Note: non-numeric or missing Content-Length parses as NaN/0, both of which
  // fall through to the streaming guard below — this is intentional.
  const contentLength = Number.parseInt(req.headers["content-length"] ?? "0", 10);
  if (contentLength > MAX_BODY_BYTES) {
    throw new PayloadTooLarge();
  }
  // Defense-in-depth: also guard against chunked transfers or mismatched
  // Content-Length headers by checking cumulative bytes during streaming.
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

/** Discard any unread request bytes so keep-alive sockets can close cleanly. */
function drainRequestBody(req: IncomingMessage): void {
  req.resume();
  req.on("error", () => {});
  req.on("data", () => {});
}

const AUTH_COOKIE = "__steamtrain_auth";

/** How long a login session stays valid. Sessions also die with the process. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Cap on concurrent sessions; the oldest is evicted past this. */
const MAX_SESSIONS = 64;
/** Failed-login budget per client IP inside one window before 429s start. */
const AUTH_MAX_FAILURES = 10;
const AUTH_FAILURE_WINDOW_MS = 60_000;
/** Cap on tracked rate-limit clients (guards the Map against address churn). */
const MAX_TRACKED_CLIENTS = 4096;

interface SessionRecord {
  expiresAt: number;
  capability: SessionCapability;
}

/**
 * Per-server-instance auth state. Sessions are random 256-bit ids handed out
 * by POST /api/auth and stored hashed, so neither the on-wire cookie nor the
 * in-memory table ever contains a reusable long-term credential derived from
 * the auth token (the pre-hardening cookie was the deterministic
 * SHA-256(token) — effectively a second permanent password).
 */
interface AuthState {
  /** SHA-256(sessionId) -> session record. */
  sessions: Map<string, SessionRecord>;
  /** client address -> failed-login window. */
  authFailures: Map<string, { count: number; resetAt: number }>;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Constant-time credential comparison. Hashing both sides first fixes the
 * lengths, so neither content nor length of the expected secret leaks.
 */
function timingSafeCompare(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const pair of header.split(";")) {
    const idx = pair.indexOf("=");
    if (idx < 1) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) cookies[key] = val;
  }
  return cookies;
}

/** Create a session and return its id (the cookie value). */
function createSession(state: AuthState, capability: SessionCapability, now = Date.now()): string {
  for (const [key, session] of state.sessions) {
    if (session.expiresAt <= now) state.sessions.delete(key);
  }
  while (state.sessions.size >= MAX_SESSIONS) {
    const oldest = state.sessions.keys().next().value;
    if (oldest === undefined) break;
    state.sessions.delete(oldest);
  }
  const id = randomBytes(32).toString("hex");
  state.sessions.set(hashToken(id), { expiresAt: now + SESSION_TTL_MS, capability });
  return id;
}

/**
 * Look up the presented session. Returns undefined when auth is required and
 * the cookie is missing/invalid/expired. When auth is not required, returns a
 * synthetic capability (read when {@link WebServerDeps.readOnly}, else full).
 */
function resolveSession(
  req: IncomingMessage,
  deps: WebServerDeps,
  state: AuthState,
): { capability: SessionCapability } | undefined {
  if (!webAuthRequired(deps)) {
    return { capability: deps.readOnly ? "read" : "full" };
  }
  const cookieVal = parseCookies(req.headers.cookie)[AUTH_COOKIE];
  if (!cookieVal) return undefined;
  const key = hashToken(cookieVal);
  const session = state.sessions.get(key);
  if (session === undefined) return undefined;
  if (session.expiresAt <= Date.now()) {
    state.sessions.delete(key);
    return undefined;
  }
  // --read-only on the process wins even if the session was minted as full
  // before the flag was flipped (sessions die with the process anyway).
  const capability: SessionCapability = deps.readOnly ? "read" : session.capability;
  return { capability };
}

/**
 * State-changing routes a read-only session may not call. Logout is allowed
 * so viewers can end their own session; auth is handled before this gate.
 * Plan is blocked too — sharing a run *view* does not include dry-run / spend
 * preview against the live catalog.
 *
 * Also blocks GET /api/config: that payload includes agent `env` / `extraArgs`
 * / binary paths (includeConfig), which is control-plane detail, not a run view.
 */
export function isForbiddenForReadSession(method: string, path: string): boolean {
  if (method === "GET" && path === "/api/config") return true;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  if (method === "POST" && (path === "/api/logout" || path === "/api/auth")) return false;
  // Treat every other write (and exotic methods) as forbidden for viewers.
  return true;
}

/** @deprecated Prefer {@link isForbiddenForReadSession}; kept as a narrow alias. */
export function isMutatingApiRequest(method: string, path: string): boolean {
  return isForbiddenForReadSession(method, path) && !(method === "GET" && path === "/api/config");
}

/** True when this client has burned its failed-login budget for the window. */
function authRateLimited(state: AuthState, client: string, now = Date.now()): boolean {
  const entry = state.authFailures.get(client);
  if (!entry || entry.resetAt <= now) return false;
  return entry.count >= AUTH_MAX_FAILURES;
}

function recordAuthFailure(state: AuthState, client: string, now = Date.now()): void {
  const entry = state.authFailures.get(client);
  if (entry && entry.resetAt > now) {
    entry.count += 1;
    return;
  }
  // Re-inserting moves the key to the end of the Map's iteration order, so the
  // eviction sweep below discards the least-recently-touched clients first.
  state.authFailures.delete(client);
  if (state.authFailures.size >= MAX_TRACKED_CLIENTS) {
    // Sweep expired windows, then, if still at the cap, drop oldest entries.
    // Never wipe wholesale: a full clear would let an attacker who inflates the
    // map (e.g. spoofed X-Forwarded-For behind a trusted proxy) reset every
    // other client's — including their own — failure budget on demand.
    for (const [key, value] of state.authFailures) {
      if (value.resetAt <= now) state.authFailures.delete(key);
    }
    while (state.authFailures.size >= MAX_TRACKED_CLIENTS) {
      const oldest = state.authFailures.keys().next().value;
      if (oldest === undefined) break;
      state.authFailures.delete(oldest);
    }
  }
  state.authFailures.set(client, { count: 1, resetAt: now + AUTH_FAILURE_WINDOW_MS });
}

/**
 * The address the rate limiter and logs attribute a request to. Behind a
 * trusted reverse proxy every connection originates from the proxy, so
 * `req.socket.remoteAddress` would collapse all clients into one shared
 * bucket; there we use the first X-Forwarded-For hop instead. The header is
 * honored ONLY when the operator opted into `--trust-proxy`, since it is
 * otherwise fully client-controlled.
 */
function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = firstForwarded(req.headers["x-forwarded-for"]);
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress ?? "unknown";
}

/**
 * Whether the request reached us over HTTPS. The server itself only speaks
 * plain HTTP, so the only https signal is a TLS-terminating reverse proxy's
 * X-Forwarded-Proto — trusted only under `--trust-proxy`, because a browser
 * can set that header itself. Drives the cookie Secure flag: keying it off the
 * bind host (the pre-hardening behavior) silently broke login on plain-HTTP
 * non-local binds, because browsers drop Secure cookies set over http.
 */
function requestIsHttps(req: IncomingMessage, trustProxy: boolean): boolean {
  if (!trustProxy) return false;
  const proto = req.headers["x-forwarded-proto"];
  const first = (Array.isArray(proto) ? proto[0] : proto)?.split(",")[0]?.trim().toLowerCase();
  return first === "https";
}

/** Build the Set-Cookie header value for a freshly created session. */
function sessionCookie(sessionId: string, secure: boolean): string {
  const parts = [
    `${AUTH_COOKIE}=${sessionId}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** Build the Set-Cookie header value that clears the session cookie. */
function clearedSessionCookie(): string {
  return `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/** Split a `host[:port]` header (incl. `[v6]:port`) into lowercase parts. */
function splitHostPort(header: string): { hostname: string; port: string } | undefined {
  const value = header.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1) return undefined;
    const rest = value.slice(end + 1);
    return { hostname: value.slice(1, end), port: rest.startsWith(":") ? rest.slice(1) : "" };
  }
  const colon = value.indexOf(":");
  if (colon === -1) return { hostname: value, port: "" };
  return { hostname: value.slice(0, colon), port: value.slice(colon + 1) };
}

/** Extract the lowercase hostname from a `host[:port]` header (incl. `[v6]`). */
function hostHeaderName(header: string | undefined): string | undefined {
  return header ? splitHostPort(header)?.hostname : undefined;
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/** First hop of a possibly comma-joined forwarded header. */
function firstForwarded(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(",")[0]?.trim() || undefined;
}

/**
 * DNS-rebinding defense for the locally-bound, auth-optional mode: a malicious
 * site can point its own DNS name at 127.0.0.1 and the victim's browser will
 * happily talk to this server with full same-origin powers — the only tell is
 * the Host header, which still names the attacker's domain. So on local binds,
 * only loopback hostnames (and the bind host itself) are served.
 *
 * A reverse proxy is served under `--trust-proxy`, which lifts the allowlist
 * entirely: the proxy owns hostname validation, and forwarded headers cannot
 * otherwise be believed. Crucially the *presence* of X-Forwarded-Host is NOT a
 * proxy signal — it is not a forbidden header, so page JavaScript can set it on
 * a same-origin rebound fetch to slip past this check. Non-local binds rely on
 * mandatory auth instead, since their legitimate hostnames are unknowable.
 *
 * Returns true if the request may proceed; false means a 403 was sent.
 */
function checkHostHeader(
  req: IncomingMessage,
  res: ServerResponse,
  bindHost: string | undefined,
  trustProxy: boolean,
): boolean {
  if (trustProxy || isNonLocalHost(bindHost)) return true;
  const hostname = hostHeaderName(req.headers.host);
  if (hostname && (LOCAL_HOSTNAMES.has(hostname) || hostname === hostHeaderName(bindHost))) {
    return true;
  }
  sendJson(res, 403, { error: "invalid host header" });
  return false;
}

/**
 * Cross-origin write protection. State-changing requests carrying an
 * Origin/Referer that doesn't match the request host are rejected in every
 * mode — browsers always attach Origin to cross-site fetches (even no-cors
 * ones), so this blocks drive-by CSRF against the no-auth localhost server
 * too, where SameSite cookies offer no protection because there are none.
 * Requests without either header (curl, scripts) are allowed unless auth is
 * enabled, in which case they are rejected: legitimate browser traffic — the
 * only traffic that can carry the session cookie — always includes one.
 *
 * Returns true if the request is safe to proceed, false if it was rejected
 * (response already sent).
 */
function checkCsrf(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  authRequired: boolean,
  trustProxy: boolean,
): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) {
    if (!authRequired) return true;
    sendJson(res, 403, { error: "missing origin header" });
    return false;
  }
  try {
    const originUrl = new URL(origin);
    // A non-web-origin Referer (data:, blob:, file:, …) is a valid URL, so it
    // would otherwise fall through to the host comparison with an empty
    // hostname. Reject it outright: no such context is ever a same-origin peer.
    if (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") {
      sendJson(res, 403, { error: "origin mismatch" });
      return false;
    }
    // Behind a trusted reverse proxy the browser's Origin names the public host
    // while req.headers.host may name the upstream, so prefer X-Forwarded-Host.
    // Untrusted, that header is client-settable and MUST NOT drive the compare —
    // a rebound same-origin fetch could otherwise spoof a matching host.
    const host =
      (trustProxy ? firstForwarded(req.headers["x-forwarded-host"]) : undefined) ??
      req.headers.host;
    if (!host) {
      sendJson(res, 403, { error: "missing host header" });
      return false;
    }
    // Normalize port comparison: the host header may omit default ports
    // (80/443) while originUrl.port is empty for defaults. IPv6 literals are
    // bracketed in URLs ("[::1]") but compared bare.
    const hostSplit = splitHostPort(host);
    if (!hostSplit) {
      sendJson(res, 403, { error: "invalid host header" });
      return false;
    }
    const defaultPort = originUrl.protocol === "https:" ? "443" : "80";
    const hostPort = hostSplit.port || defaultPort;
    const originHostname = originUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const originPort = originUrl.port || defaultPort;
    if (originHostname !== hostSplit.hostname || originPort !== hostPort) {
      sendJson(res, 403, { error: "origin mismatch" });
      return false;
    }
  } catch {
    sendJson(res, 403, { error: "invalid origin" });
    return false;
  }
  return true;
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
 *   POST   /api/workflows/:name/plan  dry-run plan (no agents executed)
 *   POST   /api/workflows/:name/lint  per-step dispatch warnings for a draft spec
 *   GET    /api/meta                agents + apis, models, efforts, health (authoring)
 *   GET    /api/doctor              agent + api health
 *   GET    /api/runner-usage       runs each runner took part in (settings' Runs column)
 *   GET    /api/history             past-run summaries (newest first)
 *   GET    /api/history/:id         one past run's full record
 *   DELETE /api/history             clear all past runs
 *   DELETE /api/history/:id         delete one past run
 *   POST   /api/history/:id/rerun   re-run a past run -> { runId }
 *   POST   /api/history/:id/retry   retry failed steps -> { runId, downgraded? }
 *                                   optional JSON body: { retargetAgent?, retargetModel?, steps? }
 *   POST   /api/history/:id/diagnose  LLM failure postmortem -> { ok, diagnosis?, error? }
 *                                   optional JSON body: { api?, model? }
 *   GET    /api/history/:id/worktrees  a run's retained worktrees + diffstat
 *   POST   /api/history/:id/harvest    merge worktrees (apply/branch/pr) -> { result }
 *   POST   /api/history/:id/prune      discard a run's worktrees -> { pruned, total }
 *   POST   /api/runs                { workflow, input, freshCache?, freshWorktrees?, maxParallel?, overrides? } -> { runId }
 *   GET    /api/runs/:id/stream     SSE of WorkflowEvents + terminal status
 *   POST   /api/runs/:id/cancel     abort a run
 *   POST   /api/runs/:id/pause      stop scheduling new steps (in-flight finish)
 *   POST   /api/runs/:id/resume     continue a paused run
 *   POST   /api/runs/:id/detach     hand a running run off to a background process
 *   POST   /api/runs/:id/edit-step  { stepId, prompt?/cmd?/model?/effort?/permissions? } — edit a pending step while paused
 *   POST   /api/runs/:id/kill-step  { stepId } — fail one running step, run continues
 *   POST   /api/runs/:id/approval   resolve a human-approval checkpoint
 *   POST   /api/runs/:id/input      answer a human-input request (human step / agent question)
 *   POST   /api/overrides/flush     flush staged session overrides -> { saved, skipped, unchanged }
 *   GET    /api/session             current auth/capability (for the SPA chrome)
 *   POST   /api/auth                validate token, create session, set cookie
 *   POST   /api/logout              revoke the presented session, clear cookie
 */
/** API-instance view-model with health folded in from the live api doctor state. */
function apiMetaFromDeps(
  deps: WebServerDeps,
  options: { includeDisabled?: boolean; includeConfig?: boolean } = {},
) {
  return buildApiMeta(
    deps.config,
    (api) => (deps.apiDoctor?.() ?? []).some((d) => d.api === api && d.status === "ok"),
    options,
  );
}

export function createWebServer(deps: WebServerDeps): Server {
  const authState: AuthState = { sessions: new Map(), authFailures: new Map() };
  // Per-server instance so concurrent createWebServer() calls (tests) do not
  // share one generation counter / limit.
  const generations: GenerationGate = {
    active: 0,
    max: deps.maxConcurrentGenerations ?? DEFAULT_MAX_CONCURRENT_GENERATIONS,
  };
  return createServer((req, res) => {
    void handle(req, res, deps, authState, generations).catch((err) => {
      if (!res.headersSent) {
        const status = err instanceof PayloadTooLarge ? 413 : 500;
        const error =
          err instanceof PayloadTooLarge ? "payload too large" : "internal server error";
        // Drain unread body *before* sending the response — Bun requires
        // the request stream to be consumed/discarded for the client-side
        // fetch to receive the correct HTTP status code.
        if (err instanceof PayloadTooLarge) drainRequestBody(req);
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
  authState: AuthState,
  generations: GenerationGate,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  const trustProxy = deps.trustProxy ?? false;

  // DNS-rebinding defense: on local binds, only loopback Host headers are served.
  if (!checkHostHeader(req, res, deps.bindHost, trustProxy)) return;

  // Login endpoint: always accessible (and deliberately ahead of the CSRF
  // gate so non-browser clients without an Origin header can authenticate);
  // failed attempts are rate limited per client, and a cross-site login
  // forgery gains nothing an attacker doesn't already have — it requires the
  // token itself. Either the full auth token or the read token is accepted.
  if (method === "POST" && path === "/api/auth") {
    if (!webAuthRequired(deps)) {
      sendJson(res, 200, {
        ok: true,
        authRequired: false,
        capability: deps.readOnly ? "read" : "full",
        readOnly: Boolean(deps.readOnly),
        sessionTtlMs: SESSION_TTL_MS,
      });
      return;
    }
    const client = clientAddress(req, trustProxy);
    if (authRateLimited(authState, client)) {
      drainRequestBody(req);
      sendJson(res, 429, { error: "too many login attempts; retry later" });
      return;
    }
    let parsed: { token?: unknown };
    try {
      const body = await readBody(req);
      parsed = body ? JSON.parse(body) : {};
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    if (typeof parsed.token !== "string") {
      recordAuthFailure(authState, client);
      sendJson(res, 401, { error: "invalid token" });
      return;
    }
    let capability: SessionCapability | undefined;
    if (deps.authToken && timingSafeCompare(parsed.token, deps.authToken)) {
      capability = deps.readOnly ? "read" : "full";
    } else if (deps.readToken && timingSafeCompare(parsed.token, deps.readToken)) {
      capability = "read";
    }
    if (!capability) {
      recordAuthFailure(authState, client);
      sendJson(res, 401, { error: "invalid token" });
      return;
    }
    const sessionId = createSession(authState, capability);
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "set-cookie": sessionCookie(sessionId, requestIsHttps(req, trustProxy)),
    });
    res.end(
      JSON.stringify({
        ok: true,
        capability,
        readOnly: capability === "read",
        sessionTtlMs: SESSION_TTL_MS,
      }),
    );
    return;
  }

  // Auth check: skip for public routes (index, static assets). Runs before
  // the CSRF gate so an unauthenticated client gets the 401 that routes the
  // web UI to its login form.
  const isPublicRoute =
    path === "/" ||
    path === "/index.html" ||
    path === "/favicon.ico" ||
    path.startsWith("/static/");
  const session = isPublicRoute ? undefined : resolveSession(req, deps, authState);
  if (!isPublicRoute && webAuthRequired(deps) && !session) {
    sendJson(res, 401, { error: "authentication required" });
    return;
  }

  // Cross-origin write protection (all modes), before any state can change.
  if (!checkCsrf(req, res, method, webAuthRequired(deps), trustProxy)) return;

  // Logout: revoke the presented session (if any) and clear the cookie.
  // Allowed for read-only sessions so viewers can end their own session.
  if (method === "POST" && path === "/api/logout") {
    const cookieVal = parseCookies(req.headers.cookie)[AUTH_COOKIE];
    if (cookieVal) authState.sessions.delete(hashToken(cookieVal));
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "set-cookie": clearedSessionCookie(),
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Capability gate: read-only sessions (and --read-only processes) may only
  // read run/workflow views. Applied after logout so ending a session never 403s.
  // GET /api/config is also blocked — it embeds agent env/extraArgs.
  const capability: SessionCapability = session?.capability ?? (deps.readOnly ? "read" : "full");
  if (capability === "read" && isForbiddenForReadSession(method, path)) {
    sendJson(res, 403, {
      error: "read-only session",
      capability: "read",
    });
    return;
  }

  // Session probe for the SPA chrome (badge, hide Run / authoring buttons).
  if (method === "GET" && path === "/api/session") {
    sendJson(res, 200, {
      authRequired: webAuthRequired(deps),
      capability,
      readOnly: capability === "read",
      project: deps.project,
    });
    return;
  }

  if (method === "GET" && (path === "/" || path === "/index.html")) {
    // The page itself is `no-store` so a fresh release swaps in the new
    // cache-busted asset hashes on the next navigation.
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      // Scripts are now external; inline `style="..."` attributes and the
      // generated @font-face block remain, so `style-src 'unsafe-inline'`
      // stays. Every origin is 'self': the fonts are served from /static/
      // rather than a CDN, so the page reaches no third party at all.
      // frame-ancestors 'none' (mirrored by X-Frame-Options for older
      // browsers) blocks clickjacking; base-uri/object-src/form-action close
      // the remaining injection-amplification vectors.
      "content-security-policy":
        "default-src 'self'; script-src 'self'; " +
        "style-src 'self' 'unsafe-inline'; font-src 'self'; " +
        "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; " +
        "base-uri 'none'; form-action 'self'; object-src 'none'",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
    });
    res.end(renderIndex(PUBLIC_REVISIONS));
    return;
  }

  // Clients that ignore the inline <link rel="icon"> still request this path;
  // serve the same SVG instead of 404ing every page load. The content type is
  // deliberately image/svg+xml rather than image/x-icon: every current
  // browser renders SVG favicons, and one asset beats maintaining an ICO.
  if (method === "GET" && path === "/favicon.ico") {
    res.writeHead(200, {
      "content-type": "image/svg+xml",
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
    });
    res.end(FAVICON_SVG);
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
    // Annotate runnability only once agent health is known, so the catalog
    // never flashes "blocked" while the background doctor is still probing.
    const doctorReady = (deps.doctor?.() ?? []).length > 0;
    const items = Object.entries(all)
      .map(([name, spec]) => {
        const item = summarizeWorkflow(
          name,
          spec,
          deps.workflowSource?.(name),
          (child) => all[child],
          deps.config,
        );
        if (doctorReady && item.agents.length > 0) {
          const check = deps.host.canDispatchWorkflowSpec(spec);
          if (!check.ok) {
            item.blocked = check.reason;
            const reroute = deps.host.planWorkflowReroute?.(spec);
            // Only advertise the re-route if it actually makes the workflow
            // dispatchable. A workflow blocked for two reasons (missing agent
            // AND, say, an llm step's missing API key) would otherwise offer a
            // one-click re-route that can only fail at run time.
            if (reroute?.ok) {
              const rerouted = applyWorkflowStepOverrides(spec, reroute.plan.overrides);
              if (deps.host.canDispatchWorkflowSpec(rerouted).ok) {
                item.reroute = {
                  agent: reroute.plan.target,
                  model: reroute.plan.targetModel,
                  modelName: reroute.plan.targetModelName,
                  steps: reroute.plan.stepIds.length,
                  blockedAgents: reroute.plan.blockedAgents,
                };
              }
            }
          }
        }
        return item;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    sendJson(res, 200, {
      workflows: items,
      configLabel: deps.configLabel,
      project: deps.project,
    });
    return;
  }

  if (method === "GET" && path === "/api/meta") {
    if (!deps.author) {
      sendJson(res, 200, { agents: [], apis: [], modelClasses: [], modelFamilies: [] });
      return;
    }
    sendJson(res, 200, {
      agents: deps.author.agentMeta(),
      apis: apiMetaFromDeps(deps),
      modelClasses: listModelClasses(deps.config),
      modelFamilies: listModelFamilyMeta(),
    });
    return;
  }

  // How much each runner is actually used, for the settings table's Runs
  // column. A GET, and a read in every sense: viewers see it too.
  if (method === "GET" && path === "/api/runner-usage") {
    if (!deps.history?.runnerUsage) {
      // No history (or a store that cannot tally) is not zero usage — the
      // column has nothing to say and the client leaves it blank.
      sendJson(res, 200, { runs: 0, counts: {}, available: false });
      return;
    }
    try {
      const usage = await deps.history.runnerUsage();
      sendJson(res, 200, { ...usage, available: true });
    } catch {
      sendJson(res, 200, { runs: 0, counts: {}, available: false });
    }
    return;
  }

  if (method === "GET" && path === "/api/config") {
    const cfg = deps.config;
    if (!cfg) {
      sendJson(res, 404, { error: "config is not available" });
      return;
    }
    const canGlobal = Boolean(deps.userConfigPath);
    const layers = deps.configLayers ?? {};
    const stepTimeoutSec = resolveStepTimeoutSec(undefined, undefined, cfg);
    sendJson(res, 200, {
      stepTimeoutSec,
      workflowTimeoutSec: cfg.workflowTimeoutSec,
      defaultStepTimeoutSec: DEFAULT_STEP_TIMEOUT_SEC,
      // Parallel-step ceiling, plus the bounds the settings slider must respect
      // so the client never offers a value the schema would reject.
      maxConcurrency: cfg.maxConcurrency ?? DEFAULT_CONFIG.maxConcurrency,
      defaultMaxConcurrency: DEFAULT_CONFIG.maxConcurrency,
      maxConcurrencyCeiling: MAX_CONCURRENCY,
      configPath: deps.configPath,
      userConfigPath: deps.userConfigPath,
      version: STEAMTRAIN_VERSION,
      canGlobal,
      // Configured entries only (not unconfigured builtins), tagged with the
      // file they live in. New rows in the editor default to user/global.
      agents: tagAgentsWithScope(layers),
      apis: tagApisWithScope(layers),
      // Full catalogs for health dots / model pickers in the config modal.
      agentCatalog: buildAgentMeta(
        cfg,
        (agent) => (deps.doctor?.() ?? []).some((d) => d.agent === agent && d.status === "ok"),
        { includeDisabled: true, includeConfig: true },
      ),
      apiCatalog: apiMetaFromDeps(deps, { includeDisabled: true, includeConfig: true }),
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
      maxConcurrency?: unknown;
      agents?: unknown;
      apis?: unknown;
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
    const hasApis = parsed.apis !== undefined;
    const hasConcurrency = parsed.maxConcurrency !== undefined;
    if (!hasStep && !hasWf && !clearWf && !hasAgents && !hasApis && !hasConcurrency) {
      sendJson(res, 400, {
        error:
          "body must include stepTimeoutSec, workflowTimeoutSec, clearWorkflowTimeout, maxConcurrency, agents, or apis",
      });
      return;
    }
    // Bounded here as well as in the schema so a bad value is a 400 with a
    // readable reason rather than a generic save failure from deeper down.
    if (
      hasConcurrency &&
      (typeof parsed.maxConcurrency !== "number" ||
        !Number.isInteger(parsed.maxConcurrency) ||
        parsed.maxConcurrency < 1 ||
        parsed.maxConcurrency > MAX_CONCURRENCY)
    ) {
      sendJson(res, 400, {
        error: `maxConcurrency must be an integer between 1 and ${MAX_CONCURRENCY}`,
      });
      return;
    }

    const canGlobal = Boolean(deps.userConfigPath);
    const projectPatch: Parameters<typeof saveProjectConfig>[0] = {};
    if (hasStep) projectPatch.stepTimeoutSec = parsed.stepTimeoutSec as number;
    if (hasConcurrency) projectPatch.maxConcurrency = parsed.maxConcurrency as number;
    if (clearWf) projectPatch.workflowTimeoutSec = undefined;
    else if (hasWf) projectPatch.workflowTimeoutSec = parsed.workflowTimeoutSec as number;

    let userAgents: AgentInstanceConfig[] | undefined;
    let projectAgents: AgentInstanceConfig[] | undefined;
    let userApis: ApiInstanceConfig[] | undefined;
    let projectApis: ApiInstanceConfig[] | undefined;

    if (hasAgents) {
      try {
        const partitioned = parseScopedInstancePayload(
          parsed.agents,
          canGlobal,
          parseAgentsConfig,
          "agents",
        );
        userAgents = partitioned.user;
        projectAgents = partitioned.project;
        projectPatch.agents = projectAgents;
      } catch (err) {
        sendJson(res, 400, {
          error: err instanceof Error ? err.message : "invalid agents",
        });
        return;
      }
    }

    if (hasApis) {
      try {
        const partitioned = parseScopedInstancePayload(
          parsed.apis,
          canGlobal,
          parseApisConfig,
          "apis",
        );
        userApis = partitioned.user;
        projectApis = partitioned.project;
        projectPatch.apis = projectApis;
      } catch (err) {
        sendJson(res, 400, {
          error: err instanceof Error ? err.message : "invalid apis",
        });
        return;
      }
    }

    // Agents/APIs default to the user/global file; timeouts stay project-scoped
    // (matching `/timeout` and team-shared steamtrain.json conventions).
    if (canGlobal && deps.userConfigPath && (userAgents !== undefined || userApis !== undefined)) {
      const userPatch: { agents?: AgentInstanceConfig[]; apis?: ApiInstanceConfig[] } = {};
      if (userAgents !== undefined) userPatch.agents = userAgents;
      if (userApis !== undefined) userPatch.apis = userApis;
      // Skip creating a brand-new user file solely to write empty arrays. Still
      // write empties when the file (or in-memory layers) already had entries so
      // deletes stick.
      const hasUserContent =
        (userAgents?.length ?? 0) > 0 ||
        (userApis?.length ?? 0) > 0 ||
        (deps.configLayers?.userAgents?.length ?? 0) > 0 ||
        (deps.configLayers?.userApis?.length ?? 0) > 0 ||
        userConfigExists(deps.userConfigPath);
      if (hasUserContent) {
        const savedUser = saveUserConfig(userPatch, deps.userConfigPath);
        if (!savedUser.ok) {
          sendJson(res, 400, { error: savedUser.error ?? "failed to save user config" });
          return;
        }
      }
    }

    const needsProjectWrite =
      hasStep ||
      hasWf ||
      clearWf ||
      hasConcurrency ||
      projectAgents !== undefined ||
      projectApis !== undefined;
    if (needsProjectWrite) {
      const saved = saveProjectConfig(projectPatch, deps.configPath);
      if (!saved.ok || !saved.config) {
        sendJson(res, 400, { error: saved.error ?? "save failed" });
        return;
      }
      if (!deps.reloadConfig) Object.assign(deps.config, saved.config);
    }

    if (deps.reloadConfig) {
      deps.reloadConfig();
    } else {
      // Keep layers + merged live config in sync when the caller didn't supply
      // a full reload (unit tests often omit reloadConfig).
      if (!deps.configLayers) {
        deps.configLayers = {
          userAgents: undefined,
          projectAgents: deps.config.agents ? [...deps.config.agents] : undefined,
          userApis: undefined,
          projectApis: deps.config.apis ? [...deps.config.apis] : undefined,
        };
      }
      if (userAgents !== undefined) deps.configLayers.userAgents = userAgents;
      if (projectAgents !== undefined) deps.configLayers.projectAgents = projectAgents;
      if (userApis !== undefined) deps.configLayers.userApis = userApis;
      if (projectApis !== undefined) deps.configLayers.projectApis = projectApis;
      if (hasAgents) {
        deps.config.agents = [
          ...(deps.configLayers.userAgents ?? []),
          ...(deps.configLayers.projectAgents ?? []),
        ];
      }
      if (hasApis) {
        deps.config.apis = [
          ...(deps.configLayers.userApis ?? []),
          ...(deps.configLayers.projectApis ?? []),
        ];
      }
    }

    if (hasAgents) {
      try {
        const results = await runDoctor(deps.config);
        deps.setDoctor?.(results);
        await refreshAgentCatalogCaches(deps.config, results);
      } catch {
        // The regular doctor polling endpoint will report the previous state if refresh fails.
      }
    }
    if (hasApis) {
      try {
        deps.setApiDoctor?.(await runApiDoctor(deps.config));
      } catch {
        // The regular doctor polling endpoint will report the previous state if refresh fails.
      }
    }

    const layers = deps.configLayers ?? {};
    sendJson(res, 200, {
      ok: true,
      stepTimeoutSec: resolveStepTimeoutSec(undefined, undefined, deps.config),
      workflowTimeoutSec: deps.config.workflowTimeoutSec,
      maxConcurrency: deps.config.maxConcurrency ?? DEFAULT_CONFIG.maxConcurrency,
      defaultMaxConcurrency: DEFAULT_CONFIG.maxConcurrency,
      maxConcurrencyCeiling: MAX_CONCURRENCY,
      configPath: deps.configPath,
      userConfigPath: deps.userConfigPath,
      version: STEAMTRAIN_VERSION,
      canGlobal,
      agents: tagAgentsWithScope(layers),
      apis: tagApisWithScope(layers),
      agentCatalog: buildAgentMeta(
        deps.config,
        (agent) => (deps.doctor?.() ?? []).some((d) => d.agent === agent && d.status === "ok"),
        { includeDisabled: true, includeConfig: true },
      ),
      apiCatalog: apiMetaFromDeps(deps, { includeDisabled: true, includeConfig: true }),
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
    await streamGenerate(req, res, deps.author, generations);
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
      const catalog = deps.host.listWorkflows();
      const spec = catalog[name];
      if (!spec) {
        sendJson(res, 404, { error: `unknown workflow '${name}'` });
        return;
      }
      // Ship the base specs of every sub-workflow this one invokes (transitively)
      // so the browser can visualize what's inside each `workflow` step and
      // retarget its steps — the same insight + control the TUI now has.
      const children = collectChildWorkflows(spec, (child) => catalog[child]);
      sendJson(res, 200, {
        name,
        source: deps.workflowSource?.(name) ?? "unknown",
        spec,
        children,
      });
      return;
    }

    if (method === "PUT") {
      if (!deps.author) {
        sendJson(res, 501, { error: "workflow authoring is not enabled" });
        return;
      }
      const body = await readBody(req);
      let parsed: {
        spec?: unknown;
        previousName?: unknown;
        scope?: unknown;
        confirmRisk?: unknown;
      };
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
      // Mirror CLI `workflow import`: command / full-permissions / etc. require
      // an explicit confirmRisk acknowledgement before we persist.
      const toSave = { ...specCheck.data, name };
      const review = reviewShareWorkflow(toSave);
      if (review.requiresConfirmation && parsed.confirmRisk !== true) {
        sendJson(res, 409, {
          ok: false,
          error:
            "workflow has critical/high security findings — re-submit with confirmRisk: true to save",
          requiresConfirmation: true,
          review,
        });
        return;
      }
      const previousName =
        typeof parsed.previousName === "string" ? parsed.previousName : undefined;
      const scope = parsed.scope === "project" ? "project" : "user";
      const result = await deps.author.save(name, toSave, previousName, scope);
      sendJson(res, result.ok ? 200 : 400, result.ok ? { ...result, review } : result);
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

  // Lint endpoint: POST /api/workflows/:name/lint
  //
  // The source editor's warning gutter. Deliberately not the plan endpoint:
  // this runs on a debounce while someone types, so it may not touch history,
  // the cache, or the planner — only the readiness the launch sheet would
  // report, from the same authority (stepDispatchIssues), so the two surfaces
  // can never disagree about which steps would be skipped.
  const lintMatch = path.match(/^\/api\/workflows\/([^/]+)\/lint$/);
  if (method === "POST" && lintMatch) {
    const name = decodeURIComponent(lintMatch[1]!);
    if (!isValidWorkflowName(name)) {
      sendJson(res, 400, { error: "invalid workflow name" });
      return;
    }
    const spec = deps.host.listWorkflows()[name];
    if (!spec) {
      sendJson(res, 404, { error: `unknown workflow '${name}'` });
      return;
    }
    const body = await readBody(req);
    let parsed: { spec?: unknown };
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    let effectiveSpec = spec;
    if (parsed.spec !== undefined) {
      const override = parseSpecOverride(parsed.spec, name);
      if (!override.ok) {
        sendJson(res, 400, { error: override.error });
        return;
      }
      effectiveSpec = override.spec;
    }
    // Unknown health is not a prediction: with no doctor results the honest
    // answer is "no warnings", not "every runner is broken".
    const doctor = deps.doctor?.() ?? [];
    sendJson(res, 200, {
      issues: doctor.length > 0 ? (deps.host.stepDispatchIssues?.(effectiveSpec) ?? []) : [],
    });
    return;
  }

  // Plan (dry-run) endpoint: POST /api/workflows/:name/plan
  const planMatch = path.match(/^\/api\/workflows\/([^/]+)\/plan$/);
  if (method === "POST" && planMatch) {
    const name = decodeURIComponent(planMatch[1]!);
    if (!isValidWorkflowName(name)) {
      sendJson(res, 400, { error: "invalid workflow name" });
      return;
    }
    const spec = deps.host.listWorkflows()[name];
    if (!spec) {
      sendJson(res, 404, { error: `unknown workflow '${name}'` });
      return;
    }
    const body = await readBody(req);
    let parsed: { input?: unknown; params?: unknown; overrides?: unknown; spec?: unknown };
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    if (typeof parsed.input !== "string" || !parsed.input.trim()) {
      sendJson(res, 400, { error: "body must include non-empty string 'input'" });
      return;
    }
    let effectiveSpec = spec;
    // Full-spec override: the web plan editor's unsaved draft, planned as-is.
    // Validated by the same schema the save route uses; the draft must still
    // claim the workflow it plans for so a pasted foreign spec can't run
    // under this workflow's name and history.
    if (parsed.spec !== undefined) {
      const override = parseSpecOverride(parsed.spec, name);
      if (!override.ok) {
        sendJson(res, 400, { error: override.error });
        return;
      }
      effectiveSpec = override.spec;
    }
    if (
      parsed.overrides &&
      typeof parsed.overrides === "object" &&
      !Array.isArray(parsed.overrides)
    ) {
      const parsedOverrides = parseSessionOverrides(parsed.overrides);
      if (!parsedOverrides.ok) {
        sendJson(res, 400, { error: parsedOverrides.error });
        return;
      }
      effectiveSpec = applyWorkflowSessionOverrides(effectiveSpec, parsedOverrides.overrides);
    }
    let params: Record<string, string | number | boolean> | undefined;
    if (parsed.params && typeof parsed.params === "object" && !Array.isArray(parsed.params)) {
      const resolved = resolveInputs(effectiveSpec, parsed.params as Record<string, string>);
      if (resolved.errors.length > 0) {
        sendJson(res, 400, { error: resolved.errors.join("; ") });
        return;
      }
      params = Object.keys(resolved.values).length > 0 ? resolved.values : undefined;
    }
    const plan = planWorkflow(effectiveSpec, parsed.input.trim(), params, deps.config);
    // The static topology explains what will execute; completed local runs add
    // observed cost and duration so the launch decision is grounded in evidence,
    // not an invented estimate. Missing or unreadable history intentionally
    // leaves the plan unchanged.
    const history = await deps.history
      ?.list()
      .then((summaries) => planHistoryContext(summaries, name))
      .catch(() => null);
    // Launch predictions (02.2): what the sheet can know BEFORE Start — which
    // steps would replay from cache, which would block dispatch (runner needs
    // auth / missing API key), what "Fresh worktrees" would discard, and how
    // many runners are ready vs the configured parallelism cap. Step issues
    // only once the doctor has run, same readiness gate as the workflow list.
    let launch: {
      cachedSteps: string[];
      stepIssues: Array<{ stepId: string; issue: string }>;
      worktrees: { runId: string; count: number } | null;
      runners: { ready: number; limit: number };
    } | null = null;
    if (plan.ok) {
      const doctor = deps.doctor?.() ?? [];
      const [cachedSteps, worktrees] = await Promise.all([
        deps.runs
          .cachedStepIds(name, parsed.input.trim(), effectiveSpec, params)
          .catch(() => [] as string[]),
        deps.runs.lastKeptWorktrees(name).catch(() => null),
      ]);
      launch = {
        cachedSteps,
        stepIssues: doctor.length > 0 ? (deps.host.stepDispatchIssues?.(effectiveSpec) ?? []) : [],
        worktrees,
        runners: {
          ready: doctor.filter((d) => d.status === "ok").length,
          // The CONFIGURED cap: the sheet prefills its dropdown with it before
          // the user picks. A per-run choice arrives later on POST /api/runs
          // as maxParallel, so this is never the final word for a given run.
          limit: deps.config?.maxConcurrency ?? DEFAULT_CONFIG.maxConcurrency!,
        },
      };
    }
    sendJson(res, plan.ok ? 200 : 422, {
      ...plan,
      ...(history ? { history } : {}),
      ...(launch ? { launch } : {}),
    });
    return;
  }

  if (method === "GET" && path === "/api/doctor") {
    const doctorError = deps.doctorError?.();
    sendJson(res, 200, {
      doctor: deps.doctor?.() ?? [],
      apis: deps.apiDoctor?.() ?? [],
      // Computed per request rather than snapshotted: PATH is read live by
      // every `resolveBinary` call, so a stale copy could disagree with the
      // results it is meant to explain.
      path: describeEffectivePath(),
      ...(doctorError ? { doctorError } : {}),
    });
    return;
  }

  // POST re-runs the probes (the setup panel's Recheck): resolve every agent
  // binary and re-probe every API afresh, so a just-installed CLI or a new
  // login is reflected without restarting the server — matching the TUI's `r`.
  // (GET only reads the last snapshot, which is fixed at startup + config save.)
  if (method === "POST" && path === "/api/doctor") {
    let results: DoctorResult[];
    let apis: ApiDoctorResult[];
    try {
      if (deps.reprobeDoctor) {
        results = await deps.reprobeDoctor();
      } else if (deps.config) {
        results = await runDoctor(deps.config);
        deps.setDoctor?.(results);
      } else {
        results = deps.doctor?.() ?? [];
      }
    } catch (e) {
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      return;
    }
    try {
      if (deps.reprobeApiDoctor) {
        apis = await deps.reprobeApiDoctor();
      } else if (deps.config) {
        apis = await runApiDoctor(deps.config);
        deps.setApiDoctor?.(apis);
      } else {
        apis = deps.apiDoctor?.() ?? [];
      }
    } catch {
      // API probes are independent — keep the fresh agent results even if the
      // network probe fails; fall back to the last known API snapshot.
      apis = deps.apiDoctor?.() ?? [];
    }
    sendJson(res, 200, { doctor: results, apis, path: describeEffectivePath() });
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
    if (!isValidRunId(id)) {
      sendJson(res, 400, { error: "invalid run id" });
      return;
    }
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
    if (!isValidRunId(id)) {
      sendJson(res, 400, { error: "invalid run id" });
      return;
    }
    const mode = rerunMatch[2] === "retry" ? "retry-failed" : "rerun";
    const record = await deps.history?.get(id);
    if (!record) {
      sendJson(res, 404, { error: `unknown run '${id}'` });
      return;
    }
    // Retarget is only valid for retry-failed; keep /rerun body-less.
    let retarget: { retargetAgent?: string; retargetModel?: string; steps?: string[] } | undefined;
    if (mode === "retry-failed") {
      try {
        const raw = await readBody(req);
        if (raw.trim()) {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            sendJson(res, 400, { error: "body must be a JSON object" });
            return;
          }
          const agent = parsed.retargetAgent;
          const model = parsed.retargetModel;
          const steps = parsed.steps;
          if (agent !== undefined && typeof agent !== "string") {
            sendJson(res, 400, { error: "retargetAgent must be a string" });
            return;
          }
          if (model !== undefined && typeof model !== "string") {
            sendJson(res, 400, { error: "retargetModel must be a string" });
            return;
          }
          if (steps !== undefined) {
            if (!Array.isArray(steps) || steps.some((s) => typeof s !== "string")) {
              sendJson(res, 400, { error: "steps must be an array of strings" });
              return;
            }
          }
          retarget = {
            retargetAgent: agent,
            retargetModel: model,
            steps: steps as string[] | undefined,
          };
        }
      } catch (e) {
        sendJson(res, 400, { error: e instanceof Error ? e.message : "invalid JSON body" });
        return;
      }
    }
    try {
      const result = deps.runs.rerunFromRecord(record, mode, retarget);
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

  // Failure postmortem: one direct-API LLM call over the recorded run → root
  // cause, category, and a validated proposed spec edit. The body's `ok` flag
  // carries success/failure (the HTTP status stays 200 either way, matching the
  // CLI `history why --json` contract); viewer sessions are already blocked by
  // the read-only gate above.
  const diagnoseMatch = path.match(/^\/api\/history\/([^/]+)\/diagnose$/);
  if (method === "POST" && diagnoseMatch) {
    if (!deps.history) {
      sendJson(res, 404, { error: "run history is not available on this server" });
      return;
    }
    const id = decodeURIComponent(diagnoseMatch[1]!);
    if (!isValidRunId(id)) {
      sendJson(res, 400, { error: "invalid run id" });
      return;
    }
    const record = await deps.history.get(id);
    if (!record) {
      sendJson(res, 404, { error: `unknown run '${id}'` });
      return;
    }
    let api: string | undefined;
    let model: string | undefined;
    try {
      const raw = await readBody(req);
      if (raw.trim()) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          sendJson(res, 400, { error: "body must be a JSON object" });
          return;
        }
        if (parsed.api !== undefined && typeof parsed.api !== "string") {
          sendJson(res, 400, { error: "api must be a string" });
          return;
        }
        if (parsed.model !== undefined && typeof parsed.model !== "string") {
          sendJson(res, 400, { error: "model must be a string" });
          return;
        }
        api = parsed.api;
        model = parsed.model;
      }
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : "invalid JSON body" });
      return;
    }
    const spec = deps.host.listWorkflows()[record.workflow];
    const abort = new AbortController();
    req.on("close", () => abort.abort());
    const result = await diagnoseRun({
      record,
      spec,
      config: deps.config,
      api,
      model,
      signal: abort.signal,
    });
    sendJson(res, 200, result);
    return;
  }

  // Post-run worktree lifecycle: inspect what a recorded run's step worktrees
  // changed, harvest them (apply/branch/pr), or discard them — the same shared
  // machinery the CLI's `workflow history apply/prune` uses.
  const worktreesMatch = path.match(/^\/api\/history\/([^/]+)\/(worktrees|harvest|prune)$/);
  if (worktreesMatch) {
    if (!deps.history) {
      sendJson(res, 404, { error: "run history is not available on this server" });
      return;
    }
    const history = deps.history;
    const id = decodeURIComponent(worktreesMatch[1]!);
    if (!isValidRunId(id)) {
      sendJson(res, 400, { error: "invalid run id" });
      return;
    }
    const action = worktreesMatch[2]!;
    const record = await history.get(id);
    if (!record) {
      sendJson(res, 404, { error: `unknown run '${id}'` });
      return;
    }

    if (action === "worktrees" && method === "GET") {
      const sources = finalRunWorktrees(record);
      // `?step=<stepId>` drills into one step: the full unified patch (capped)
      // for the graphical diff panel, fetched lazily as the user expands rows.
      const stepFilter = url.searchParams.get("step");
      if (stepFilter !== null) {
        const source = sources.find((s) => s.stepId === stepFilter);
        if (!source) {
          sendJson(res, 404, { error: `unknown step '${stepFilter}' for run '${id}'` });
          return;
        }
        try {
          const diff = await worktreeDiff(source, { patch: true });
          const capped = capPatch(diff.patch ?? "", HISTORY_PATCH_CAP);
          sendJson(res, 200, {
            stepId: source.stepId,
            branch: source.branch,
            root: source.root,
            exists: true,
            base: diff.base,
            files: diff.files,
            additions: diff.additions,
            deletions: diff.deletions,
            patch: capped.patch,
            patchTruncated: capped.truncated,
          });
        } catch {
          sendJson(res, 200, {
            stepId: source.stepId,
            branch: source.branch,
            root: source.root,
            exists: false,
            files: [],
            additions: 0,
            deletions: 0,
          });
        }
        return;
      }
      const items = [];
      for (const source of sources) {
        try {
          const diff = await worktreeDiff(source);
          items.push({
            stepId: source.stepId,
            branch: source.branch,
            root: source.root,
            exists: true,
            files: diff.files,
            additions: diff.additions,
            deletions: diff.deletions,
          });
        } catch {
          items.push({
            stepId: source.stepId,
            branch: source.branch,
            root: source.root,
            exists: false,
            files: [],
            additions: 0,
            deletions: 0,
          });
        }
      }
      sendJson(res, 200, { harvest: record.harvest ?? null, sources: items });
      return;
    }

    if (action === "harvest" && method === "POST") {
      let body: {
        step?: string;
        mode?: "apply" | "branch" | "pr";
        branch?: string;
        onConflict?: "ours" | "theirs";
      };
      try {
        const raw = await readBody(req);
        body = raw ? JSON.parse(raw) : {};
      } catch {
        sendJson(res, 400, { error: "invalid JSON body" });
        return;
      }
      if (body.mode !== undefined && !["apply", "branch", "pr"].includes(body.mode)) {
        sendJson(res, 400, { error: "mode must be apply, branch, or pr" });
        return;
      }
      if (body.onConflict !== undefined && !["ours", "theirs"].includes(body.onConflict)) {
        sendJson(res, 400, { error: "onConflict must be ours or theirs" });
        return;
      }
      if (body.step !== undefined && (typeof body.step !== "string" || !body.step.trim())) {
        sendJson(res, 400, { error: "step must be a non-empty step id" });
        return;
      }
      try {
        const { result, recordWarning } = await harvestRunWorktrees(history, record, {
          step: body.step,
          mode: body.mode,
          branchName: body.branch,
          onConflict: body.onConflict,
        });
        sendJson(res, 200, { result, warning: recordWarning });
      } catch (err) {
        const messageText = err instanceof Error ? err.message : String(err);
        if (err instanceof MergeConflictError) {
          sendJson(res, 409, { error: messageText, hint: mergeConflictGuidance("history") });
        } else {
          sendJson(res, 400, { error: messageText });
        }
      }
      return;
    }

    if (action === "prune" && method === "POST") {
      try {
        const { pruned, total, recordWarning } = await pruneRunWorktrees(history, record);
        sendJson(res, 200, { pruned, total, warning: recordWarning });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
  }

  // The in-flight run registry: the manager's own runs merged with runs owned
  // by other processes (CLI --detach, TUI) from the shared live-run store.
  if (method === "GET" && path === "/api/runs") {
    const local = deps.runs.list();
    const localIds = new Set(local.map((r) => r.id));
    const external = deps.liveRuns
      ? (await deps.liveRuns.list()).filter((r) => !localIds.has(r.id))
      : [];
    const runs = [
      ...local.map((r) => ({
        id: r.id,
        workflow: r.workflow,
        input: r.input,
        status: r.queued ? "queued" : r.status,
        paused: r.paused,
        ok: r.ok,
        error: r.error,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        source: "web",
        detached: false,
        external: false,
        pendingApprovals: r.pendingApprovals,
        pendingInputs: r.pendingInputs,
      })),
      ...external.map((m) => ({
        id: m.id,
        workflow: m.workflow,
        input: m.input,
        status: m.status,
        paused: m.paused || undefined,
        ok: m.ok,
        error: m.error,
        startedAt: m.startedAt ?? m.createdAt,
        endedAt: m.endedAt,
        source: m.source,
        detached: m.detached,
        external: true,
        pendingApprovals: m.pendingApprovals,
        pendingInputs: m.pendingInputs,
      })),
    ].sort((a, b) => b.startedAt - a.startedAt);
    sendJson(res, 200, { runs });
    return;
  }

  if (method === "POST" && path === "/api/runs") {
    const body = await readBody(req);
    let parsed: {
      workflow?: unknown;
      input?: unknown;
      freshCache?: unknown;
      freshWorktrees?: unknown;
      maxParallel?: unknown;
      overrides?: unknown;
      params?: unknown;
      reroute?: unknown;
      spec?: unknown;
    };
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
    // Per-run parallelism cap (the launch sheet's "Max parallel runners"):
    // validated here, clamped again by the engine — an out-of-range value is
    // a client bug, so refuse rather than silently correct.
    let maxParallel: number | undefined;
    if (parsed.maxParallel !== undefined) {
      if (
        typeof parsed.maxParallel !== "number" ||
        !Number.isInteger(parsed.maxParallel) ||
        parsed.maxParallel < 1 ||
        parsed.maxParallel > MAX_CONCURRENCY
      ) {
        sendJson(res, 400, {
          error: `maxParallel must be an integer between 1 and ${MAX_CONCURRENCY}`,
        });
        return;
      }
      maxParallel = parsed.maxParallel;
    }
    let specOverride: WorkflowSpec | undefined;
    // Full-spec override: the web plan editor's unsaved draft, run as-is (the
    // launch sheet warns this is happening). Session `overrides` below then
    // layer on top of it, exactly as they layer on the catalog spec today.
    if (parsed.spec !== undefined) {
      const override = parseSpecOverride(parsed.spec, parsed.workflow);
      if (!override.ok) {
        sendJson(res, 400, { error: override.error });
        return;
      }
      specOverride = override.spec;
    }
    if (
      parsed.overrides &&
      typeof parsed.overrides === "object" &&
      !Array.isArray(parsed.overrides)
    ) {
      const parsedOverrides = parseSessionOverrides(parsed.overrides);
      if (!parsedOverrides.ok) {
        sendJson(res, 400, { error: parsedOverrides.error });
        return;
      }
      const base = specOverride ?? deps.host.listWorkflows()[parsed.workflow];
      if (base) {
        specOverride = applyWorkflowSessionOverrides(base, parsedOverrides.overrides);
      }
    }
    // reroute: true — retarget steps whose pinned agent is not ready onto a
    // ready agent, for this run only (the stored workflow is untouched). When
    // both `overrides` and `reroute` are sent, the re-route is planned on top
    // of the already-applied session overrides (above), so it respects prior
    // per-step edits rather than reverting them. The applied plan (if any) is
    // echoed in the 201 so the client only announces a re-route that actually
    // happened — the catalog annotation the client acts on can be stale
    // relative to staged overrides.
    let appliedReroute: {
      agent: string;
      model: string;
      modelName: string;
      steps: number;
      blockedAgents: string[];
    } | null = null;
    if (parsed.reroute === true && deps.host.planWorkflowReroute) {
      const base = specOverride ?? deps.host.listWorkflows()[parsed.workflow];
      if (base) {
        const reroute = deps.host.planWorkflowReroute(base);
        if (!reroute.ok && reroute.error) {
          sendJson(res, 400, { error: reroute.error });
          return;
        }
        if (reroute.ok) {
          specOverride = applyWorkflowStepOverrides(base, reroute.plan.overrides);
          appliedReroute = {
            agent: reroute.plan.target,
            model: reroute.plan.targetModel,
            modelName: reroute.plan.targetModelName,
            steps: reroute.plan.stepIds.length,
            blockedAgents: reroute.plan.blockedAgents,
          };
        }
      }
    }
    let params: Record<string, string | number | boolean> | undefined;
    if (parsed.params && typeof parsed.params === "object" && !Array.isArray(parsed.params)) {
      const spec = specOverride ?? deps.host.listWorkflows()[parsed.workflow];
      if (spec) {
        const resolved = resolveInputs(spec, parsed.params as Record<string, string>);
        if (resolved.errors.length > 0) {
          sendJson(res, 400, { error: resolved.errors.join("; ") });
          return;
        }
        params = Object.keys(resolved.values).length > 0 ? resolved.values : undefined;
      }
    }
    try {
      const result = deps.runs.start(parsed.workflow, parsed.input, {
        // Two unrelated "fresh" switches ride in the same body, so the wire
        // names them apart: freshCache ignores the step cache, freshWorktrees
        // discards the previous run's retained trees.
        freshCache: parsed.freshCache === true,
        freshWorktrees: parsed.freshWorktrees === true,
        maxParallel,
        specOverride,
        params,
      });
      if (!result.ok) {
        sendJson(res, 400, { error: result.error });
        return;
      }
      sendJson(res, 201, { runId: result.runId, reroute: appliedReroute ?? undefined });
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
    const runId = decodeURIComponent(streamMatch[1]!);
    if (!isValidRunId(runId)) {
      sendJson(res, 400, { error: "invalid run id" });
      return;
    }
    // Manager-owned runs stream from memory; runs owned by another process
    // (CLI --detach, TUI) are tailed from the shared live-run store.
    if (!deps.runs.get(runId) && deps.liveRuns && (await deps.liveRuns.get(runId))) {
      streamExternalRun(runId, deps.liveRuns, res);
      return;
    }
    streamRun(runId, deps.runs, res);
    return;
  }

  const cancelMatch = path.match(/^\/api\/runs\/([^/]+)\/cancel$/);
  if (method === "POST" && cancelMatch) {
    const runId = decodeURIComponent(cancelMatch[1]!);
    if (!isValidRunId(runId)) {
      sendJson(res, 400, { error: "invalid run id" });
      return;
    }
    let ok = deps.runs.cancel(runId);
    if (!ok && deps.liveRuns) {
      // Externally-owned run: drop the cancel marker; its owner polls it.
      ok = await deps.liveRuns.requestCancel(runId);
    }
    sendJson(res, ok ? 200 : 404, { canceled: ok });
    return;
  }

  // Mid-run steering: pause stops scheduling new steps (in-flight ones
  // finish), resume continues. Works for manager-owned runs and — via the
  // shared live-run store's control files — runs owned by other processes.
  const pauseMatch = path.match(/^\/api\/runs\/([^/]+)\/(pause|resume)$/);
  if (method === "POST" && pauseMatch) {
    const runId = decodeURIComponent(pauseMatch[1]!);
    if (!isValidRunId(runId)) {
      sendJson(res, 400, { error: "invalid run id" });
      return;
    }
    const paused = pauseMatch[2] === "pause";
    let ok = await deps.runs.setRunPaused(runId, paused, "human:web");
    if (!ok && deps.liveRuns) {
      // Externally-owned run: write the desired state; its owner polls it.
      ok = await deps.liveRuns.writePauseState(runId, { paused, by: "human:web" });
    }
    sendJson(res, ok ? 200 : 404, { requested: ok, paused });
    return;
  }

  // Mid-run detach: hand a manager-owned run off to a background process under
  // the same id, so the browser (or the server) can close without stopping it.
  const detachMatch = path.match(/^\/api\/runs\/([^/]+)\/detach$/);
  if (method === "POST" && detachMatch) {
    const runId = decodeURIComponent(detachMatch[1]!);
    if (!isValidRunId(runId)) {
      sendJson(res, 400, { error: "invalid run id" });
      return;
    }
    const result = deps.runs.detach(runId);
    // 202: the handoff is under way; the run's SSE stream reports a `detached`
    // frame once local work stops and the background child is spawned.
    sendJson(res, result.ok ? 202 : 404, result.ok ? { detaching: true } : { error: result.error });
    return;
  }

  // Mid-run steering: edit a not-yet-started step of a paused run.
  const editStepMatch = path.match(/^\/api\/runs\/([^/]+)\/edit-step$/);
  if (method === "POST" && editStepMatch) {
    const body = await readBody(req);
    let parsed: {
      stepId?: unknown;
      prompt?: unknown;
      cmd?: unknown;
      model?: unknown;
      effort?: unknown;
      permissions?: unknown;
    };
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    if (typeof parsed.stepId !== "string" || !parsed.stepId) {
      sendJson(res, 400, { error: "body must include a string 'stepId'" });
      return;
    }
    const patch: import("../workflow").StepEditPatch = {};
    if (typeof parsed.prompt === "string") patch.prompt = parsed.prompt;
    if (typeof parsed.cmd === "string") patch.cmd = parsed.cmd;
    if (typeof parsed.model === "string") patch.model = parsed.model;
    if (typeof parsed.effort === "string") patch.effort = parsed.effort;
    if (typeof parsed.permissions === "string") patch.permissions = parsed.permissions;
    if (Object.keys(patch).length === 0) {
      sendJson(res, 400, {
        error:
          "body must include at least one of 'prompt', 'cmd', 'model', 'effort', 'permissions'",
      });
      return;
    }
    const runId = decodeURIComponent(editStepMatch[1]!);
    if (!isValidRunId(runId)) {
      sendJson(res, 400, { error: "invalid run id" });
      return;
    }
    // Manager-owned run: the engine validates synchronously via the control.
    const local = deps.runs.editRunStep(runId, parsed.stepId, patch, "human:web");
    if (local) {
      if (local.ok) sendJson(res, 200, { applied: true });
      else sendJson(res, 400, { error: local.error });
      return;
    }
    // Externally-owned run: drop the request file, then poll briefly for the
    // owner's accept/reject outcome so the UI can report it inline.
    if (deps.liveRuns) {
      const meta = await deps.liveRuns.get(runId);
      if (meta && !isTerminalLiveRunStatus(meta.status)) {
        const editId = await deps.liveRuns.requestStepEdit(runId, {
          stepId: parsed.stepId,
          patch,
          by: "human:web",
        });
        if (editId) {
          const deadline = Date.now() + EXTERNAL_EDIT_RESULT_WAIT_MS;
          while (Date.now() < deadline) {
            const outcome = await deps.liveRuns.readStepEditResult(runId, editId);
            if (outcome) {
              if (outcome.ok) sendJson(res, 200, { applied: true });
              else sendJson(res, 400, { error: outcome.error });
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, EXTERNAL_EDIT_RESULT_POLL_MS));
          }
          sendJson(res, 202, { pending: true });
          return;
        }
      }
    }
    sendJson(res, 404, { error: `unknown run '${runId}'` });
    return;
  }

  // Kill one running step; the run carries on. Manager-owned runs only: a
  // detached run's steps belong to the process that owns them, and there is no
  // cross-process kill request (unlike edits) for this endpoint to drop.
  const killStepMatch = path.match(/^\/api\/runs\/([^/]+)\/kill-step$/);
  if (method === "POST" && killStepMatch) {
    const body = await readBody(req);
    let parsed: { stepId?: unknown };
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    if (typeof parsed.stepId !== "string" || !parsed.stepId) {
      sendJson(res, 400, { error: "body must include a string 'stepId'" });
      return;
    }
    const runId = decodeURIComponent(killStepMatch[1]!);
    if (!isValidRunId(runId)) {
      sendJson(res, 400, { error: "invalid run id" });
      return;
    }
    const killed = deps.runs.killRunStep(runId, parsed.stepId, "human:web");
    if (killed) {
      if (killed.ok) sendJson(res, 200, { killed: true });
      else sendJson(res, 400, { error: killed.error });
      return;
    }
    if (deps.liveRuns) {
      const meta = await deps.liveRuns.get(runId);
      if (meta && !isTerminalLiveRunStatus(meta.status)) {
        sendJson(res, 409, {
          error: "this run is owned by another process — kill its step from there",
        });
        return;
      }
    }
    sendJson(res, 404, { error: `unknown run '${runId}'` });
    return;
  }

  const approvalMatch = path.match(/^\/api\/runs\/([^/]+)\/approval$/);
  if (method === "POST" && approvalMatch) {
    const body = await readBody(req);
    let parsed: {
      stepId?: unknown;
      iteration?: unknown;
      approved?: unknown;
      note?: unknown;
      rejectDisposition?: unknown;
    };
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    if (typeof parsed.stepId !== "string" || !parsed.stepId) {
      sendJson(res, 400, { error: "body must include a string 'stepId'" });
      return;
    }
    if (typeof parsed.approved !== "boolean") {
      sendJson(res, 400, { error: "body must include a boolean 'approved'" });
      return;
    }
    const iteration = typeof parsed.iteration === "number" ? parsed.iteration : undefined;
    const rejectDisposition =
      parsed.rejectDisposition === "fail" || parsed.rejectDisposition === "stop"
        ? parsed.rejectDisposition
        : undefined;
    const runId = decodeURIComponent(approvalMatch[1]!);
    if (!isValidRunId(runId)) {
      sendJson(res, 400, { error: "invalid run id" });
      return;
    }
    const decision: import("../workflow").ApprovalDecision = {
      approved: parsed.approved,
      by: "human:web",
      note: typeof parsed.note === "string" ? parsed.note : undefined,
      rejectDisposition: parsed.approved ? undefined : rejectDisposition,
    };
    let ok = deps.runs.resolveApproval(runId, parsed.stepId, decision, iteration);
    if (!ok && deps.liveRuns) {
      // Externally-owned run: write the decision file; the owner's approval
      // provider polls it (this is how a detached run's checkpoint resolves).
      const meta = await deps.liveRuns.get(runId);
      if (meta && !isTerminalLiveRunStatus(meta.status)) {
        const target = matchPendingApproval(meta.pendingApprovals ?? [], parsed.stepId, iteration);
        if (target) {
          await deps.liveRuns.writeApprovalDecision(
            runId,
            target.stepId,
            target.iteration,
            decision,
          );
          ok = true;
        }
      }
    }
    sendJson(res, ok ? 200 : 404, { resolved: ok });
    return;
  }

  const inputMatch = path.match(/^\/api\/runs\/([^/]+)\/input$/);
  if (method === "POST" && inputMatch) {
    const body = await readBody(req);
    let parsed: { stepId?: unknown; iteration?: unknown; value?: unknown };
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    if (typeof parsed.stepId !== "string" || !parsed.stepId) {
      sendJson(res, 400, { error: "body must include a string 'stepId'" });
      return;
    }
    if (typeof parsed.value !== "string" || !parsed.value.trim()) {
      sendJson(res, 400, { error: "body must include a non-empty string 'value'" });
      return;
    }
    const iteration = typeof parsed.iteration === "number" ? parsed.iteration : undefined;
    const runId = decodeURIComponent(inputMatch[1]!);
    if (!isValidRunId(runId)) {
      sendJson(res, 400, { error: "invalid run id" });
      return;
    }
    const response = { value: parsed.value, by: "human:web" };
    let ok = deps.runs.resolveHumanInput(runId, parsed.stepId, response, iteration);
    if (!ok && deps.liveRuns) {
      // Externally-owned run: write the answer file; the owner's human-input
      // provider polls it (this is how a detached run's question gets answered).
      const meta = await deps.liveRuns.get(runId);
      if (meta && !isTerminalLiveRunStatus(meta.status)) {
        const target = matchPendingInput(meta.pendingInputs ?? [], parsed.stepId, iteration);
        if (target) {
          await deps.liveRuns.writeHumanInputResponse(
            runId,
            target.stepId,
            target.iteration,
            target.attempt,
            response,
          );
          ok = true;
        }
      }
    }
    sendJson(res, ok ? 200 : 404, { resolved: ok });
    return;
  }

  if (method === "POST" && path === "/api/overrides/flush") {
    if (!deps.author) {
      sendJson(res, 501, { error: "workflow authoring is not enabled" });
      return;
    }
    const body = await readBody(req);
    let parsed: { overrides?: unknown };
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    if (
      !parsed.overrides ||
      typeof parsed.overrides !== "object" ||
      Array.isArray(parsed.overrides)
    ) {
      sendJson(res, 400, { error: "body must include 'overrides' object" });
      return;
    }
    const overrides = parsed.overrides as Record<string, unknown>;
    const sessionOverrides: Record<string, WorkflowSessionOverrides> = {};
    for (const [workflowName, rawWorkflowOverrides] of Object.entries(overrides)) {
      const parsedWorkflowOverrides = parseSessionOverrides(rawWorkflowOverrides);
      if (!parsedWorkflowOverrides.ok) {
        sendJson(res, 400, {
          error: `overrides.${workflowName}: ${parsedWorkflowOverrides.error}`,
        });
        return;
      }
      sessionOverrides[workflowName] = parsedWorkflowOverrides.overrides;
    }
    try {
      const result = await deps.author.flushSessionOverrides(sessionOverrides);
      sendJson(res, 200, {
        ok: true,
        saved: result.saved,
        skipped: result.skipped,
        unchanged: result.unchanged,
      });
    } catch (err) {
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : "flush failed",
      });
    }
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
  generations: GenerationGate,
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

  if (generations.max > 0 && generations.active >= generations.max) {
    sendJson(res, 503, {
      error: `too many concurrent generations (max ${generations.max})`,
    });
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "x-content-type-options": "nosniff",
    // Tells nginx-style reverse proxies not to buffer the event stream.
    "x-accel-buffering": "no",
    connection: "keep-alive",
  });
  res.write(": open\n\n");

  const controller = new AbortController();
  res.on("close", () => controller.abort());

  const send = (frame: unknown): void => {
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  };

  generations.active += 1;
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
    generations.active -= 1;
  }
}

/**
 * SSE-stream a run owned by another process (CLI --detach, TUI): replay the
 * recorded events from the live-run store, tail live appends, then close with
 * a terminal status frame once the run's meta settles.
 */
function streamExternalRun(runId: string, store: LiveRunStore, res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "x-content-type-options": "nosniff",
    // Tells nginx-style reverse proxies not to buffer the event stream.
    "x-accel-buffering": "no",
    connection: "keep-alive",
  });
  res.write(": open\n\n");

  const ac = new AbortController();
  res.on("close", () => ac.abort());
  const heartbeat = startSseHeartbeat(res);

  void (async () => {
    try {
      for await (const event of store.tailEvents(runId, { signal: ac.signal })) {
        res.write(`data: ${JSON.stringify({ type: "event", event })}\n\n`);
      }
      if (!ac.signal.aborted) {
        const meta: LiveRunMeta | undefined = await store.get(runId);
        res.write(
          `data: ${JSON.stringify({
            type: "status",
            status: meta?.status ?? "error",
            ok: meta?.ok,
            error: meta?.error ?? (meta ? undefined : "unknown run"),
          })}\n\n`,
        );
      }
    } catch {
      if (!ac.signal.aborted && !res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({ type: "status", status: "error", error: "stream failed" })}\n\n`,
        );
      }
    } finally {
      clearInterval(heartbeat);
      try {
        if (!res.writableEnded) res.end();
      } catch {
        // The socket may already be destroyed; nothing left to clean up.
      }
    }
  })();
}

/**
 * Periodic SSE comment frames so proxies/load balancers with idle timeouts
 * don't silently sever a long-quiet stream (a run parked on an approval can
 * be idle for minutes). Returns the timer; callers clear it on stream end.
 */
function startSseHeartbeat(
  res: ServerResponse,
  intervalMs = 25_000,
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    try {
      if (!res.writableEnded) res.write(": heartbeat\n\n");
    } catch {
      clearInterval(timer);
    }
  }, intervalMs);
  timer.unref?.();
  return timer;
}

function streamRun(runId: string, runs: WorkflowRunManager, res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "x-content-type-options": "nosniff",
    // Tells nginx-style reverse proxies not to buffer the event stream.
    "x-accel-buffering": "no",
    connection: "keep-alive",
  });
  // A first comment line opens the stream promptly for the browser.
  res.write(": open\n\n");

  const heartbeat = startSseHeartbeat(res);
  const write = (payload: string, terminal: boolean): void => {
    try {
      res.write(`data: ${payload}\n\n`);
      if (terminal) {
        clearInterval(heartbeat);
        res.end();
      }
    } catch {
      // Socket destroyed mid-write; the 'close' handler unsubscribes.
      clearInterval(heartbeat);
    }
  };

  const unsubscribe = runs.subscribe(runId, write);
  if (!unsubscribe) {
    res.write(
      `data: ${JSON.stringify({ type: "status", status: "error", error: "unknown run" })}\n\n`,
    );
    clearInterval(heartbeat);
    res.end();
    return;
  }
  res.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

export interface StartWebUiOptions {
  config: SteamtrainConfig;
  workspaces: WorkspaceConfig;
  workflowCatalog: LoadedWorkflowCatalog;
  configLabel?: string;
  /** Pre-resolved project identity; when omitted, derived from `cwd`. */
  project?: ProjectIdentity;
  cwd?: string;
  home?: string;
  /** Resolved project `steamtrain.json` path for project-scope authoring. */
  configPath?: string;
  /**
   * Global `~/.steamtrain/config.json` path. Omit when a custom `--config`
   * file is in use (no global layer to read or write).
   */
  userConfigPath?: string;
  /** Raw agent entries from the global config file. */
  userAgents?: AgentInstanceConfig[];
  /** Raw agent entries from the project (or custom) config file. */
  projectAgents?: AgentInstanceConfig[];
  /** Raw API entries from the global config file. */
  userApis?: ApiInstanceConfig[];
  /** Raw API entries from the project (or custom) config file. */
  projectApis?: ApiInstanceConfig[];
  /**
   * True when `configPath` is a custom `--config` file (loads alone, no user
   * layer). Affects reload after scoped saves.
   */
  customConfig?: boolean;
  port?: number;
  host?: string;
  /** Require this token to access the web UI (cookie-based session). */
  authToken?: string;
  /**
   * Second credential that mints read-only sessions. Can coexist with
   * {@link authToken} so operators keep a full token and share a viewer one.
   */
  readToken?: string;
  /**
   * Force every session (and the no-auth localhost path) into read-only
   * capability — a dedicated share bind.
   */
  readOnly?: boolean;
  /**
   * Explicitly serve a non-local bind without authentication. Without this,
   * binding to a non-loopback host with no {@link authToken}/{@link readToken}
   * auto-generates a token and prints it, so an exposed server is never
   * silently open. When set, any supplied tokens are ignored.
   */
  noAuth?: boolean;
  /** Trust `X-Forwarded-*` headers (only set behind a reverse proxy you run). */
  trustProxy?: boolean;
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
 * Resolve the web-UI auth token from its sources, in precedence order:
 * `--no-auth` wins (disables auth outright), then an explicit `--auth-token`,
 * then the `STEAMTRAIN_AUTH_TOKEN` env var (which keeps the secret out of the
 * process list and shell history). Returns undefined when none applies —
 * `startWebUi` then auto-generates one for non-local binds.
 */
export function resolveWebAuthToken(opts: {
  authToken?: string;
  envToken?: string;
  noAuth?: boolean;
}): string | undefined {
  if (opts.noAuth) return undefined;
  return opts.authToken ?? opts.envToken;
}

/**
 * Resolve the web-UI read-only token: `--no-auth` wins, then `--read-token`,
 * then `STEAMTRAIN_READ_TOKEN`. Independent of the full auth token so an
 * operator can hand teammates a viewer credential without sharing control.
 */
export function resolveWebReadToken(opts: {
  readToken?: string;
  envToken?: string;
  noAuth?: boolean;
}): string | undefined {
  if (opts.noAuth) return undefined;
  return opts.readToken ?? opts.envToken;
}

/**
 * Boot the full web UI: build an orchestrator over the loaded catalog, run the
 * doctor once (so the picker shows agent health and runs are gated exactly like
 * the CLI), then serve until the process is stopped.
 */
export async function startWebUi(options: StartWebUiOptions): Promise<{
  server: Server;
  url: string;
  /** The port actually bound — differs from `options.port` when that was 0. */
  port: number;
  /** The live run manager, for callers that need to query or observe runs. */
  runs: WorkflowRunManager;
  doctor: DoctorResult[];
  authToken?: string;
  readToken?: string;
  readOnly?: boolean;
}> {
  const out = options.stdout ?? ((t: string) => process.stdout.write(t));
  const err = options.stderr ?? ((t: string) => process.stderr.write(t));
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  const project =
    options.project ?? resolveProjectIdentity(cwd, { home, configName: options.config.name });
  const port = options.port ?? DEFAULT_WEB_PORT;
  const host = options.host ?? DEFAULT_WEB_HOST;

  // Secure-by-default exposure: a non-local bind must have auth. When the
  // operator didn't supply a token (and didn't explicitly opt out), generate
  // one and print it — the frictionless localhost path is unaffected.
  // --no-auth is authoritative here (the contract this function owns), not just
  // in the CLI layer: it disables auth even if a token was also passed.
  let authToken = options.noAuth ? undefined : options.authToken;
  let readToken = options.noAuth ? undefined : options.readToken;
  const readOnly = Boolean(options.readOnly) && !options.noAuth;
  // Catch equal secrets after env/flag resolution — the CLI only compares the
  // raw flags, so STEAMTRAIN_AUTH_TOKEN=x + --read-token x would otherwise mint
  // a full session from the "shared" credential (auth is checked first).
  if (authToken && readToken && authToken === readToken) {
    throw new Error(
      "--auth-token and --read-token must be different values (including after STEAMTRAIN_AUTH_TOKEN / STEAMTRAIN_READ_TOKEN resolution)",
    );
  }
  let generatedToken: string | undefined;
  let generatedKind: "full" | "read" | undefined;
  if (!authToken && !readToken && !options.noAuth && isNonLocalHost(host)) {
    generatedToken = randomBytes(16).toString("hex");
    // A --read-only share bind auto-generates a *read* token so the printed
    // credential matches the process capability.
    if (readOnly) {
      readToken = generatedToken;
      generatedKind = "read";
    } else {
      authToken = generatedToken;
      generatedKind = "full";
    }
  }

  const liveConfig: SteamtrainConfig = { ...options.config };
  const liveLayers = {
    userAgents: options.userAgents ? [...options.userAgents] : undefined,
    projectAgents: options.projectAgents ? [...options.projectAgents] : undefined,
    userApis: options.userApis ? [...options.userApis] : undefined,
    projectApis: options.projectApis ? [...options.projectApis] : undefined,
  };
  const reloadLiveConfig = (): void => {
    const loaded = loadConfig(
      options.customConfig && options.configPath
        ? { customPath: options.configPath, home }
        : { cwd, home },
    );
    // Replace in place so Orchestrator / author closures keep the same object.
    for (const key of Object.keys(liveConfig)) {
      delete (liveConfig as Record<string, unknown>)[key];
    }
    Object.assign(liveConfig, loaded.config);
    liveLayers.userAgents = loaded.userAgents ? [...loaded.userAgents] : undefined;
    liveLayers.projectAgents = loaded.projectAgents ? [...loaded.projectAgents] : undefined;
    liveLayers.userApis = loaded.userApis ? [...loaded.userApis] : undefined;
    liveLayers.projectApis = loaded.projectApis ? [...loaded.projectApis] : undefined;
  };

  const orchestrator = new Orchestrator(
    liveConfig,
    options.workspaces,
    [],
    options.workflowCatalog,
  );

  // Health is reported live via /api/doctor; the page must not wait on it (the
  // doctor probes agent binaries and can take seconds), so we serve immediately
  // and let the catalog/health populate in the background.
  const doctorState = {
    results: [] as DoctorResult[],
    apis: [] as ApiDoctorResult[],
    error: null as string | null,
  };
  // Single-flight latches so overlapping on-demand rechecks coalesce (see the
  // reprobe hooks below) instead of spawning redundant concurrent probe rounds.
  let reprobeDoctorInFlight: Promise<DoctorResult[]> | null = null;
  let reprobeApiInFlight: Promise<ApiDoctorResult[]> | null = null;

  const cacheStore = createWorkflowCacheStore(join(cwd, WORKFLOW_CACHE_DIR));
  const historyStore = createWorkflowHistoryStore(join(cwd, WORKFLOW_HISTORY_DIR));
  const liveRunStore = createLiveRunStore(join(cwd, WORKFLOW_RUNS_DIR), { historyStore });
  const runs = new WorkflowRunManager({
    host: orchestrator,
    cacheStore,
    historyStore,
    cwd,
    maxConcurrent: options.maxConcurrent ?? 5,
    config: liveConfig,
    liveRuns: liveRunStore,
    // Notification deep links point at this server's own run pages. The real
    // address isn't known until `listen()` resolves (`--port 0` binds an
    // ephemeral port), so it is set below rather than here.
    // Point a detached background runner (mid-run detach) at the same project.
    // A config file is only forwarded when it's a custom `--config` (otherwise
    // `--project-dir` resolution already picks up the same user + project layers).
    detachIo: {
      projectDir: cwd,
      configPath: options.customConfig ? options.configPath : undefined,
    },
  });
  const author = new WorkflowAuthor({
    host: orchestrator,
    config: liveConfig,
    home,
    cwd,
    projectConfigPath: options.configPath,
    projectWorkflows: options.config.workflows,
  });
  const server = createWebServer({
    host: orchestrator,
    runs,
    author,
    history: historyStore,
    liveRuns: liveRunStore,
    workflowSource: (name) => orchestrator.workflowSource(name),
    doctor: () => doctorState.results,
    doctorError: () => doctorState.error,
    setDoctor: (results) => {
      doctorState.results = results;
      doctorState.error = null;
      orchestrator.setDoctor(results);
    },
    apiDoctor: () => doctorState.apis,
    setApiDoctor: (apis) => {
      doctorState.apis = apis;
    },
    // On-demand re-probe for the setup panel's Recheck: same work the startup
    // and config-save paths do (resolve binaries, refresh catalog annotations),
    // persisted into the live snapshot so subsequent GETs see it too. Each is
    // single-flighted: overlapping rechecks (a double-click, or a recheck racing
    // a config-save) coalesce onto the in-flight probe instead of spawning a
    // second `--version` storm and letting the slower write clobber the newer.
    reprobeDoctor: () => {
      if (!reprobeDoctorInFlight) {
        reprobeDoctorInFlight = (async () => {
          try {
            const results = await runDoctor(liveConfig);
            doctorState.results = results;
            doctorState.error = null;
            orchestrator.setDoctor(results);
            await refreshAgentCatalogCaches(liveConfig, results);
            return results;
          } finally {
            reprobeDoctorInFlight = null;
          }
        })();
      }
      return reprobeDoctorInFlight;
    },
    reprobeApiDoctor: () => {
      if (!reprobeApiInFlight) {
        reprobeApiInFlight = (async () => {
          try {
            const apis = await runApiDoctor(liveConfig);
            doctorState.apis = apis;
            return apis;
          } finally {
            reprobeApiInFlight = null;
          }
        })();
      }
      return reprobeApiInFlight;
    },
    configLabel: options.configLabel,
    project,
    bindHost: host,
    config: liveConfig,
    configPath: options.configPath,
    userConfigPath: options.userConfigPath,
    configLayers: liveLayers,
    reloadConfig: reloadLiveConfig,
    authToken,
    readToken,
    readOnly: readOnly || undefined,
    trustProxy: options.trustProxy,
    maxConcurrentGenerations: options.maxConcurrentGenerations,
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

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (listenErr) {
    // Drop the half-open server so a failed bind cannot keep the process (or a
    // test) alive after we rethrow.
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    const code =
      listenErr && typeof listenErr === "object" && "code" in listenErr
        ? (listenErr as NodeJS.ErrnoException).code
        : undefined;
    if (code === "EADDRINUSE") {
      throw new Error(
        `port ${port} is already in use on ${host}\n  stop the other process, or pass --port <n> (e.g. steamtrain --web-ui --port 4318)`,
      );
    }
    throw listenErr instanceof Error ? listenErr : new Error(String(listenErr));
  }

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  const url = `http://${host}:${actualPort}`;

  // Now that the bind is settled, point notification deep links at the port the
  // OS actually gave us. A wildcard bind has no single reachable name, so link
  // to localhost the way the pre-bind expression always did.
  runs.setPublicBaseUrl(
    `http://${host === "0.0.0.0" || host === "::" ? "localhost" : host}:${actualPort}`,
  );

  out(`\n🚂 steamtrain web UI running at ${url}\n`);
  out(`   ◈  project  ${project.name}  ·  ${project.displayPath}\n`);
  if (generatedToken) {
    const kindLabel = generatedKind === "read" ? "read-only" : "full";
    out(`   🔒 non-local bind: auth enabled with an auto-generated ${kindLabel} token.
      token: ${generatedToken}
      (set your own with --auth-token / --read-token or STEAMTRAIN_AUTH_TOKEN /
       STEAMTRAIN_READ_TOKEN; pass --no-auth to disable — anyone reaching the
       port can then run agents.)
`);
  } else if (authToken || readToken) {
    const parts: string[] = [];
    if (authToken) parts.push(readOnly ? "auth-token→read-only" : "auth-token→full");
    if (readToken) parts.push("read-token→read-only");
    out(`   🔒 auth enabled (${parts.join(", ")}); a login prompt will appear in the browser.\n`);
  } else if (readOnly) {
    out(
      "   👁  read-only mode (no auth): viewers can browse workflows and runs; every\n" +
        "      state-changing API returns 403. Prefer --read-token on a shared bind.\n",
    );
  } else if (isNonLocalHost(host)) {
    err(
      "   ⚠️  --no-auth on a non-local bind: anyone who can reach this port can\n" +
        "      run agents with your credentials and read run history. Prefer\n" +
        "      --auth-token behind a TLS reverse proxy.\n",
    );
  }
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

  // API readiness probes run independently of the agent doctor so a slow
  // agent binary never delays the API chips (and vice versa).
  void (async () => {
    try {
      doctorState.apis = await runApiDoctor(liveConfig);
    } catch (e) {
      err(`   api doctor failed: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  })();

  return {
    server,
    url,
    port: actualPort,
    runs,
    authToken,
    readToken,
    readOnly: readOnly || undefined,
    get doctor() {
      return doctorState.results;
    },
  };
}
