import { type ResolvedApiInstance, resolveApiInstances } from "../apis/config";
import { type LlmStepApiFields, resolveLlmStepApi } from "../apis/resolve";
import type { SteamtrainConfig } from "../config/types";
import type { ApiProviderId, TokenUsage } from "../types/events";
import { redactSecrets } from "../util/redact";
import { hashWorkflowSpec } from "./cache-store";
import type { RunRecord } from "./history";
import type { LlmCallRequest, LlmComplete } from "./llm";
import { callLlm } from "./llm-call";
import { classifyRun } from "./report";
import { PROMPT_EDITABLE_KINDS, isAgentBackedStep } from "./step-kind";
import {
  type JsonSchema,
  parseStructuredOutput,
  structuredOutputFixPrompt,
  withStructuredOutputInstructions,
} from "./structured";
import { lintTemplateRefs } from "./template";
import { type WorkflowSpec, type WorkflowStep, validateWorkflow, workflowStepKind } from "./types";

/**
 * Failure postmortem: feed a recorded run to one direct-API LLM call and get
 * back a plain-language root cause, a category, and — when the fix is a spec
 * change — a concrete edit validated against the current workflow spec.
 *
 * Every surface (CLI `workflow history why`, the web "Diagnose" action, the
 * TUI postmortem panel) drives this one module.
 */

export const POSTMORTEM_CATEGORIES = [
  "spec-bug",
  "prompt-bug",
  "flaky-agent",
  "environment",
  "input-data",
  "resource-budget",
  "unknown",
] as const;
export type PostmortemCategory = (typeof POSTMORTEM_CATEGORIES)[number];

export const POSTMORTEM_CONFIDENCES = ["low", "medium", "high"] as const;
export type PostmortemConfidence = (typeof POSTMORTEM_CONFIDENCES)[number];

/** The spec fields a postmortem may propose to change. */
export const POSTMORTEM_FIX_FIELDS = ["prompt", "cmd", "model", "effort"] as const;
export type PostmortemFixField = (typeof POSTMORTEM_FIX_FIELDS)[number];

export interface PostmortemSpecFix {
  stepId: string;
  field: PostmortemFixField;
  /** The value currently in the spec, as far as the model saw it. */
  current?: string;
  /** Full replacement value for the field (not a diff). */
  proposed: string;
  rationale?: string;
  /** Set by {@link diagnoseRun} when a workflow spec was available. */
  validation?: { ok: boolean; error?: string };
}

export interface PostmortemDiagnosis {
  /** Plain-language root cause (or what stands out, for a successful run). */
  summary: string;
  category: PostmortemCategory;
  confidence: PostmortemConfidence;
  /** The step identified as the root failure, when any. */
  rootStepId?: string;
  /** Evidence quoted from the record. */
  evidence?: string;
  /** What to change (prose; the concrete edit lives in {@link specFix}). */
  suggestion?: string;
  specFix?: PostmortemSpecFix;
}

export interface PostmortemRequest {
  record: RunRecord;
  /** The current spec of `record.workflow`, when it still resolves. */
  spec?: WorkflowSpec;
  config?: SteamtrainConfig;
  /** API instance override (an id under `apis`, e.g. `anthropic`). */
  api?: string;
  /** Model override. */
  model?: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  /** Test seam: transport injection (defaults to {@link callLlm}). */
  llmComplete?: LlmComplete;
}

export type PostmortemResult =
  | {
      ok: true;
      diagnosis: PostmortemDiagnosis;
      api: string;
      model: string;
      tokens?: TokenUsage;
      /** True when the current spec no longer matches the run's spec hash. */
      specDrift: boolean;
    }
  | { ok: false; error: string };

