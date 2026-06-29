import { resolveAgentInstance } from "../agents";
import type { AgentAdapter } from "../agents";
import type { ResolvedAgentInstance } from "../agents/config";
import type { SteamtrainConfig } from "../config/types";
import type { AgentEvent, AgentId } from "../types/events";
import type { AgentProviderId } from "../types/events";
import { DEFAULT_STEP_TIMEOUT_SEC, timeoutMsFromSec } from "./timeout";
import { type WorkflowSpec, validateWorkflow, workflowSpecSchema } from "./types";

/**
 * LLM-delegated workflow creation. Given a natural-language description, we ask
 * an agent (Claude / OpenCode / Codex) to emit a {@link WorkflowSpec} as JSON,
 * extract that JSON robustly from the model's reply, and validate it with the
 * exact same rules the engine enforces at run time. The adapter is injected (as
 * in the engine) so this is unit-testable without spawning a real CLI.
 */

const DEFAULT_NAME = "workflow";
const MAX_NAME_LENGTH = 48;

/** Default number of corrective re-prompts after an invalid first draft. */
export const DEFAULT_REPAIR_ATTEMPTS = 2;

export interface GenerateWorkflowDeps {
  createAdapter: (id: AgentProviderId, binary?: string) => AgentAdapter;
  binaries?: Partial<Record<AgentProviderId, string>>;
  agentConfig?: SteamtrainConfig;
  stepTimeoutSec?: number;
  /** Working directory for the generating agent (it does not need repo access). */
  cwd?: string;
  /**
   * How many times to re-prompt the agent with the validation error when the
   * first draft is invalid (same-phase deps, bad shape, no JSON, …). 0 disables
   * repair. Defaults to {@link DEFAULT_REPAIR_ATTEMPTS}.
   */
  maxRepairAttempts?: number;
}

export interface GenerateWorkflowRequest {
  /** What the workflow should do, in the user's own words. */
  description: string;
  agent: AgentId;
  model: string;
  effort?: string;
  /** Desired name; slugified. When omitted, derived from the description. */
  name?: string;
  signal?: AbortSignal;
  /** Stream the underlying agent events so a UI can show live progress. */
  onEvent?: (event: AgentEvent) => void;
  /**
   * Called at the start of each agent run with the 1-based attempt number, so a
   * UI streaming `onEvent` can reset its live buffer between repair attempts
   * (otherwise a rejected draft and its repair concatenate into one blob).
   */
  onAttemptStart?: (attempt: number) => void;
}

export interface GenerateWorkflowResult {
  ok: boolean;
  spec?: WorkflowSpec;
  /** Raw model text, kept for display/debugging when extraction fails. */
  raw: string;
  error?: string;
  /** How many agent runs it took (1 = first draft was valid; >1 = repaired). */
  attempts: number;
}

export type ExtractResult =
  | { ok: true; spec: WorkflowSpec }
  | { ok: false; error: string; json?: string };

/** Turn arbitrary text into a safe, unique-ish kebab-case workflow name. */
export function slugifyWorkflowName(text: string): string {
  const slug = text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME_LENGTH)
    .replace(/-+$/g, "");
  return slug || DEFAULT_NAME;
}

/**
 * The meta-prompt. It teaches the spec format (the same fields the engine and
 * `workflowSpecSchema` understand) and a worked example, then demands JSON-only
 * output so {@link extractWorkflowSpec} has the best chance of success.
 */
