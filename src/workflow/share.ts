/**
 * Workflow sharing: export a self-describing package and import from a local
 * path or URL with schema validation, template lint, agent readiness preview,
 * and a prompt-injection / command review surface.
 *
 * Formats accepted on import (in priority order):
 *   1. Share envelope  `{ steamtrainWorkflow: 1, workflow: {...} }`
 *   2. Catalog snippet `{ workflows: { <name>: {...} } }`
 *   3. Bare WorkflowSpec `{ name?, phases, ... }`
 *
 * Export always writes the share envelope so a single file is enough to
 * re-import without guessing which layer or wrapper it came from.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { STEAMTRAIN_VERSION } from "../version";
import type { WorkflowSourceKind } from "./catalog";
import { lintTemplateRefs } from "./template";
import {
  type WorkflowSpec,
  type WorkflowStep,
  isAgentBackedStep,
  validateWorkflow,
  workflowAgentIds,
  workflowLlmSteps,
  workflowSpecSchema,
  workflowStepKind,
} from "./types";

/** Current share-file format version. Bump only on breaking envelope changes. */
export const SHARE_FORMAT_VERSION = 1 as const;

/** Distinctive suffix so a shared file is recognizable in a directory listing. */
export const SHARE_FILE_SUFFIX = ".steamtrain.json";

/** Hard cap on imported JSON size (matches the web UI body limit). */
export const MAX_SHARE_BYTES = 1 * 1024 * 1024;

/** Network fetch timeout for URL imports. */
export const SHARE_FETCH_TIMEOUT_MS = 30_000;

/** Max redirects when fetching a share URL (scheme re-checked each hop). */
export const SHARE_MAX_REDIRECTS = 5;

const shareEnvelopeSchema = z
  .object({
    steamtrainWorkflow: z.literal(SHARE_FORMAT_VERSION),
    exportedAt: z.string().optional(),
    exporter: z
      .object({
        name: z.string(),
        version: z.string(),
      })
      .strict()
      .optional(),
    source: z.enum(["bundled", "user", "project"]).optional(),
    /** Optional integrity digest of the canonical workflow JSON (`sha256:<hex>`). */
    checksum: z.string().optional(),
    workflow: workflowSpecSchema,
  })
  .strict();

const catalogSnippetSchema = z
  .object({
    workflows: z.record(workflowSpecSchema),
  })
  .strict();

export type ShareEnvelope = z.infer<typeof shareEnvelopeSchema>;

export interface ExportWorkflowOptions {
  /** Catalog source layer of the workflow being exported. */
  source?: WorkflowSourceKind;
  /** Exporter version override (tests). Defaults to {@link STEAMTRAIN_VERSION}. */
  version?: string;
  /** Fixed timestamp (tests). Defaults to `new Date().toISOString()`. */
  exportedAt?: string;
  /** Include a sha256 checksum of the workflow body. Default true. */
  checksum?: boolean;
}

export interface ExportWorkflowResult {
  envelope: ShareEnvelope;
  /** Pretty-printed JSON ready to write or print. */
  text: string;
  /** Suggested filename (`<name>.steamtrain.json`). */
  suggestedFileName: string;
}

/** Build a self-describing share package for one workflow. */
export function exportWorkflow(
  spec: WorkflowSpec,
  options: ExportWorkflowOptions = {},
): ExportWorkflowResult {
  const workflow: WorkflowSpec = { ...spec, name: spec.name };
  const envelope: ShareEnvelope = {
    steamtrainWorkflow: SHARE_FORMAT_VERSION,
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    exporter: {
      name: "steamtrain",
      version: options.version ?? STEAMTRAIN_VERSION,
    },
    ...(options.source ? { source: options.source } : {}),
    ...(options.checksum === false
      ? {}
      : { checksum: `sha256:${sha256Hex(canonicalWorkflowJson(workflow))}` }),
    workflow,
  };
  return {
    envelope,
    text: `${JSON.stringify(envelope, null, 2)}\n`,
    suggestedFileName: `${sanitizeFileStem(workflow.name)}${SHARE_FILE_SUFFIX}`,
  };
}

