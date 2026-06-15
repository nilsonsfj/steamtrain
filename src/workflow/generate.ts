import type { AgentAdapter } from "../agents";
import type { AgentEvent, AgentId } from "../types/events";
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

export interface GenerateWorkflowDeps {
  createAdapter: (id: AgentId, binary?: string) => AgentAdapter;
  binaries?: Partial<Record<AgentId, string>>;
  timeoutMs?: number;
  /** Working directory for the generating agent (it does not need repo access). */
  cwd?: string;
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
}

export interface GenerateWorkflowResult {
  ok: boolean;
  spec?: WorkflowSpec;
  /** Raw model text, kept for display/debugging when extraction fails. */
  raw: string;
  error?: string;
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
- The "steps" inside a phase run in PARALLEL.
- A step may only reference (via dependsOn / templates) steps in an EARLIER phase.
  Never reference a step in the same phase or a later phase.

# Step kinds
- "distributor": fan one input into many items. Use { "kind": "distributor",
  "items": ["...{{input}}...", "..."] }. Items are templates.
- "worker" (or "processor"): one agent run. Requires agent, model, prompt.
  A processor may add "forEach": "steps.<distributorId>.items" to run once per item
  (reference the current item with {{item}} and {{item.index}}).
- "consolidator": merge earlier outputs. Requires dependsOn; usually agent+model+prompt.
- "gate": evaluate a condition, e.g. { "kind": "gate", "dependsOn": ["x"],
  "condition": { "step": "x", "ok": true }, "onFalse": "fail" }.

# Templates available in prompts/items
{{input}} (the user's task), {{steps.<id>.output}}, {{steps.<id>.items}},
{{item}}, {{item.index}}.

# Agents & models
Prefer free models so the workflow runs without paid credentials:
agent "opencode" with models like "opencode/qwen3.6-plus-free",
"opencode/deepseek-v4-flash-free", "opencode/nemotron-3-ultra-free",
"opencode/mimo-v2.5-free", "opencode/minimax-m3-free".
Every agent-backed step MUST set agent, model, and a non-empty prompt.

# Output format (STRICT)
Output ONLY a single JSON object, no prose, no markdown fences. Shape:
{
  "description": "one sentence",
  "phases": [
    { "id": "scan", "title": "Scan", "steps": [
      { "id": "scan-a", "kind": "worker", "agent": "opencode",
        "model": "opencode/qwen3.6-plus-free", "prompt": "... {{input}} ..." }
    ] },
    { "id": "report", "title": "Report", "steps": [
      { "id": "report", "kind": "consolidator", "agent": "opencode",
        "model": "opencode/qwen3.6-plus-free", "dependsOn": ["scan-a"],
        "prompt": "Summarize {{steps.scan-a.output}} for {{input}}" }
    ] }
  ]
}

# User request
${description}

Respond with the JSON object only.`;
}

/**
 * Pull a workflow spec out of a model reply. Tries fenced ```json blocks first,
 * then a balanced top-level object, then validates with the engine's rules.
 * The `name` hint (or the parsed spec's own name, or the description) becomes a
 * slugified `name`.
 */
export function extractWorkflowSpec(
  text: string,
  opts: { name?: string; fallbackName?: string } = {},
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

  const nameSource =
    opts.name ?? shape.data.name ?? opts.fallbackName ?? shape.data.description ?? DEFAULT_NAME;
  const spec: WorkflowSpec = { ...shape.data, name: slugifyWorkflowName(nameSource) };

  const valid = validateWorkflow(spec);
  if (!valid.ok) {
    return { ok: false, error: `generated workflow is invalid: ${valid.error}`, json };
  }
  return { ok: true, spec };
}

/** Run the agent and turn its reply into a validated workflow spec. */
export async function generateWorkflow(
  req: GenerateWorkflowRequest,
  deps: GenerateWorkflowDeps,
): Promise<GenerateWorkflowResult> {
  const adapter = deps.createAdapter(req.agent, deps.binaries?.[req.agent]);
  const prompt = buildWorkflowGenerationPrompt(req.description);

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
      timeoutMs: deps.timeoutMs,
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

  const raw = finalText || streamedText;
  if (errored && !raw) {
    return { ok: false, raw: raw || "", error: errorMessage ?? "workflow generation failed" };
  }

  const extracted = extractWorkflowSpec(raw, { name: req.name, fallbackName: req.description });
  if (!extracted.ok) {
    const detail =
      errored && errorMessage ? `${errorMessage}; ${extracted.error}` : extracted.error;
    return { ok: false, raw, error: detail };
  }
  if (errored) {
    return { ok: false, raw, spec: extracted.spec, error: errorMessage };
  }
  return { ok: true, raw, spec: extracted.spec };
}

/**
 * Find the first balanced top-level JSON object in `text`. Honors fenced code
 * blocks and string/escape boundaries so braces inside strings don't confuse
 * the scan.
 */
function findJsonObject(text: string): string | undefined {
  const fenced = extractFenced(text);
  const haystack = fenced ?? text;
  const start = haystack.indexOf("{");
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
      if (depth === 0) return haystack.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Return the contents of the first ```json (or ```) fenced block, if any. */
function extractFenced(text: string): string | undefined {
  const fence = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(text);
  return fence?.[1];
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