export function buildWorkflowGenerationPrompt(description: string): string {
  return `You are a workflow author for "steamtrain", a terminal orchestrator that runs
coding agents as steps in a declarative pipeline. Convert the user's request into
ONE valid workflow as JSON.

# Execution model
- A workflow has "phases" that run SEQUENTIALLY (top to bottom).
- The "steps" inside a phase run in PARALLEL (with no ordering between them).
- A step may only reference (via dependsOn / forEach / gate condition / templates)
  steps in a STRICTLY EARLIER phase — never a step in the SAME phase, never a
  later phase.

# THE #1 RULE (most generated workflows fail here)
If step B uses step A's output, A and B MUST be in DIFFERENT phases, with A's
phase ABOVE B's phase. Two steps in the same phase run at the same time, so they
can NEVER depend on each other. When in doubt, give each dependent step its own
phase.

  WRONG (same phase — validation rejects this):
    phase "review": steps [ {id: "review-task", ...},
                            {id: "check-issues", dependsOn: ["review-task"], ...} ]

  RIGHT (split into two phases):
    phase "review":      steps [ {id: "review-task", ...} ]
    phase "check":       steps [ {id: "check-issues", dependsOn: ["review-task"], ...} ]

# Loops (bounded cycles) ARE supported — use a loop-back gate
For iterative work ("review then fix then re-review until clean"), use a gate
with a "loopTo" pointing to an EARLIER phase, plus an optional "maxIterations":
  { "kind": "gate", "dependsOn": ["review"], "condition": { "step": "review", "contains": "DONE" },
    "loopTo": "review", "maxIterations": 5, "onFalse": "continue" }
Semantics:
  - condition TRUE  → loop converged; continue forward.
  - condition FALSE and iterations remain → jump back to "loopTo" and re-run the body.
  - condition FALSE and the cap is hit → apply "onFalse" ("continue" proceeds after the
    cap; use "fail" only when non-convergence must fail the whole run).
Rules: the gate must be in a phase AFTER the phases it re-runs; "loopTo" names an
earlier phase; the loop body re-runs each pass; the current pass is available as
{{iteration}}. Keep maxIterations small (default cap is 10). Loops must be nested
or disjoint, never partially overlapping.

# Step kinds
- "distributor": fan work into multiple items for downstream forEach steps.
  - Agent-backed (PREFERRED for backlogs and unknown item counts): set agent, model,
    and prompt. The agent's final output is split on non-empty lines into items
    (one task per line; no numbering or bullets). Use this whenever the number of
    tasks is not known at authoring time.
  - Static (only when you know the exact branches upfront): set items:
    ["...{{input}}...", "..."] with templated strings. If items is present, it
    takes precedence — do not set agent/model/prompt.
  NEVER hardcode "Task 1", "Task 2", ... in items, and NEVER create separate
  worker/processor steps per index ("pick the 1st item", "pick the 2nd item").
  Use ONE processor with "forEach": "steps.<distributorId>.items" instead.
- "worker" (or "processor"): one agent run. Requires agent, model, prompt.
  A processor may add "forEach": "steps.<distributorId>.items" to run once per item
  IN PARALLEL (reference the current item with {{item}} and {{item.index}}). The
  forEach source distributor MUST be in an earlier phase.
  IMPORTANT forEach template rule: inside a forEach child, {{steps.<id>.output}} for
  a prior forEach parent is the FULL aggregate of ALL items (with --- headers), not
  the matching item. Do NOT chain multiple forEach steps expecting per-item upstream
  outputs. Combine per-item work into one forEach prompt, or fan out once then use a
  single consolidator/worker on the aggregate.
- "consolidator": merge earlier outputs. Requires dependsOn; usually agent+model+prompt.
- "gate": evaluate a condition, e.g. { "kind": "gate", "dependsOn": ["x"],
  "condition": { "step": "x", "ok": true }, "onFalse": "fail" }. condition.step
  must be in an earlier phase.

# Keep it small
A workflow may expand to at most 1000 steps; a forEach step counts as (number of
distributor items) steps. Agent-backed distributors scale to however many lines
the splitter emits; static item lists should stay short (a handful). Keep the
phase count modest.

# Templates available in prompts/items
{{input}} / {{args}} (the user's task), {{steps.<id>.output}}, {{steps.<id>.items}},
{{steps.<id>.ok}}, {{steps.<id>.error}}, {{steps.<id>.target}}, {{item}},
{{item.index}}, {{item.sourceStepId}}, {{iteration}}.

# Agents & models
Prefer free models so the workflow runs without paid credentials:
agent "opencode" with models like "opencode/mimo-v2.5-free",
"opencode/deepseek-v4-flash-free", "opencode/nemotron-3-ultra-free",
"opencode/north-mini-code-free".
Every agent-backed step MUST set agent, model, and a non-empty prompt.

# Worked example: parallel backlog implement, then consolidate
This is the canonical shape for "split a backlog into tasks, do them in parallel,
then merge results". The split phase uses an agent-backed distributor so the
task count is determined at runtime (not hardcoded). Each forEach child handles
one task in a single prompt (do not chain forEach steps expecting per-item upstream
outputs — see the forEach template rule above):
{
  "name": "split-implement-report",
  "description": "Split a backlog into tasks, implement each in parallel, then consolidate.",
  "phases": [
    { "id": "split", "title": "Split into tasks", "steps": [
      { "id": "tasks", "kind": "distributor", "agent": "opencode",
        "model": "opencode/mimo-v2.5-free",
        "prompt": "Read the backlog below and output each distinct task as its own line (no numbering, no bullets). One task per line only.\\n\\nBacklog:\\n{{input}}" }
    ] },
    { "id": "implement", "title": "Implement in parallel", "steps": [
      { "id": "impl", "kind": "processor", "agent": "opencode",
        "model": "opencode/mimo-v2.5-free", "dependsOn": ["tasks"],
        "forEach": "steps.tasks.items",
        "prompt": "Implement this backlog task fully. Review your work and fix any issues before finishing.\\n\\nTask:\\n{{item}}\\n\\nContext:\\n{{input}}" }
    ] },
    { "id": "report", "title": "Consolidate", "steps": [
      { "id": "report", "kind": "consolidator", "agent": "opencode",
        "model": "opencode/mimo-v2.5-free", "dependsOn": ["impl"],
        "prompt": "Summarize the final result across all tasks:\\n{{steps.impl.output}}" }
    ] }
  ]
}

# Worked example: a bounded review/fix loop
This is the canonical shape for "review then fix then re-review until clean".
The gate sits AFTER the body it re-runs, and "loopTo" names that earlier phase:
{
  "name": "bounded-review-loop",
  "description": "Implement, then review and fix in a bounded loop until clean.",
  "phases": [
    { "id": "implement", "title": "Implement", "steps": [
      { "id": "impl", "kind": "worker", "agent": "opencode",
        "model": "opencode/mimo-v2.5-free", "prompt": "Implement the task fully:\\n{{input}}" }
    ] },
    { "id": "review", "title": "Review", "steps": [
      { "id": "review", "kind": "worker", "agent": "opencode",
        "model": "opencode/mimo-v2.5-free", "dependsOn": ["impl"],
        "prompt": "Review the implementation (pass {{iteration}}). If there are NO remaining issues, reply with the single word DONE. Otherwise list the issues.\\n{{steps.impl.output}}" }
    ] },
    { "id": "fix", "title": "Fix", "steps": [
      { "id": "fix", "kind": "worker", "agent": "opencode",
        "model": "opencode/mimo-v2.5-free", "dependsOn": ["review"],
        "prompt": "Apply fixes for these review findings:\\n{{steps.review.output}}" }
    ] },
    { "id": "gate", "title": "Converged?", "steps": [
      { "id": "loop-gate", "kind": "gate", "dependsOn": ["review"],
        "condition": { "step": "review", "contains": "DONE" },
        "loopTo": "review", "maxIterations": 5, "onFalse": "continue" }
    ] }
  ]
}
Note the gate's condition inspects "review" (not "fix") so the loop re-checks the
review verdict each pass; "loopTo": "review" re-runs review then fix on each cycle.

# Output format (STRICT)
Output ONLY a single JSON object, no prose, no markdown fences. Use the shape and
field names shown above ("name", "description", "phases", each phase with "id"/"title"/"steps").

- "name": a short, descriptive kebab-case name for the workflow (e.g. "deploy-app", "code-review"). If the user explicitly asks for a name in their prompt (e.g. "named test-deploy" or "called foo"), use that exact name (slugified).

# Before you answer — self-check
For EVERY dependsOn, forEach source, and gate condition.step you wrote, confirm
the referenced step lives in a phase that appears ABOVE the current step's phase.
If any reference is in the same phase or below, MOVE the dependent step into a
later phase until it is valid.
For any gate with "loopTo", confirm it points to an EARLIER phase and that the
gate sits in a phase BELOW the body it re-runs. Then output the JSON.

# User request
${description}

Respond with the JSON object only.`;
}