/** Write an exported package to disk (creates parent dirs). */
export function writeShareFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

export type ImportOriginKind = "file" | "url" | "stdin" | "text";

export interface ParsedSharePayload {
  /** Normalized, name-injected workflow ready for validate/save. */
  spec: WorkflowSpec;
  /** How the payload was shaped before normalization. */
  format: "envelope" | "catalog" | "bare";
  /** Envelope metadata when format is `envelope`. */
  envelope?: ShareEnvelope;
  /** Catalog key chosen when format is `catalog` and multiple names existed. */
  catalogName?: string;
  /** Names present in a multi-workflow catalog snippet (for error messages). */
  catalogNames?: string[];
  /** Checksum mismatch detail when an envelope declared one that does not match. */
  checksumWarning?: string;
}

export interface ParseShareOptions {
  /** Prefer this name when the payload is a multi-entry catalog or a nameless bare spec. */
  preferredName?: string;
  /** Fallback name for a bare spec that omits `name`. */
  fallbackName?: string;
}

/**
 * Parse unknown JSON into a single WorkflowSpec. Rejects ambiguous multi-workflow
 * catalog snippets unless `preferredName` picks one.
 */
export function parseSharePayload(
  raw: unknown,
  options: ParseShareOptions = {},
): { ok: true; payload: ParsedSharePayload } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "share payload must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;

  // 1. Share envelope
  if ("steamtrainWorkflow" in obj) {
    const parsed = shareEnvelopeSchema.safeParse(obj);
    if (!parsed.success) {
      return {
        ok: false,
        error: `invalid share envelope: ${formatZodIssue(parsed.error)}`,
      };
    }
    const name = options.preferredName ?? parsed.data.workflow.name;
    if (!name?.trim()) {
      return { ok: false, error: "share envelope workflow is missing a name" };
    }
    const spec: WorkflowSpec = { ...parsed.data.workflow, name: name.trim() };
    let checksumWarning: string | undefined;
    if (parsed.data.checksum) {
      const expected = parsed.data.checksum.replace(/^sha256:/i, "").toLowerCase();
      const actual = sha256Hex(canonicalWorkflowJson(parsed.data.workflow));
      if (expected !== actual) {
        checksumWarning = `checksum mismatch (declared sha256:${expected.slice(0, 12)}…, got sha256:${actual.slice(0, 12)}…) — file may have been edited after export`;
      }
    }
    return {
      ok: true,
      payload: {
        spec,
        format: "envelope",
        envelope: parsed.data,
        checksumWarning,
      },
    };
  }

  // 2. Catalog snippet `{ workflows: { … } }` (and steamtrain.json-shaped files)
  if ("workflows" in obj && isPlainObject(obj.workflows)) {
    const parsed = catalogSnippetSchema.safeParse({ workflows: obj.workflows });
    if (!parsed.success) {
      return {
        ok: false,
        error: `invalid workflows map: ${formatZodIssue(parsed.error)}`,
      };
    }
    const names = Object.keys(parsed.data.workflows);
    if (names.length === 0) {
      return { ok: false, error: "workflows map is empty" };
    }
    let chosen = options.preferredName;
    if (chosen && !parsed.data.workflows[chosen]) {
      return {
        ok: false,
        error: `workflow '${chosen}' not found in payload (available: ${names.join(", ")})`,
      };
    }
    if (!chosen) {
      if (names.length > 1) {
        return {
          ok: false,
          error: `payload contains ${names.length} workflows (${names.join(", ")}); pass --name <name> to pick one`,
        };
      }
      chosen = names[0];
    }
    const body = parsed.data.workflows[chosen!]!;
    const spec: WorkflowSpec = { ...body, name: chosen! };
    return {
      ok: true,
      payload: {
        spec,
        format: "catalog",
        catalogName: chosen,
        catalogNames: names,
      },
    };
  }

  // 3. Bare WorkflowSpec
  const preferred =
    options.preferredName?.trim() ||
    (typeof obj.name === "string" ? obj.name.trim() : "") ||
    options.fallbackName?.trim();
  if (!preferred) {
    return {
      ok: false,
      error: "workflow is missing a name; pass --name <name>",
    };
  }
  const bare = workflowSpecSchema.safeParse({ ...obj, name: preferred });
  if (!bare.success) {
    return {
      ok: false,
      error: `invalid workflow: ${formatZodIssue(bare.error)}`,
    };
  }
  return {
    ok: true,
    payload: {
      spec: { ...bare.data, name: preferred },
      format: "bare",
    },
  };
}