/** Wall-clock cap for each postmortem LLM call. */
export const POSTMORTEM_TIMEOUT_MS = 120_000;
/** Per-step output/error cap inside the digest (matches the CI report cap). */
export const POSTMORTEM_STEP_TEXT_CAP = 4_000;
/** The spec JSON shipped to the model is capped at this many characters. */
export const POSTMORTEM_SPEC_CAP = 24_000;
/** Whole-digest safety valve. */
export const POSTMORTEM_DIGEST_CAP = 120_000;

const INPUT_CAP = 500;
const OK_STEP_OUTPUT_CAP = 200;

export const POSTMORTEM_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    summary: { type: "string", minLength: 1 },
    category: { enum: [...POSTMORTEM_CATEGORIES] },
    confidence: { enum: [...POSTMORTEM_CONFIDENCES] },
    rootStepId: { type: "string" },
    evidence: { type: "string" },
    suggestion: { type: "string" },
    specFix: {
      type: "object",
      properties: {
        stepId: { type: "string", minLength: 1 },
        field: { enum: [...POSTMORTEM_FIX_FIELDS] },
        current: { type: "string" },
        proposed: { type: "string", minLength: 1 },
        rationale: { type: "string" },
      },
      required: ["stepId", "field", "proposed"],
      additionalProperties: false,
    },
  },
  required: ["summary", "category", "confidence"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are the failure-postmortem engine of steamtrain, a workflow orchestrator that runs AI-agent, shell-command, and direct-LLM steps in phases. You are given a digest of one recorded run. Diagnose it.

Step kinds: distributor (splits work into items), worker/processor (agent steps), consolidator (merges results), gate (pass/fail condition on a step's output), approval (human checkpoint), human (human-supplied output), command (shell), llm (one direct API call), merge (git merge-back), workflow (sub-workflow call).

Rules:
- Base every claim on the digest; cite step ids and quote short excerpts as evidence.
- Categories: spec-bug (workflow structure or fields are wrong), prompt-bug (a step's prompt misleads or under-specifies the agent), flaky-agent (the agent misbehaved despite a sound spec), environment (missing binary, API key, network, or OS problem), input-data (the run input or an upstream output was unsuitable), resource-budget (a timeout or cost cap was too tight), unknown (cannot tell from the record).
- Pick exactly one root-cause step (rootStepId) when the failure has one; a gate that correctly rejected bad upstream output is a symptom, not the root cause — name the step that produced the bad output.
- specFix: propose it only when the fix is changing one step's prompt, cmd, model, or effort. Quote the current value from the spec digest, and give 'proposed' as a complete replacement value (not a diff), minimal and ready to run. Never invent template references the spec does not already use.
- If the run succeeded, say so in the summary, set category to 'unknown' and confidence to 'high', and note anything notable (cost, duration, near-misses).`;

/**
 * Project a recorded run into the redacted, capped text digest the postmortem
 * model sees. Pure and deterministic.
 */
export function buildPostmortemDigest(
  record: RunRecord,
  options: { spec?: WorkflowSpec; specDrift?: boolean } = {},
): string {
  const outcome = classifyRun(record);
  const lines: string[] = [];
  lines.push("## Run");
  lines.push(`workflow: ${record.workflow}`);
  lines.push(`run id: ${record.id}`);
  lines.push(`status: ${record.status} (outcome: ${outcome})`);
  lines.push(
    `totals: ${record.totals.ok}/${record.totals.steps} steps ok, ${record.totals.failed} failed` +
      `, $${record.totals.costUsd.toFixed(4)}, ${Math.round(record.durationMs / 1000)}s`,
  );
  const input = redactSecrets(record.input ?? "").slice(0, INPUT_CAP);
  lines.push(`input: ${input || "(empty)"}`);
  if (record.params && Object.keys(record.params).length > 0) {
    lines.push(`params: ${redactSecrets(JSON.stringify(record.params))}`);
  }
  if (record.budget) {
    lines.push(
      `budget exceeded: ${record.budget.scope}${record.budget.stepId ? ` (step '${record.budget.stepId}')` : ""}` +
        ` — spent $${record.budget.spentUsd.toFixed(4)} of $${record.budget.limitUsd.toFixed(4)}`,
    );
  }
  if (record.error) lines.push(`run error: ${redactSecrets(record.error)}`);
  if (record.interventions?.length) {
    const interventions = record.interventions
      .map((i) => `${i.kind}${i.stepId ? ` (${i.stepId})` : ""}`)
      .join(", ");
    lines.push(`interventions: ${interventions}`);
  }

  if (options.spec) {
    lines.push("");
    lines.push("## Workflow spec (current)");
    if (options.specDrift) {
      lines.push(
        "note: the spec below has DRIFTED since this run — the run recorded a different spec hash, so field values at run time may differ.",
      );
    }
    lines.push(capText(redactSecrets(JSON.stringify(options.spec, null, 2)), POSTMORTEM_SPEC_CAP));
  } else {
    lines.push("");
    lines.push("## Workflow spec");
    lines.push("(not available — the workflow no longer resolves by this name)");
  }

  lines.push("");
  lines.push("## Steps (run order)");
  for (const phase of record.phases) {
    const iteration =
      phase.iteration && phase.iteration > 1 ? ` (iteration ${phase.iteration})` : "";
    lines.push(`### phase '${phase.phaseId}' — ${phase.title}${iteration}`);
    for (const step of phase.steps) {
      lines.push(...renderDigestStep(step));
    }
  }

  return capText(lines.join("\n"), POSTMORTEM_DIGEST_CAP);
}

function renderDigestStep(step: RunRecord["phases"][number]["steps"][number]): string[] {
  const result = step.result;
  const target = `${step.agent ?? step.api ?? ""}${step.model ? `/${step.model}` : ""}` || "engine";
  const header = `${step.status === "error" ? "✗" : step.status === "done" ? "✓" : "·"} ${step.stepId} (${step.blockKind}, ${target}${step.attempts && step.attempts > 1 ? `, attempts: ${step.attempts}` : ""})`;

  if (result?.skipped) return [`${header} — skipped`];
  if (result?.dependencyFailed) {
    return [`${header} — never ran: dependency '${result.dependencyFailed}' failed`];
  }

  if (step.status !== "error" && result?.ok !== false) {
    const bits: string[] = [header];
    if (step.gate) {
      bits[0] += ` — gate ${step.gate.passed ? "passed" : "REJECTED"}${step.gate.target ? ` (target: ${step.gate.target})` : ""}${step.gate.onFalse ? ` (onFalse: ${step.gate.onFalse})` : ""}`;
    }
    const output = oneLine(redactSecrets(step.text ?? "")).slice(0, OK_STEP_OUTPUT_CAP);
    if (output) bits[0] += ` — output: ${output}`;
    return bits;
  }

  const lines = [header];
  const error = result?.error ?? step.text ?? "";
  if (error)
    lines.push(`  error: ${indent(capText(redactSecrets(error), POSTMORTEM_STEP_TEXT_CAP))}`);
  const output = result?.output && result.output !== error ? result.output : "";
  if (output) {
    lines.push(`  output: ${indent(capText(redactSecrets(output), POSTMORTEM_STEP_TEXT_CAP))}`);
  }
  if (result?.exitCode !== undefined) lines.push(`  exit code: ${result.exitCode}`);
  if (step.gate) {
    lines.push(
      `  gate: ${step.gate.passed ? "passed" : "REJECTED"}${step.gate.target ? ` (target: ${step.gate.target})` : ""}${step.gate.onFalse ? ` (onFalse: ${step.gate.onFalse})` : ""}`,
    );
  }
  if (step.approval?.approved === false) {
    lines.push(
      `  approval: rejected${step.approval.note ? ` — ${redactSecrets(step.approval.note)}` : ""}`,
    );
  }
  if (result?.permissions?.violations?.length) {
    lines.push(`  permission violations: ${result.permissions.violations.join(", ")}`);
  }
  if (step.dependsOn?.length) lines.push(`  depends on: ${step.dependsOn.join(", ")}`);
  if (step.item) lines.push(`  fan-out item #${step.item.index} of '${step.item.sourceStepId}'`);
  return lines;
}

/**
 * Resolve which API instance/model/key the postmortem call uses.
 *
 * Explicit `api`/`model` overrides go through the same resolution an `llm`
 * step gets. Without overrides the first usable instance wins: keyed
 * instances first (built-in order, then configured), keyless ones last, so a
 * postmortem works out of the box even with no keys configured at all.
 */
export function resolvePostmortemApi(
  config: SteamtrainConfig | undefined,
  env: Record<string, string | undefined> = process.env,
  overrides: { api?: string; model?: string } = {},
):
  | {
      ok: true;
      api: ResolvedApiInstance;
      provider: ApiProviderId;
      model: string;
      apiKey: string;
      baseUrl?: string;
    }
  | { ok: false; error: string } {
  if (overrides.api || overrides.model) {
    const fields: LlmStepApiFields = { api: overrides.api, model: overrides.model };
    const resolved = resolveLlmStepApi(fields, config);
    if (!resolved.ok)
      return { ok: false, error: resolved.error.replace(/^llm step /, "postmortem ") };
    const apiKey = env[resolved.apiKeyEnv] ?? "";
    if (!apiKey && !resolved.keyless) {
      return {
        ok: false,
        error: `postmortem needs an API key in the ${resolved.apiKeyEnv} environment variable (api '${resolved.api.id}')`,
      };
    }
    return {
      ok: true,
      api: resolved.api,
      provider: resolved.provider,
      model: resolved.model,
      apiKey,
      baseUrl: resolved.baseUrl,
    };
  }

  const instances = resolveApiInstances(config);
  const keyed = instances.filter((api) => !api.keyless && env[api.apiKeyEnv]);
  const keyless = instances.filter((api) => api.keyless);
  for (const api of [...keyed, ...keyless]) {
    const model = api.defaultModel ?? BUILTIN_FALLBACK_MODELS[api.id];
    if (!model) continue;
    return {
      ok: true,
      api,
      provider: api.provider,
      model,
      apiKey: env[api.apiKeyEnv] ?? "",
      baseUrl: api.baseUrl,
    };
  }
  return {
    ok: false,
    error:
      "postmortem needs an LLM API: set ANTHROPIC_API_KEY or OPENAI_API_KEY, configure an api instance with a defaultModel under 'apis', or pass --api <id> / --model <model>",
  };
}

/** Model used when a built-in instance has no configured `defaultModel`. */
export const BUILTIN_FALLBACK_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.5",
  "opencode-zen": "opencode/big-pickle",
};