/** Truncate raw model output so a repair prompt stays a sane size. */
const MAX_REPAIR_OUTPUT_CHARS = 4000;

/**
 * The repair prompt. When a draft fails to parse or validate, we show the model
 * its own previous output and the EXACT validation error (the same message the
 * engine produced) and ask for a corrected JSON object. This is the safety net
 * behind {@link buildWorkflowGenerationPrompt}: even a weak model usually fixes a
 * concrete, named error ("step X dependsOn Y, which is not in an earlier phase").
 */
export function buildWorkflowRepairPrompt(
  description: string,
  previousOutput: string,
  error: string,
): string {
  const trimmed =
    previousOutput.length > MAX_REPAIR_OUTPUT_CHARS
      ? `${previousOutput.slice(0, MAX_REPAIR_OUTPUT_CHARS)}\n…(truncated)`
      : previousOutput;
  return `${buildWorkflowGenerationPrompt(description)}

# Your previous attempt was INVALID
You already tried, and it was rejected with this error:

${error}

Your previous output was:
${trimmed}

Fix ONLY what the error calls out, keeping the rest of the intent. The most
common cause is two dependent steps sharing a phase — if so, move the dependent
step into a later phase. Re-read the self-check above, then output the corrected
JSON object only (no prose, no fences).`;
}