export type ShareFindingSeverity = "critical" | "high" | "medium" | "info";

export interface ShareTextSurface {
  /** Step id (or workflow-level label). */
  stepId: string;
  /** Phase id containing the step. */
  phaseId: string;
  kind: string;
  /** What kind of text this is. */
  field: "prompt" | "system" | "cmd" | "approval-prompt" | "human-prompt" | "items";
  /** Full text (may be long). */
  text: string;
  agent?: string;
  model?: string;
}

export interface ShareFinding {
  severity: ShareFindingSeverity;
  code: string;
  message: string;
  /** Step id when the finding is step-scoped. */
  stepId?: string;
  /** Related text surface field. */
  field?: ShareTextSurface["field"];
}

export interface ShareReview {
  surfaces: ShareTextSurface[];
  findings: ShareFinding[];
  /** Distinct agents the workflow pins. */
  agents: string[];
  /** Distinct models / modelClasses referenced. */
  models: string[];
  /** Nested workflow names invoked via `kind: "workflow"`. */
  nestedWorkflows: string[];
  /** True when any finding is critical/high — save requires `--yes`. */
  requiresConfirmation: boolean;
  summary: {
    prompts: number;
    commands: number;
    llmCalls: number;
    approvals: number;
    humans: number;
    envSteps: number;
    fullPermissions: number;
  };
}

/** Walk a spec and build the human-facing import review. */
export function reviewShareWorkflow(spec: WorkflowSpec): ShareReview {
  const surfaces: ShareTextSurface[] = [];
  const findings: ShareFinding[] = [];
  const models = new Set<string>();
  const nestedWorkflows = new Set<string>();
  let envSteps = 0;
  let fullPermissions = 0;
  let commands = 0;
  let approvals = 0;
  let humans = 0;

  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      const kind = workflowStepKind(step);
      collectStepSurfaces(phase.id, step, surfaces, models, nestedWorkflows);

      if (kind === "command") {
        commands += 1;
        const cmd = (step as { cmd: string }).cmd;
        findings.push({
          severity: "critical",
          code: "command_step",
          message: `command step '${step.id}' runs shell: ${truncate(cmd, 120)}`,
          stepId: step.id,
          field: "cmd",
        });
        if (/\b(rm\s+-rf|curl\s+|wget\s+|nc\s+|ncat\s+|python\s+-c|eval\s+|base64\s+)/i.test(cmd)) {
          findings.push({
            severity: "critical",
            code: "command_suspicious",
            message: `command step '${step.id}' looks high-risk (download/eval/destructive pattern)`,
            stepId: step.id,
            field: "cmd",
          });
        }
      }

      if (kind === "approval") {
        approvals += 1;
      }
      if (kind === "human") {
        humans += 1;
      }

      const env = (step as { env?: Record<string, string> }).env;
      if (env && Object.keys(env).length > 0) {
        envSteps += 1;
        findings.push({
          severity: "medium",
          code: "custom_env",
          message: `step '${step.id}' sets custom env: ${Object.keys(env).join(", ")}`,
          stepId: step.id,
        });
      }

      const permissions = (step as { permissions?: unknown }).permissions;
      const profile = permissionProfile(permissions);
      if (profile === "full") {
        fullPermissions += 1;
        findings.push({
          severity: "high",
          code: "full_permissions",
          message: `step '${step.id}' requests full permissions (unrestricted agent tools)`,
          stepId: step.id,
        });
      }

      if (kind === "issues") {
        const mode = (step as { mode?: string }).mode;
        if (typeof mode === "string" && /github/i.test(mode)) {
          findings.push({
            severity: "high",
            code: "issues_github",
            message: `issues step '${step.id}' can create GitHub issues (mode=${mode})`,
            stepId: step.id,
          });
        }
      }

      if (kind === "workflow") {
        const child = (step as { workflow: string }).workflow;
        findings.push({
          severity: "medium",
          code: "nested_workflow",
          message: `step '${step.id}' invokes nested workflow '${child}' (resolved from the local catalog at run time)`,
          stepId: step.id,
        });
      }
    }
  }

  if (spec.permissions) {
    const profile = permissionProfile(spec.permissions);
    if (profile === "full") {
      fullPermissions += 1;
      findings.push({
        severity: "high",
        code: "workflow_full_permissions",
        message: "workflow default permissions are full (unrestricted agent tools)",
      });
    }
  }

  for (const surface of surfaces) {
    for (const hit of scanPromptInjection(surface.text)) {
      findings.push({
        severity: hit.severity,
        code: hit.code,
        message: `${surface.field} on '${surface.stepId}': ${hit.message}`,
        stepId: surface.stepId,
        field: surface.field,
      });
    }
  }

  const agents = workflowAgentIds(spec);
  const llmCount = workflowLlmSteps(spec).length;
  const promptCount = surfaces.filter(
    (s) => s.field === "prompt" || s.field === "system" || s.field === "human-prompt",
  ).length;

  const unique = dedupeFindings(findings);
  const requiresConfirmation = unique.some(
    (f) => f.severity === "critical" || f.severity === "high",
  );

  return {
    surfaces,
    findings: unique,
    agents,
    models: [...models],
    nestedWorkflows: [...nestedWorkflows],
    requiresConfirmation,
    summary: {
      prompts: promptCount,
      commands,
      llmCalls: llmCount,
      approvals,
      humans,
      envSteps,
      fullPermissions,
    },
  };
}

