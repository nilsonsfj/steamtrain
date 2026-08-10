import type { AgentEvent, AgentId } from "../types/events";
import { type AgentAdapter, type AgentRunOptions } from "./adapter";
import type { AgentModel } from "./agent-model";
import {
  type RecoverAntigravityTranscriptOptions,
  lastAntigravityConversationForCwd,
  recoverAntigravityTranscriptText,
} from "./antigravity-transcript";
import { permissionArgs } from "./permissions";
import {
  type ProcessLine,
  type ProcessRunOptions,
  resolveAgentIdleTimeoutMs,
  runProcessLines,
} from "./spawn";
import { stderrSummary } from "./util";

/**
 * Known Antigravity CLI models (used by `/model` and autocomplete).
 *
 * Ground truth is `agy models` (agy 1.1.x). Gemini bases without a suffix are
 * kept so the effort picker can rewrite them onto a listed variant via
 * {@link resolveAntigravityModel}. Never invent slugs that are not in the
 * live catalog (e.g. `claude-sonnet-4-6-medium`, `gemini-3.1-pro-medium`).
 */
export const ANTIGRAVITY_MODELS: readonly AgentModel[] = [
  { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash" },
  { id: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)" },
  { id: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash (Medium)" },
  { id: "gemini-3.6-flash-low", name: "Gemini 3.6 Flash (Low)" },
  { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" },
  { id: "gemini-3.5-flash-high", name: "Gemini 3.5 Flash (High)" },
  { id: "gemini-3.5-flash-medium", name: "Gemini 3.5 Flash (Medium)" },
  { id: "gemini-3.5-flash-low", name: "Gemini 3.5 Flash (Low)" },
  { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
  { id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)" },
  { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
  // Live agy display name is "(Thinking)" but the id is bare; no effort flag.
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
  // Alias: bare opus is not listed; resolve rewrites to -thinking.
  { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
  { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
  // Alias: bare gpt-oss works, but the catalog lists -medium.
  { id: "gpt-oss-120b", name: "GPT-OSS 120B" },
  { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
];

/**
 * Bare model → allowed effort suffixes + default when none requested.
 * Sourced from live `agy models` / `--model` validation (agy 1.1.11):
 * - Gemini flash: low|medium|high (default high)
 * - Gemini 3.1 pro: low|high only (no medium)
 * - Claude Sonnet: no suffixes / no `--effort`
 * - Claude Opus: only `-thinking`
 * - GPT-OSS: only `-medium`
 */
const AGY_VARIANT_BASES: Readonly<
  Record<string, { readonly efforts: readonly string[]; readonly defaultEffort: string }>
> = {
  "gemini-3.6-flash": { efforts: ["low", "medium", "high"], defaultEffort: "high" },
  "gemini-3.5-flash": { efforts: ["low", "medium", "high"], defaultEffort: "high" },
  "gemini-3.1-pro": { efforts: ["low", "high"], defaultEffort: "high" },
  "claude-opus-4-6": { efforts: ["thinking"], defaultEffort: "thinking" },
  "gpt-oss-120b": { efforts: ["medium"], defaultEffort: "medium" },
};

/** Ids that current agy accepts as `--model` values (plus bare aliases we rewrite). */
const AGY_LISTED_MODEL_IDS = new Set<string>([
  "gemini-3.6-flash-high",
  "gemini-3.6-flash-medium",
  "gemini-3.6-flash-low",
  "gemini-3.5-flash-high",
  "gemini-3.5-flash-medium",
  "gemini-3.5-flash-low",
  "gemini-3.1-pro-high",
  "gemini-3.1-pro-low",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
]);

/** Legacy display labels from older agy builds → current slug ids. */
const LEGACY_DISPLAY_TO_SLUG: Readonly<Record<string, string>> = {
  "Gemini 3.6 Flash": "gemini-3.6-flash",
  "Gemini 3.6 Flash (High)": "gemini-3.6-flash-high",
  "Gemini 3.6 Flash (Medium)": "gemini-3.6-flash-medium",
  "Gemini 3.6 Flash (Low)": "gemini-3.6-flash-low",
  "Gemini 3.5 Flash": "gemini-3.5-flash",
  "Gemini 3.5 Flash (High)": "gemini-3.5-flash-high",
  "Gemini 3.5 Flash (Medium)": "gemini-3.5-flash-medium",
  "Gemini 3.5 Flash (Low)": "gemini-3.5-flash-low",
  "Gemini 3.1 Pro": "gemini-3.1-pro",
  "Gemini 3.1 Pro (High)": "gemini-3.1-pro-high",
  "Gemini 3.1 Pro (Low)": "gemini-3.1-pro-low",
  "Gemini 3.1 Pro (Medium)": "gemini-3.1-pro-high",
  "Claude Sonnet 4.6": "claude-sonnet-4-6",
  // Older steamtrain / agy builds used a -thinking suffix; current agy rejects it.
  "Claude Sonnet 4.6 (Thinking)": "claude-sonnet-4-6",
  "Claude Opus 4.6": "claude-opus-4-6",
  "Claude Opus 4.6 (Thinking)": "claude-opus-4-6-thinking",
  "GPT-OSS 120B": "gpt-oss-120b",
  "GPT-OSS 120B (Medium)": "gpt-oss-120b-medium",
};

const SLUG_EFFORT_SUFFIX: Record<string, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  thinking: "thinking",
  minimal: "minimal",
  // Accepted as aliases when remapping efforts from other providers.
  xhigh: "thinking",
  max: "thinking",
};

const EFFORT_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  thinking: "Thinking",
  minimal: "Minimal",
  xhigh: "Thinking",
  max: "Thinking",
};

const HAS_PAREN_EFFORT_SUFFIX = /\((Low|Medium|High|Thinking|Minimal)\)\s*$/i;
/** Slug id that already encodes effort, with a mistaken paren glued on. */
const SLUG_WITH_GLUED_PAREN =
  /^([a-z0-9]+(?:[.-][a-z0-9]+)*-(?:low|medium|high|thinking|minimal))\s+\((?:Low|Medium|High|Thinking|Minimal)\)$/i;
const LOOKS_LIKE_SLUG = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/i;
/** Retired Sonnet thinking slug that older steamtrain builds invented. */
const CLAUDE_SONNET_THINKING_ALIAS = /^claude-sonnet-4-6-thinking$/i;
/** Retired / invalid Gemini Pro medium slug (agy only lists low|high). */
const GEMINI_PRO_MEDIUM_ALIAS = /^gemini-3\.1-pro-medium$/i;

function splitSlugEffort(model: string): { base: string; effort?: string } {
  const match = /^(.*?)-(low|medium|high|thinking|minimal)$/i.exec(model);
  if (!match?.[1] || !match[2]) return { base: model };
  return { base: match[1], effort: match[2].toLowerCase() };
}

/**
 * Effort levels that may be baked into a slug for this bare model id.
 * Empty when agy rejects effort suffixes / `--effort` for the model (Claude Sonnet).
 */
export function antigravitySlugEffortsForModel(model: string): readonly string[] {
  const resolved = normalizeAntigravityModelId(model);
  const { base, effort } = splitSlugEffort(resolved);
  if (effort || HAS_PAREN_EFFORT_SUFFIX.test(resolved)) return [];
  return AGY_VARIANT_BASES[base.toLowerCase()]?.efforts ?? [];
}

function defaultSlugEffortForModel(base: string): string | undefined {
  return AGY_VARIANT_BASES[base.toLowerCase()]?.defaultEffort;
}

function normalizeAntigravityModelId(model: string): string {
  const trimmed = model.trim();
  // Repair "gemini-3.6-flash-high (High)" from older double-append bugs.
  const glued = SLUG_WITH_GLUED_PAREN.exec(trimmed);
  if (glued?.[1]) {
    const fixed = glued[1].toLowerCase();
    return repairRetiredAntigravitySlug(fixed);
  }

  const direct = LEGACY_DISPLAY_TO_SLUG[trimmed];
  if (direct) return direct;
  const lower = trimmed.toLowerCase();
  for (const [label, slug] of Object.entries(LEGACY_DISPLAY_TO_SLUG)) {
    if (label.toLowerCase() === lower) return slug;
  }
  return repairRetiredAntigravitySlug(trimmed);
}

/** Map retired / invalid invented slugs onto ids current agy accepts. */
function repairRetiredAntigravitySlug(id: string): string {
  if (CLAUDE_SONNET_THINKING_ALIAS.test(id)) return "claude-sonnet-4-6";
  if (GEMINI_PRO_MEDIUM_ALIAS.test(id)) return "gemini-3.1-pro-high";
  return id;
}

/**
 * Normalize to a slug current agy accepts, baking effort only when the
 * resulting id is a real catalog variant.
 *
 * Never invent suffixes for Claude Sonnet (agy rejects
 * `claude-sonnet-4-6-medium` and does not support `--effort` there).
 * Never invent `gemini-3.1-pro-medium` (pro only has low|high).
 * Never append a parenthetical `(High)` onto a kebab slug.
 */
export function resolveAntigravityModel(model: string, effort?: string): string {
  const resolved = normalizeAntigravityModelId(model);
  if (HAS_PAREN_EFFORT_SUFFIX.test(resolved)) return resolved;

  const { base, effort: bakedEffort } = splitSlugEffort(resolved);
  const variant = AGY_VARIANT_BASES[base.toLowerCase()];

  // Already a fully-qualified listed id (or unknown non-variant slug): keep it,
  // after repairing retired aliases above.
  if (bakedEffort) {
    if (!variant) return resolved;
    if (variant.efforts.includes(bakedEffort)) return `${base}-${bakedEffort}`;
    // Invalid baked effort for this family (e.g. gemini-3.1-pro-medium).
    return `${base}-${variant.defaultEffort}`;
  }

  if (!variant) {
    // Fixed models with no effort surface (Claude Sonnet): ignore carried-over efforts.
    return resolved;
  }

  const requested = effort?.trim() ? effort.trim().toLowerCase() : undefined;
  const requestedSuffix = requested ? SLUG_EFFORT_SUFFIX[requested] : undefined;
  const suffix =
    (requestedSuffix && variant.efforts.includes(requestedSuffix) ? requestedSuffix : undefined) ??
    variant.defaultEffort;
  const candidate = `${base}-${suffix}`;
  if (AGY_LISTED_MODEL_IDS.has(candidate) || variant.efforts.includes(suffix)) {
    // Unknown Title Case display labels still use the legacy paren form.
    if (!LOOKS_LIKE_SLUG.test(resolved) && /\s/.test(resolved)) {
      const label = EFFORT_LABELS[suffix];
      return label ? `${resolved} (${label})` : resolved;
    }
    return candidate;
  }
  return resolved;
}

/** Format steamtrain timeoutMs as a Go duration string for `--print-timeout`. */
export function formatAntigravityPrintTimeout(timeoutMs?: number): string | undefined {
  if (!timeoutMs || timeoutMs <= 0) return undefined;
  return `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`;
}

/**
 * Build headless argv for `agy`.
 *
 * Critical: `--print` consumes the next token as the prompt, so it must be
 * the final flag pair. Open inherited stdin can hang print mode — callers
 * must spawn with stdin ignored (this adapter does).
 */
export function buildAntigravityRunArgs(opts: AgentRunOptions): string[] {
  const printTimeout = formatAntigravityPrintTimeout(opts.timeoutMs);
  return [
    "--model",
    resolveAntigravityModel(opts.model, opts.effort),
    "--dangerously-skip-permissions",
    "--mode",
    "accept-edits",
    ...(opts.resumeSessionId ? ["--conversation", opts.resumeSessionId] : []),
    ...(printTimeout ? ["--print-timeout", printTimeout] : []),
    ...permissionArgs("antigravity", opts.permissions),
    ...(opts.extraArgs ?? []),
    "--print",
    opts.prompt,
  ];
}

const CONVERSATION_ID_PATTERNS: readonly RegExp[] = [
  /Created conversation\s+([0-9a-fA-F-]{8,})/,
  /conversation=([0-9a-fA-F-]{8,})/,
  /Stream completed for\s+([0-9a-fA-F-]{8,})/,
  /Stream goroutine exited for\s+([0-9a-fA-F-]{8,})/,
];

/** Pull a conversation UUID out of agy stderr / log noise. */
export function extractAntigravityConversationId(text: string): string | undefined {
  for (const pattern of CONVERSATION_ID_PATTERNS) {
    const match = pattern.exec(text);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export interface RunAntigravityProcessParams {
  id: AgentId;
  binary: string;
  args: string[];
  opts: AgentRunOptions;
  /** @internal Test seam — defaults to {@link runProcessLines}. */
  runLines?: (opts: ProcessRunOptions) => AsyncIterable<ProcessLine>;
  /** @internal Test seam — defaults to {@link recoverAntigravityTranscriptText}. */
  recoverTranscript?: (
    options: RecoverAntigravityTranscriptOptions,
  ) => ReturnType<typeof recoverAntigravityTranscriptText>;
  /** @internal Test seam — defaults to {@link lastAntigravityConversationForCwd}. */
  lastConversationForCwd?: (cwd: string) => string | undefined;
}

/**
 * Plain-text driver for Antigravity print mode.
 *
 * agy 1.1.x has no stream-json. We stream stdout lines as text_delta, discover
 * session ids from stderr, and fall back to the on-disk transcript when stdout
 * is empty (known non-TTY drop).
 */
export async function* runAntigravityProcess(
  params: RunAntigravityProcessParams,
): AsyncGenerator<AgentEvent> {
  const { binary, args, opts } = params;
  const id = opts.agentId ?? params.id;
  const startedAt = Date.now();
  let sessionId = opts.resumeSessionId;
  let emittedSession = false;
  const textParts: string[] = [];
  const pendingDeltas: string[] = [];
  let sawStdout = false;
  let sawError = false;
  const cwd = opts.cwd ?? process.cwd();
  const runLines = params.runLines ?? runProcessLines;
  const recoverTranscript = params.recoverTranscript ?? recoverAntigravityTranscriptText;
  const lastConversationForCwd =
    params.lastConversationForCwd ?? ((path: string) => lastAntigravityConversationForCwd(path));

  const emitSession = function* (): Generator<AgentEvent> {
    if (emittedSession || !sessionId) return;
    emittedSession = true;
    yield {
      kind: "session_start",
      agent: id,
      ts: Date.now(),
      sessionId,
      model: resolveAntigravityModel(opts.model, opts.effort),
    };
  };

  const flushPendingDeltas = function* (): Generator<AgentEvent> {
    while (pendingDeltas.length > 0) {
      const line = pendingDeltas.shift() as string;
      yield { kind: "text_delta", agent: id, ts: Date.now(), text: `${line}\n` };
    }
  };

  const processOpts: ProcessRunOptions = {
    binary,
    args,
    cwd: opts.cwd,
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    idleTimeoutMs: opts.idleTimeoutMs,
    signal: opts.signal,
    // Intentionally omit prompt — stdin must stay closed for agy print mode.
  };

  for await (const item of runLines(processOpts)) {
    if (item.kind === "stderr") {
      const found = extractAntigravityConversationId(item.text);
      if (found && !sessionId) {
        sessionId = found;
        yield* emitSession();
        yield* flushPendingDeltas();
      }
      continue;
    }

    if (item.kind === "line") {
      sawStdout = true;
      textParts.push(item.line);
      if (emittedSession || sessionId) {
        if (!emittedSession) yield* emitSession();
        yield* flushPendingDeltas();
        yield { kind: "text_delta", agent: id, ts: Date.now(), text: `${item.line}\n` };
      } else {
        // Hold text until session_start so event order matches other adapters.
        pendingDeltas.push(item.line);
      }
      continue;
    }

    if (item.kind === "exit") {
      const ts = Date.now();
      const stderr = item.stderr.trim();
      const summary = stderrSummary(stderr);
      const stderrTail = summary ? `: ${summary}` : "";
      if (item.sawStdout) sawStdout = true;

      if (!sessionId) {
        const fromStderr = extractAntigravityConversationId(item.stderr);
        if (fromStderr) sessionId = fromStderr;
      }
      if (!sessionId) {
        sessionId = lastConversationForCwd(cwd);
      }

      if (item.spawnError) {
        sawError = true;
        yield* emitSession();
        yield* flushPendingDeltas();
        yield {
          kind: "error",
          agent: id,
          ts,
          message: `failed to start '${binary}': ${item.spawnError}`,
          stderr: stderr || undefined,
          code: item.code,
        };
        return;
      }
      if (item.timedOut) {
        sawError = true;
        yield* emitSession();
        yield* flushPendingDeltas();
        yield {
          kind: "error",
          agent: id,
          ts,
          message: item.idleTimedOut
            ? `'${binary}' idle timeout after ${(resolveAgentIdleTimeoutMs(opts) ?? 0) / 1000}s with no output`
            : `'${binary}' timed out after ${opts.timeoutMs! / 1000}s`,
          category: "transient",
          timedOut: true,
          stderr: stderr || undefined,
          code: item.code,
        };
        return;
      }
      if ((item.code ?? 0) !== 0) {
        sawError = true;
        yield* emitSession();
        yield* flushPendingDeltas();
        yield {
          kind: "error",
          agent: id,
          ts,
          message: `'${binary}' exited with code ${item.code}${stderrTail}`,
          stderr: stderr || undefined,
          code: item.code,
        };
        return;
      }

      let text = textParts.join("\n").trim();
      if (!text || !sawStdout) {
        const recovered = recoverTranscript({
          cwd,
          conversationId: sessionId,
        });
        if (recovered) {
          sessionId = sessionId ?? recovered.conversationId;
          text = recovered.text;
          // session_start (if any) then any buffered lines, then recovered text.
          yield* emitSession();
          yield* flushPendingDeltas();
          yield { kind: "text_delta", agent: id, ts, text: `${text}\n` };
        }
      }

      // Prefer session_start before any remaining buffered text_delta / result.
      // emitSession / flushPendingDeltas are no-ops when already drained above.
      yield* emitSession();
      yield* flushPendingDeltas();

      if (!text && !sawError) {
        yield {
          kind: "error",
          agent: id,
          ts,
          message: `'${binary}' produced no output${stderrTail}`,
          stderr: stderr || undefined,
          code: item.code,
        };
        return;
      }

      yield {
        kind: "result",
        agent: id,
        ts,
        isError: false,
        text,
        durationMs: Date.now() - startedAt,
        // agy print mode does not report token usage / cost on stdout or in
        // transcript PLANNER_RESPONSE lines (as of 1.1.x).
      };
    }
  }
}

export class AntigravityAdapter implements AgentAdapter {
  readonly id: AgentId = "antigravity";
  readonly binary: string;
  /** Prefer Gemini 3.6 Flash at High effort; users can switch to the base id + effort. */
  readonly defaultModel = "gemini-3.6-flash-high";
  readonly supportsResume = true;

  constructor(binary = "agy") {
    this.binary = binary;
  }

  run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
    return runAntigravityProcess({
      id: this.id,
      binary: this.binary,
      args: buildAntigravityRunArgs(opts),
      opts,
    });
  }
}