/**
 * Pull a workflow spec out of a model reply. Tries fenced ```json blocks first,
 * then a balanced top-level object, then validates with the engine's rules.
 * The `name` hint (or the parsed spec's own name, or the description) becomes a
 * slugified `name`.
 */
export function extractWorkflowSpec(
  text: string,
  opts: { name?: string; fallbackName?: string; onWarn?: (msg: string) => void } = {},
): ExtractResult {
  const json = findJsonObject(text);
  if (!json) return { ok: false, error: "no JSON object found in the model output" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return { ok: false, error: `model output was not valid JSON: ${message(err)}`, json };
  }

  const shape = workflowSpecSchema.safeParse(parsed);
  if (!shape.success) {
    return {
      ok: false,
      error: `generated workflow is not a valid spec: ${shape.error.issues[0]?.message ?? "schema error"}`,
      json,
    };
  }

  if (opts.name && shape.data.name && opts.name !== shape.data.name) {
    opts.onWarn?.(
      `[extractWorkflowSpec] User-provided name hint '${opts.name}' overrides LLM-generated name '${shape.data.name}'`,
    );
  }

  const nameSource =
    opts.name ?? shape.data.name ?? opts.fallbackName ?? shape.data.description ?? DEFAULT_NAME;
  const spec: WorkflowSpec = { ...shape.data, name: slugifyWorkflowName(nameSource) };

  const valid = validateWorkflow(spec);
  if (!valid.ok) {
    return { ok: false, error: `generated workflow is invalid: ${valid.error}`, json };
  }
  return { ok: true, spec };
}

interface AgentRunOutcome {
  raw: string;
  errored: boolean;
  errorMessage?: string;
}

/** One agent run: stream events through `onEvent`, collect the reply text. */
async function runGenerationAgent(
  adapter: AgentAdapter,
  prompt: string,
  req: GenerateWorkflowRequest,
  deps: GenerateWorkflowDeps,
  instance: ResolvedAgentInstance,
): Promise<AgentRunOutcome> {
  let finalText = "";
  let streamedText = "";
  let errored = false;
  let errorMessage: string | undefined;

  try {
    for await (const event of adapter.run({
      prompt,
      model: req.model,
      effort: req.effort,
      cwd: deps.cwd,
      env: instance.env,
      extraArgs: instance.extraArgs,
      timeoutMs: timeoutMsFromSec(deps.stepTimeoutSec ?? DEFAULT_STEP_TIMEOUT_SEC),
      signal: req.signal,
    })) {
      req.onEvent?.(event);
      if (event.kind === "text_delta") {
        if (!event.thinking) streamedText += event.text;
      } else if (event.kind === "result") {
        if (event.text) finalText = event.text;
        if (event.isError) {
          errored = true;
          errorMessage ??= event.text;
        }
      } else if (event.kind === "error") {
        errored = true;
        errorMessage ??= event.message;
      }
    }
  } catch (err) {
    errored = true;
    errorMessage ??= message(err);
  }

  return { raw: finalText || streamedText, errored, errorMessage };
}