export interface ImportValidationResult {
  ok: boolean;
  error?: string;
  warnings: string[];
  review: ShareReview;
}

/** Schema + structural validate + template lint + security review. */
export function validateImportedWorkflow(spec: WorkflowSpec): ImportValidationResult {
  const valid = validateWorkflow(spec);
  if (!valid.ok) {
    return {
      ok: false,
      error: valid.error,
      warnings: [],
      review: reviewShareWorkflow(spec),
    };
  }
  const warnings = [...(valid.warnings ?? []), ...lintTemplateRefs(spec)];
  const uniqueWarnings = [...new Set(warnings)];
  return {
    ok: true,
    warnings: uniqueWarnings,
    review: reviewShareWorkflow(spec),
  };
}

export interface ReadShareSourceOptions {
  /** Working directory for relative file paths. */
  cwd?: string;
  /** Custom fetch (tests). Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Override max bytes. */
  maxBytes?: number;
  /** Override fetch timeout. */
  timeoutMs?: number;
}

export interface ReadShareSourceResult {
  text: string;
  origin: ImportOriginKind;
  /** Absolute file path or final URL. */
  location: string;
  bytes: number;
}

/**
 * Load share JSON text from a local path, `file:` URL, or `http(s):` URL.
 * Does not parse — call {@link parseSharePayload} next.
 */
export async function readShareSource(
  source: string,
  options: ReadShareSourceOptions = {},
): Promise<{ ok: true; result: ReadShareSourceResult } | { ok: false; error: string }> {
  const maxBytes = options.maxBytes ?? MAX_SHARE_BYTES;
  const trimmed = source.trim();
  if (!trimmed) return { ok: false, error: "import source is empty" };

  // URL?
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return { ok: false, error: `invalid URL '${trimmed}'` };
    }
    if (url.protocol === "file:") {
      return readLocalFile(fileURLToPath(url), maxBytes);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return {
        ok: false,
        error: `unsupported URL scheme '${url.protocol}' (only http:, https:, and file: are allowed)`,
      };
    }
    return fetchShareUrl(url, {
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
      maxBytes,
      timeoutMs: options.timeoutMs ?? SHARE_FETCH_TIMEOUT_MS,
    });
  }

  const cwd = options.cwd ?? process.cwd();
  const filePath = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
  return readLocalFile(filePath, maxBytes);
}