export type SpecFixValidation = { ok: true } | { ok: false; error: string };

/**
 * Validate a proposed spec edit against the current workflow spec: the step
 * must exist, the field must be editable on that step kind (extending the
 * mid-run prompt-only rule to also allow cmd, model, and effort), and the
 * patched spec must still pass validation and introduce no new
 * template-reference lint warnings.
 */
export function validatePostmortemSpecFix(
  spec: WorkflowSpec,
  fix: PostmortemSpecFix,
): SpecFixValidation {
  let target: WorkflowStep | undefined;
  for (const phase of spec.phases) {
    target = phase.steps.find((step) => step.id === fix.stepId);
    if (target) break;
  }
  if (!target) return { ok: false, error: `unknown step '${fix.stepId}'` };

  const kind = workflowStepKind(target);
  const agentBacked = isAgentBackedStep(target);
  if (fix.field === "prompt") {
    const promptable = PROMPT_EDITABLE_KINDS.has(kind) || (kind === "distributor" && agentBacked);
    if (!promptable)
      return { ok: false, error: `step '${fix.stepId}' (${kind}) has no editable prompt` };
    if (!fix.proposed.trim()) return { ok: false, error: "proposed prompt must not be empty" };
  } else if (fix.field === "cmd") {
    if (kind !== "command")
      return { ok: false, error: `step '${fix.stepId}' (${kind}) has no command to edit` };
    if (!fix.proposed.trim()) return { ok: false, error: "proposed cmd must not be empty" };
  } else {
    if (!agentBacked && kind !== "llm") {
      return { ok: false, error: `step '${fix.stepId}' (${kind}) has no model/effort to edit` };
    }
    if (fix.field === "model" && !fix.proposed.trim()) {
      return { ok: false, error: "proposed model must not be empty" };
    }
  }

  const patched = structuredClone(spec);
  for (const phase of patched.phases) {
    const step = phase.steps.find((s) => s.id === fix.stepId);
    if (!step) continue;
    const loose = step as WorkflowStep & Record<string, unknown>;
    if (fix.field === "effort") loose.effort = fix.proposed || undefined;
    else loose[fix.field] = fix.proposed;
  }
  const valid = validateWorkflow(patched);
  if (!valid.ok) return { ok: false, error: `patched spec fails validation: ${valid.error}` };

  if (fix.field === "prompt") {
    const before = new Set(lintTemplateRefs(spec));
    const fresh = lintTemplateRefs(patched).filter((w) => !before.has(w));
    if (fresh.length > 0) {
      return {
        ok: false,
        error: `patched spec introduces template lint issues: ${fresh.join("; ")}`,
      };
    }
  }
  return { ok: true };
}