/**
 * Run the agent and turn its reply into a validated workflow spec. When the
 * first draft is invalid, re-prompt the agent with the exact validation error up
 * to `maxRepairAttempts` times (see {@link buildWorkflowRepairPrompt}) before
 * giving up. `result.attempts` reports how many runs it took.
 */
export async function generateWorkflow(
  req: GenerateWorkflowRequest,
  deps: GenerateWorkflowDeps,
): Promise<GenerateWorkflowResult> {
  const instance = resolveAgentInstance(deps.agentConfig, req.agent);
  if (!instance) {
    return {
      ok: false,
      error: `agent '${req.agent}' is disabled or not configured`,
      raw: "",
      attempts: 0,
    };
  }
  const adapter = deps.createAdapter(instance.provider, instance.binary);
  const maxRepairAttempts = Number.isFinite(deps.maxRepairAttempts)
    ? Math.max(0, Math.floor(deps.maxRepairAttempts as number))
    : DEFAULT_REPAIR_ATTEMPTS;

  let prompt = buildWorkflowGenerationPrompt(req.description);
  let lastResult: GenerateWorkflowResult = { ok: false, raw: "", attempts: 0 };

  for (let attempt = 1; attempt <= maxRepairAttempts + 1; attempt++) {
    // Don't start a fresh agent run once the caller has aborted.
    if (req.signal?.aborted) break;
    req.onAttemptStart?.(attempt);
    const { raw, errored, errorMessage } = await runGenerationAgent(
      adapter,
      prompt,
      req,
      deps,
      instance,
    );

    // An agent error with no output at all: repairing has nothing to work from.
    if (errored && !raw) {
      return {
        ok: false,
        raw: "",
        error: errorMessage ?? "workflow generation failed",
        attempts: attempt,
      };
    }

    const extracted = extractWorkflowSpec(raw, { name: req.name, fallbackName: req.description });
    if (extracted.ok) {
      // The agent flagged an error yet still produced a usable spec: surface the
      // error (legacy behavior) rather than silently accepting it.
      return errored
        ? { ok: false, raw, spec: extracted.spec, error: errorMessage, attempts: attempt }
        : { ok: true, raw, spec: extracted.spec, attempts: attempt };
    }

    const detail =
      errored && errorMessage ? `${errorMessage}; ${extracted.error}` : extracted.error;
    lastResult = { ok: false, raw, error: detail, attempts: attempt };

    // Re-prompt with the concrete error if we have budget and something to fix.
    if (attempt <= maxRepairAttempts && !req.signal?.aborted) {
      prompt = buildWorkflowRepairPrompt(req.description, raw, extracted.error);
    } else {
      break;
    }
  }

  return lastResult;
}

/**
 * Find the first balanced top-level JSON object in `text`. Honors fenced code
 * blocks and string/escape boundaries so braces inside strings don't confuse
 * the scan.
 */
function findJsonObject(text: string): string | undefined {
  const fenced = extractFenced(text);
  const haystack = fenced ?? text;

  let searchFrom = 0;
  while (searchFrom < haystack.length) {
    const start = haystack.indexOf("{", searchFrom);
    if (start === -1) return undefined;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < haystack.length; i++) {
      const ch = haystack[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          return haystack.slice(start, i + 1);
        }
      }
    }
    // If we get here, the brace wasn't balanced — try the next `{`.
    searchFrom = start + 1;
  }
  return undefined;
}

/** Return the contents of the first ```json (or ```) fenced block, if any. */
function extractFenced(text: string): string | undefined {
  // Prefer ```json blocks first
  const jsonFence = /```json[ \t]*\r?\n?([\s\S]*?)```/i.exec(text);
  if (jsonFence?.[1]) return jsonFence[1];
  // Fall back to bare ``` blocks
  const bareFence = /```[ \t]*\r?\n?([\s\S]*?)```/i.exec(text);
  return bareFence?.[1];
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