/** Default on-disk path for an export when `--out` is omitted. */
export function defaultExportPath(cwd: string, workflowName: string): string {
  return join(cwd, `${sanitizeFileStem(workflowName)}${SHARE_FILE_SUFFIX}`);
}

/** Resolve `--out`: directories get the suggested filename appended. */
export function resolveExportOutputPath(
  cwd: string,
  workflowName: string,
  out?: string,
): string {
  if (!out || out === "-") return defaultExportPath(cwd, workflowName);
  const abs = isAbsolute(out) ? out : resolve(cwd, out);
  if (out.endsWith("/") || out.endsWith("\\") || (existsSync(abs) && isDirectorySafe(abs))) {
    return join(abs, `${sanitizeFileStem(workflowName)}${SHARE_FILE_SUFFIX}`);
  }
  return abs;
}

/** Format a review for human CLI output. */
export function formatShareReview(
  spec: WorkflowSpec,
  review: ShareReview,
  options: {
    origin: string;
    format: ParsedSharePayload["format"];
    warnings?: string[];
    checksumWarning?: string;
    agentStatus?: Array<{ agent: string; status: string; message: string }>;
    maxPromptChars?: number;
  },
): string {
  const maxPrompt = options.maxPromptChars ?? 400;
  const lines: string[] = [];
  const stepCount = countSteps(spec);
  lines.push(`workflow '${spec.name}'${spec.description ? ` — ${spec.description}` : ""}`);
  lines.push(`  from ${options.origin}  (${options.format} format)`);
  lines.push(
    `  ${spec.phases.length} phase${spec.phases.length === 1 ? "" : "s"} · ${stepCount} step${stepCount === 1 ? "" : "s"} · prompts:${review.summary.prompts} · commands:${review.summary.commands} · llm:${review.summary.llmCalls}`,
  );

  if (review.agents.length > 0) {
    lines.push(`  agents: ${review.agents.join(", ")}`);
  }
  if (review.models.length > 0) {
    lines.push(`  models: ${review.models.join(", ")}`);
  }
  if (review.nestedWorkflows.length > 0) {
    lines.push(`  nested workflows: ${review.nestedWorkflows.join(", ")}`);
  }

  if (options.agentStatus && options.agentStatus.length > 0) {
    lines.push("  agent readiness:");
    for (const a of options.agentStatus) {
      const mark = a.status === "ok" ? "ok" : "!!";
      lines.push(`    [${mark}] ${a.agent}: ${a.message}`);
    }
  }

  if (options.checksumWarning) {
    lines.push(`  checksum: ${options.checksumWarning}`);
  }

  if (options.warnings && options.warnings.length > 0) {
    lines.push("  validation warnings:");
    for (const w of options.warnings) lines.push(`    - ${w}`);
  }

  if (review.findings.length > 0) {
    lines.push("  security review:");
    for (const f of review.findings) {
      lines.push(`    [${f.severity}] ${f.message}`);
    }
  } else {
    lines.push("  security review: no high-risk patterns detected");
  }

  if (review.surfaces.length > 0) {
    lines.push("  text surfaces (review before saving):");
    for (const s of review.surfaces) {
      const meta = [s.kind, s.field, s.agent, s.model].filter(Boolean).join(" · ");
      lines.push(`    ▸ ${s.phaseId}/${s.stepId} (${meta})`);
      for (const chunk of wrapBlock(s.text, maxPrompt, 6)) {
        lines.push(`        ${chunk}`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

function readLocalFile(
  filePath: string,
  maxBytes: number,
): { ok: true; result: ReadShareSourceResult } | { ok: false; error: string } {
  if (!existsSync(filePath)) {
    return { ok: false, error: `file not found: ${filePath}` };
  }
  let text: string;
  try {
    const buf = readFileSync(filePath);
    if (buf.byteLength > maxBytes) {
      return {
        ok: false,
        error: `file exceeds ${maxBytes} byte limit (${buf.byteLength} bytes)`,
      };
    }
    text = buf.toString("utf8");
  } catch (err) {
    return {
      ok: false,
      error: `could not read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return {
    ok: true,
    result: {
      text,
      origin: "file",
      location: filePath,
      bytes: Buffer.byteLength(text, "utf8"),
    },
  };
}

async function fetchShareUrl(
  start: URL,
  options: {
    fetch: typeof fetch;
    maxBytes: number;
    timeoutMs: number;
  },
): Promise<{ ok: true; result: ReadShareSourceResult } | { ok: false; error: string }> {
  let current = start;
  for (let hop = 0; hop <= SHARE_MAX_REDIRECTS; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      return {
        ok: false,
        error: `refusing redirect to '${current.protocol}' (only http/https allowed)`,
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    let response: Response;
    try {
      response = await options.fetch(current.href, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "application/json, text/plain;q=0.9, */*;q=0.1",
          "User-Agent": `steamtrain/${STEAMTRAIN_VERSION} (workflow-import)`,
        },
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        return {
          ok: false,
          error: `timed out fetching ${current.href} after ${options.timeoutMs}ms`,
        };
      }
      return {
        ok: false,
        error: `failed to fetch ${current.href}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    clearTimeout(timer);

    if (response.status >= 300 && response.status < 400) {
      const loc = response.headers.get("location");
      if (!loc) {
        return { ok: false, error: `redirect from ${current.href} with no Location header` };
      }
      try {
        current = new URL(loc, current);
      } catch {
        return { ok: false, error: `invalid redirect Location '${loc}'` };
      }
      continue;
    }

    if (!response.ok) {
      return {
        ok: false,
        error: `fetch ${current.href} returned HTTP ${response.status} ${response.statusText}`.trim(),
      };
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength && Number(contentLength) > options.maxBytes) {
      return {
        ok: false,
        error: `remote file exceeds ${options.maxBytes} byte limit (Content-Length ${contentLength})`,
      };
    }

    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.byteLength > options.maxBytes) {
      return {
        ok: false,
        error: `remote file exceeds ${options.maxBytes} byte limit (${buf.byteLength} bytes)`,
      };
    }

    return {
      ok: true,
      result: {
        text: buf.toString("utf8"),
        origin: "url",
        location: current.href,
        bytes: buf.byteLength,
      },
    };
  }
  return {
    ok: false,
    error: `too many redirects (max ${SHARE_MAX_REDIRECTS}) fetching ${start.href}`,
  };
}

function collectStepSurfaces(
  phaseId: string,
  step: WorkflowStep,
  surfaces: ShareTextSurface[],
  models: Set<string>,
  nested: Set<string>,
): void {
  const kind = workflowStepKind(step);
  const agent =
    typeof (step as { agent?: string }).agent === "string"
      ? (step as { agent: string }).agent
      : undefined;
  const model =
    typeof (step as { model?: string }).model === "string"
      ? (step as { model: string }).model
      : typeof (step as { modelClass?: string }).modelClass === "string"
        ? `class:${(step as { modelClass: string }).modelClass}`
        : undefined;
  if (model) models.add(model);

  const push = (field: ShareTextSurface["field"], text: string | undefined) => {
    if (typeof text !== "string" || !text.trim()) return;
    surfaces.push({
      stepId: step.id,
      phaseId,
      kind,
      field,
      text,
      agent,
      model,
    });
  };

  if (kind === "command") {
    push("cmd", (step as { cmd: string }).cmd);
    return;
  }
  if (kind === "llm") {
    push("prompt", (step as { prompt: string }).prompt);
    push("system", (step as { system?: string }).system);
    return;
  }
  if (kind === "human") {
    push("human-prompt", (step as { prompt: string }).prompt);
    return;
  }
  if (kind === "approval") {
    push("approval-prompt", (step as { prompt?: string }).prompt);
    return;
  }
  if (kind === "workflow") {
    nested.add((step as { workflow: string }).workflow);
    return;
  }
  if (kind === "distributor") {
    const items = (step as { items?: string[] }).items;
    if (items?.length) push("items", items.join("\n"));
    push("prompt", (step as { prompt?: string }).prompt);
    return;
  }
  if (kind === "consolidator") {
    push("prompt", (step as { prompt?: string }).prompt);
    return;
  }
  if (kind === "merge") {
    push("prompt", (step as { prompt?: string }).prompt);
    return;
  }
  if (isAgentBackedStep(step) || kind === "worker" || kind === "processor") {
    push("prompt", (step as { prompt?: string }).prompt);
  }
}

interface InjectionHit {
  severity: ShareFindingSeverity;
  code: string;
  message: string;
}

/** Heuristic scan for prompt-injection / exfil patterns in imported text. */
export function scanPromptInjection(text: string): InjectionHit[] {
  const hits: InjectionHit[] = [];
  const lower = text.toLowerCase();

  const patterns: Array<{
    re: RegExp;
    severity: ShareFindingSeverity;
    code: string;
    message: string;
  }> = [
    {
      re: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts|rules)/i,
      severity: "critical",
      code: "inject_ignore_previous",
      message: "contains 'ignore previous instructions' style override",
    },
    {
      re: /disregard\s+(your|all|any)\s+(instructions|rules|guidelines|safety)/i,
      severity: "critical",
      code: "inject_disregard",
      message: "contains 'disregard instructions' style override",
    },
    {
      re: /\byou\s+are\s+now\b/i,
      severity: "high",
      code: "inject_role_hijack",
      message: "attempts to reassign the agent role ('you are now…')",
    },
    {
      re: /\b(system\s+prompt|developer\s+message)\b/i,
      severity: "high",
      code: "inject_system_prompt",
      message: "references system/developer prompt takeover",
    },
    {
      re: /\b(do\s+not\s+tell\s+the\s+user|hide\s+this\s+from|secretly)\b/i,
      severity: "high",
      code: "inject_conceal",
      message: "asks the agent to conceal actions from the user",
    },
    {
      re: /\b(exfiltrat|send\s+(this|the)\s+(to|data)|curl\s+https?:\/\/|wget\s+https?:\/\/)/i,
      severity: "critical",
      code: "inject_exfil",
      message: "looks like a data-exfiltration instruction",
    },
    {
      re: /```[\s\S]{0,40}(bash|sh|zsh|powershell|cmd)/i,
      severity: "medium",
      code: "inject_shell_fence",
      message: "embeds a shell code fence (review carefully)",
    },
  ];

  for (const p of patterns) {
    if (p.re.test(text)) hits.push({ severity: p.severity, code: p.code, message: p.message });
  }

  if (/[A-Za-z0-9+/]{120,}={0,2}/.test(text) && !lower.includes("{{")) {
    hits.push({
      severity: "medium",
      code: "inject_base64_blob",
      message: "contains a long base64-like blob (possible obfuscation)",
    });
  }

  return hits;
}

function permissionProfile(permissions: unknown): string | undefined {
  if (typeof permissions === "string") return permissions;
  if (permissions && typeof permissions === "object" && "profile" in permissions) {
    const profile = (permissions as { profile?: unknown }).profile;
    return typeof profile === "string" ? profile : undefined;
  }
  return undefined;
}

function dedupeFindings(findings: ShareFinding[]): ShareFinding[] {
  const seen = new Set<string>();
  const out: ShareFinding[] = [];
  for (const f of findings) {
    const key = `${f.severity}|${f.code}|${f.stepId ?? ""}|${f.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  const order: Record<ShareFindingSeverity, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    info: 3,
  };
  return out.sort(
    (a, b) => order[a.severity] - order[b.severity] || a.message.localeCompare(b.message),
  );
}

function canonicalWorkflowJson(spec: WorkflowSpec): string {
  return JSON.stringify(spec);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sanitizeFileStem(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "workflow";
}

function formatZodIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "schema error";
  const path = issue.path.length > 0 ? issue.path.join(".") : "root";
  return `${path}: ${issue.message}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function truncate(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

function isDirectorySafe(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function countSteps(spec: WorkflowSpec): number {
  return spec.phases.reduce((n, p) => n + p.steps.length, 0);
}

function wrapBlock(text: string, maxChars: number, maxLines: number): string[] {
  const trimmed = text.trimEnd();
  const sliced = trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed;
  const lines = sliced.split("\n");
  if (lines.length <= maxLines) return lines.map((l) => l || " ");
  return [...lines.slice(0, maxLines - 1), `… (+${lines.length - (maxLines - 1)} more lines)`];
}