/**
 * Run the postmortem: build the digest, make one structured-output LLM call
 * (with the engine's one-bounded fix retry), and validate any proposed spec
 * edit. Never throws.
 */
export async function diagnoseRun(request: PostmortemRequest): Promise<PostmortemResult> {
  const env = request.env ?? process.env;
  const resolved = resolvePostmortemApi(request.config, env, {
    api: request.api,
    model: request.model,
  });
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const specDrift =
    Boolean(request.spec) &&
    Boolean(request.record.specHash) &&
    hashWorkflowSpec(request.spec!) !== request.record.specHash;

  const digest = buildPostmortemDigest(request.record, { spec: request.spec, specDrift });
  const prompt = withStructuredOutputInstructions(
    `Diagnose this recorded steamtrain run.\n\n${digest}`,
    POSTMORTEM_OUTPUT_SCHEMA,
  );
  const base: LlmCallRequest = {
    provider: resolved.provider,
    model: resolved.model,
    prompt,
    system: SYSTEM_PROMPT,
    apiKey: resolved.apiKey,
    baseUrl: resolved.baseUrl,
    jsonOutput: true,
    maxTokens: 4096,
    timeoutMs: POSTMORTEM_TIMEOUT_MS,
    signal: request.signal,
  };

  const complete = request.llmComplete ?? callLlm;
  const outcome = await safeComplete(complete, base);
  if (!outcome.ok) return { ok: false, error: outcome.error };
  let tokens = outcome.tokens;
  let parsed = parseStructuredOutput(outcome.text, POSTMORTEM_OUTPUT_SCHEMA);
  if (!parsed.ok) {
    const retry = await safeComplete(complete, {
      ...base,
      prompt: structuredOutputFixPrompt(POSTMORTEM_OUTPUT_SCHEMA, outcome.text, parsed.error),
    });
    if (!retry.ok) return { ok: false, error: retry.error };
    tokens = addTokens(tokens, retry.tokens);
    parsed = parseStructuredOutput(retry.text, POSTMORTEM_OUTPUT_SCHEMA);
    if (!parsed.ok) {
      return { ok: false, error: `the model produced no valid diagnosis: ${parsed.error}` };
    }
  }

  const diagnosis = normalizeDiagnosis(
    parsed.value as Record<string, unknown>,
    knownStepIds(request.record, request.spec),
  );
  if (diagnosis.specFix) {
    diagnosis.specFix.validation = request.spec
      ? validatePostmortemSpecFix(request.spec, diagnosis.specFix)
      : {
          ok: false,
          error: "the workflow spec is not available, so the edit could not be validated",
        };
  }

  return {
    ok: true,
    diagnosis,
    api: resolved.api.id,
    model: resolved.model,
    tokens,
    specDrift,
  };
}

async function safeComplete(
  complete: LlmComplete,
  request: LlmCallRequest,
): Promise<{ ok: true; text: string; tokens?: TokenUsage } | { ok: false; error: string }> {
  try {
    const outcome = await complete(request);
    return outcome.ok
      ? { ok: true, text: outcome.text, tokens: outcome.tokens }
      : { ok: false, error: outcome.error };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function normalizeDiagnosis(
  raw: Record<string, unknown>,
  knownSteps: ReadonlySet<string>,
): PostmortemDiagnosis {
  const category = POSTMORTEM_CATEGORIES.includes(raw.category as PostmortemCategory)
    ? (raw.category as PostmortemCategory)
    : "unknown";
  const confidence = POSTMORTEM_CONFIDENCES.includes(raw.confidence as PostmortemConfidence)
    ? (raw.confidence as PostmortemConfidence)
    : "low";
  const diagnosis: PostmortemDiagnosis = {
    summary: String(raw.summary ?? ""),
    category,
    confidence,
  };
  const rootStepId = typeof raw.rootStepId === "string" ? raw.rootStepId : undefined;
  if (rootStepId && knownSteps.has(rootStepId)) diagnosis.rootStepId = rootStepId;
  if (typeof raw.evidence === "string" && raw.evidence.trim()) diagnosis.evidence = raw.evidence;
  if (typeof raw.suggestion === "string" && raw.suggestion.trim())
    diagnosis.suggestion = raw.suggestion;

  const fix = raw.specFix;
  if (fix && typeof fix === "object") {
    const f = fix as Record<string, unknown>;
    const stepId = typeof f.stepId === "string" ? f.stepId : "";
    const field = typeof f.field === "string" ? (f.field as PostmortemFixField) : undefined;
    const proposed = typeof f.proposed === "string" ? f.proposed : "";
    if (
      stepId &&
      proposed &&
      field &&
      (POSTMORTEM_FIX_FIELDS as readonly string[]).includes(field) &&
      knownSteps.has(stepId)
    ) {
      const specFix: PostmortemSpecFix = { stepId, field, proposed };
      if (typeof f.current === "string" && f.current.trim()) specFix.current = f.current;
      if (typeof f.rationale === "string" && f.rationale.trim()) specFix.rationale = f.rationale;
      diagnosis.specFix = specFix;
    }
  }
  return diagnosis;
}

/**
 * Step ids the model may legitimately reference: every step that ran (in the
 * record) plus every step in the current spec — a run cut short early may not
 * have reached a step the fix should still target.
 */
function knownStepIds(record: RunRecord, spec: WorkflowSpec | undefined): Set<string> {
  const ids = new Set<string>();
  for (const phase of record.phases) {
    for (const step of phase.steps) ids.add(step.stepId);
  }
  if (spec) {
    for (const phase of spec.phases) {
      for (const step of phase.steps) ids.add(step.id);
    }
  }
  return ids;
}

function addTokens(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    input: (a.input ?? 0) + (b.input ?? 0),
    output: (a.output ?? 0) + (b.output ?? 0),
    cacheRead: (a.cacheRead ?? 0) + (b.cacheRead ?? 0),
    cacheWrite: (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0),
    reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0),
  };
}

function capText(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n… [truncated ${text.length - cap} chars]`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function indent(text: string): string {
  return text.replace(/\n/g, "\n  ");
}
