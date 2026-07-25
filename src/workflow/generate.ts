import { resolveAgentInstance } from "../agents";
import type { AgentAdapter } from "../agents";
import type { ResolvedAgentInstance } from "../agents/config";
import type { SteamtrainConfig } from "../config/types";
import type { AgentEvent, AgentInstanceId } from "../types/events";
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
  agent: AgentInstanceId;
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
  | { ok: true; spec: WorkflowSpec; warnings?: string[] }
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
- A workflow has "phases" ordered top to bottom.
- Steps are scheduled by their dependencies: a step runs as soon as every step
  it references has finished. A step WITHOUT "dependsOn" waits for ALL steps in
  all earlier phases, so phases act as barriers for it. Steps that could depend
  on each other must therefore be ordered by phase.
- A step may only reference (via dependsOn / forEach / gate condition / when /
  templates) steps in a STRICTLY EARLIER phase — never a step in the SAME
  phase, never a later phase.

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
- "command": run a deterministic shell command — NO agent, NO cost. Requires "cmd"
  (a templated shell line, e.g. "npm test" or "grep -rn TODO src"). Optional cwd,
  env, stepTimeoutSec. Output is the command's stdout+stderr; ok is true exactly
  when it exits 0, and {{steps.<id>.exitCode}} is available to templates. Use a
  command step (NOT an agent) whenever the work is "run the tests / linter /
  build / a script" — it is faster, free, and cannot misreport results. Gate on
  it with { "step": "<id>", "ok": true }. Command steps run in the same isolated
  git worktree machinery as agent steps.
- "llm": ONE direct, stateless LLM API call — no agent CLI, no tools, no repo
  access, near-zero startup. Requires "model" and "prompt"; optional "provider"
  ("anthropic" or "openai"; inferred from the model name when omitted — claude-*
  means anthropic), "system", "output" (JSON schema), "maxTokens", "effort",
  "apiKeyEnv", "baseUrl" (any OpenAI-compatible endpoint). The API key is read
  from the environment (ANTHROPIC_API_KEY / OPENAI_API_KEY by default). Or set
  "api" to a built-in/configured instance — "anthropic", "openai", "openrouter",
  or "opencode-zen" (keyless free models) — to inherit its endpoint, key env,
  and default model. Use an
  llm step instead of an agent-backed consolidator/worker whenever the work is
  "turn one prompt into one completion" with no tool use: judging/classifying a
  verdict for a gate, summarizing or merging earlier text outputs, splitting a
  request into a list. It is dramatically faster and cheaper than booting an
  agent. An llm step with an "output" schema whose value (or "itemsPath" field)
  is a JSON array exposes it as items, so it can be a forEach source like a
  distributor; an llm step may itself carry "forEach" to judge each item.
  Do NOT use an llm step when the step must read/edit files or run commands —
  that needs a worker/processor or command step.
- "merge": land the FILE CHANGES of earlier agent steps (each runs in an isolated
  git worktree) back into the user's repository. Requires dependsOn (or "from":
  ["stepId", ...]). "mode": "apply" (default; changes land uncommitted in the
  user's checkout), "branch" (left on a local branch), "pr" (pushed + a GitHub
  PR is opened; "perSource": true opens one PR per parallel source), or
  "worktree" (merges into a KEPT staging worktree instead of delivering
  anywhere — nothing lands in the user's checkout. Use this for STAGED
  INTEGRATION: merge N parallel streams, then keep working on the combined
  result — e.g. one more review/fix/test loop on the WHOLE merge before a
  real delivery. A later step reaches the merged worktree with "workspace":
  "attach:<mergeStepId>" or "inherit:<mergeStepId>"; a LATER merge step may
  list this one — or anything attached to it — in "from" to harvest it, same
  as any agent step's worktree. "perSource" is invalid with this mode.).
  "onConflict":
  "fail" (default), "ours", "theirs", or "agent" (requires agent+model; the agent
  resolves conflict markers). "cleanup": true discards the source worktrees after
  a successful delivery (the delivered result is the durable copy; only use it on
  a FINAL merge step no later step references). Add a final merge step to any
  workflow whose agents EDIT files (implement/fix/refactor) — without one the
  edits stay stranded in worktrees. Review-only workflows don't need it.
  IMPORTANT — landing an EXISTING GitHub PR is NOT the merge step. The merge
  step only OPENS a PR (mode "pr"); it never runs \`gh pr merge\` or deletes a
  remote head branch. When a workflow babysits / lands open PRs:
  1. Let the agent prepare (rebase, address comments, push) but FORBID merge
     and remote branch deletion in the prompt.
  2. Land with a command step calling
     \`steamtrain workflow pr merge-when-ready <pr>\` (or \`wait-checks\` then
     merge). That waits for EVERY statusCheckRollup entry — including
     non-required external review bots — and only then merges + deletes the
     branch. GitHub's "mergeable" flag alone is NOT enough; merging while a
     remote review is still queued makes it fail with
     "couldn't find remote ref". Prefer the bundled \`babysit-pr\` /
     \`babysit-all-prs\` pattern over letting an agent run \`gh pr merge\` itself.
- "workflow": invoke another named workflow as a child run. Requires "workflow"
  (the catalog name); optional "input" becomes the child's {{input}} and
  "outputStep" selects which child step's output becomes this step's output.
  This step does not use an agent or own a worktree - the child workflow's steps
  handle that internally. Use it to compose a reusable workflow as one stage of
  a larger pipeline. The child workflow is resolved at run time, and cycles or
  reaching five nested workflow levels fails clearly.
  For a PARALLEL SUB-PIPELINE FAN-OUT (e.g. "plan independent streams, run a
  whole implement→review→fix pipeline per stream in parallel"), add:
  "forEach": "steps.<distributorId>.items" (one whole child RUN per item, in
  parallel, exactly like worker forEach — {{item}} is available in "input" and
  "params"); "params": { "key": "{{...}}" } (templated values passed as the
  child's own declared "inputs", validated the same way --param is); and
  "worktreeStep": "<childStepId>" (the named child step's worktree surfaces as
  THIS step's own worktree — required if a later "merge" or "workspace: attach/
  inherit" step needs to reach into what the sub-workflow produced; under
  forEach this gives the fan-out parent one surfaced worktree per item, so a
  merge step's "from" naming the fan-out step harvests every stream).
- "approval": human-in-the-loop CONSENT checkpoint. The run pauses, shows the
  reviewed step's output/diff, and waits for a human to approve or reject.
  Optional "step" (the reviewed step; defaults to a sole dependsOn), "prompt"
  (instructions for the reviewer), "onReject" ("fail" default, or "stop").
  Use it before consequential actions (merging edits, opening a PR).
- "human": human-in-the-loop DATA step — its output is typed by a person, not
  an agent. Requires "prompt" (the question/instructions, templated; it may
  interpolate earlier outputs). Optional "choices": ["a", "b", ...] renders as
  pick-one; optional "output" JSON schema demands a validated JSON reply
  (choices and output are mutually exclusive). Downstream steps consume
  {{steps.<id>.output}} like any other step. Use it when the pipeline needs
  information only a person has (pick a design, paste an incident timeline).
  IMPORTANT: only add approval/human steps when the request explicitly wants a
  human in the loop — they make the workflow non-autonomous (it parks until a
  person responds), which is surfaced as an autonomy label in every UI.
- "issues": document out-of-scope findings — as a report or as GitHub issues.
  Requires nothing (defaults "from" to dependsOn); usually set "from": [ids...]
  (steps to collect findings from), "findingsPath" (JSON path into each
  source's "json" where the findings array lives; default "findings"), "mode"
  ("report" default — zero side effects, safe; or "github" — creates issues via
  the gh CLI, checking for and skipping duplicates by title), "titlePrefix",
  "labels" (only set these if the target repo is known to already have them —
  gh fails on an unknown label), "limit" (max issues created, github mode,
  default 20). "mode" is a template, so it can switch via {{inputs.<key>}}.
  For findings to exist, some earlier agent-backed step must declare an
  "output" schema with a findings array — e.g.
  { "type": "array", "items": { "type": "object", "required": ["title"],
  "properties": { "title": {"type":"string"}, "body": {"type":"string"},
  "severity": {"type":"string","enum":["low","medium","high"]},
  "file": {"type":"string"} } } } — and its prompt must instruct the agent to
  report OUT-OF-SCOPE problems there instead of fixing them. No agent, no
  worktree, no cost; never a "workspace" source.
A worker/processor may set "canAsk": true to let the agent ask ONE clarifying
question mid-step (answered by a human through the same channel) instead of
guessing. Reserve it for steps whose input is likely ambiguous; it also makes
the workflow non-autonomous.

# File handoff between steps ("workspace" and "artifacts")
Each worker/processor/command step runs in its OWN isolated worktree snapshotted
from the user's checkout — by default a later step does NOT see an earlier step's
file edits, only its text output. When a step must build on another step's edits
(implement → review the diff, implement → run the tests, iterative fix loops),
give it "workspace": "inherit:<stepId>" — its worktree then starts from that
step's final files. The source must be a single worker/processor/command step in
an earlier phase (not a forEach fan-out; merge those first). Chains compose:
review inherits implement, test inherits review. Merging an inherited worktree
lands the whole chain's changes, so point the final merge step at the LAST step
of a chain, not every link.
For a REVIEW/FIX LOOP specifically, prefer "workspace": "attach:<stepId>" over
"inherit:<stepId>". "inherit" COPIES the source's worktree into a fresh one —
inside a "loopTo" loop this means each pass forks a copy of the source's
ORIGINAL state, so iteration 2's review would never see iteration 1's fix and
the loop can never observably converge. "attach" instead runs INSIDE the
source's own worktree (no copy) — every step attached to the same source, plus
the source itself, share ONE worktree, so a review→fix→review loop actually
sees each pass's edits. Rule of thumb: use "attach" for a review/fix/test loop
that must converge on real state; use "inherit" when forked, independent
copies are the point (e.g. speculative parallel branches). "attach" sources are
the same worker/processor/command step as "inherit", PLUS a "merge" step with
"mode": "worktree", PLUS a "workflow" step with "worktreeStep" and no forEach.
Every step attaching to the same source must form a strict dependsOn chain (no
two attachers may run concurrently in one worktree) — this is exactly the
natural order of a review→fix→test loop, so it falls out for free.
A worker/processor/command step may also declare "artifacts": ["report.md",
"coverage/"] — paths (relative to its cwd) it promises to produce. They are
snapshotted after the step succeeds (a missing one FAILS the step) and later
prompts can pass the snapshot path along as {{steps.<id>.artifacts.<name>}}
(name = filename minus extension: report.md → report). On a forEach step,
artifacts are snapshotted per child ({{steps.<id>[0].artifacts.<name>}}), not
on the aggregate parent. Use artifacts when a
step's real product is a file a later step should read, rather than pasting
huge content through text outputs.

# Tool permissions ("permissions")
Any agent-backed step may declare "permissions": "read-only" | "edit" | "full"
(or the object form { "profile": …, "allow": [...], "deny": [...] }). This is
what stops an analysis step from being able to rewrite the repo:
  - "read-only" — reads, searches, judges; cannot write files, run shell
    commands, or reach the network. steamtrain also VERIFIES this after the
    step: if its workspace changed at all, the step fails. Use it on every
    review / critique / scan / judge / plan step. Do NOT combine it with
    "artifacts" (a read-only step cannot produce files) and never put it on a
    merge step.
  - "edit" — reads and edits files in its own workspace; no network. Enforceable
    on claude and codex only.
  - "full" — explicitly unrestricted; use it for implement/fix steps.
A workflow may also set "permissions" once at the TOP LEVEL as the default for
every agent step, with individual steps overriding it — the clearest way to
express "only the implement step writes". Prefer declaring profiles: a workflow
whose reviewers are provably read-only is one a user will run on a real
repository. Note that only claude, codex, opencode and mimo can enforce
"read-only" natively; a restricted step pinned to another agent is refused
before it starts.

# Session continuity ("session")
A worker/processor may set "session": "continue:<stepId>" to CONTINUE that
earlier step's agent conversation instead of starting a clean-room one — the
agent keeps everything the source session established (files read, decisions
made). Natural fits: a plan step followed by an implement step that inherits
the planning conversation, and a loop fixer continuing ITSELF
("session": "continue:<ownId>") so each iteration resumes the previous pass
instead of re-reading the repo. The source must be an agent-backed step on the
SAME agent in an earlier phase; neither side may use forEach; each source may
be continued by at most ONE step (chain continuations linearly);
self-continuation requires the step to be inside a loop region. The step fails when the agent's
CLI cannot resume sessions (claude/opencode/codex/cursor/antigravity can). Session continuity
shares CONVERSATION state, not files — pair it with "workspace" inheritance
when the step must also see the source's edits. Default to fresh sessions for
independent critique; use continuation only when inheriting context is the
point.

# Routing on a workflow input directly (gate/when "value")
A gate condition (and per-step "when") may test a TEMPLATE EXPRESSION instead
of a step's output: { "value": "{{inputs.deliver}}", "equals": "pr" }. This is
the way to route purely on an input parameter, with no step involved — e.g.
gate an optional final phase behind a flag, or skip a step based on which mode
the user picked: { "when": { "value": "{{inputs.issueTiming}}", "equals":
"live" }, ... }. "value" is mutually exclusive with "step"/"ok"/"path"/"human".

# Per-step conditions ("when")
Any step may carry a "when" condition (same shape as a gate condition), e.g.
  { "id": "fix-frontend", "when": { "step": "triage", "contains": "frontend" }, ... }
When it evaluates FALSE the step is SKIPPED (recorded ok, empty output), not
failed — use this to run a branch only when relevant. Skips cascade: a step
whose dependsOn was skipped is skipped too, except consolidators, which treat
skipped inputs as absent and merge the rest. Prefer "when" over a gate with
"onFalse": "stop"/"fail" whenever you only want to skip a branch rather than
halt the whole run. when.step must be in an earlier phase.

# Structured outputs (typed gates and fan-out)
Any agent-backed step may set "output" to a JSON schema (subset: type, properties,
required, enum, items, const, additionalProperties). The engine instructs the agent
to end its reply with matching JSON, validates it (with one bounded fix retry), and
exposes the parsed value as {{steps.<id>.json}} / {{steps.<id>.json.<path>}}.
Prefer a schema + field condition over substring matching whenever a gate or loop
routes on a verdict/score/list — prose like "no P0 issues" can false-match a
contains check:
  { "id": "review", ..., "output": { "type": "object", "required": ["verdict"],
    "properties": { "verdict": { "type": "string", "enum": ["pass", "fail"] } } } }
  { "kind": "gate", "dependsOn": ["review"],
    "condition": { "step": "review", "path": "verdict", "equals": "pass" }, ... }
A distributor with an "output" schema fans out over a JSON array instead of
splitting lines; set "itemsPath" (e.g. "targets") when the array is a field of the
object rather than the whole value.

# Keep it small
A workflow may expand to at most 1000 steps; a forEach step counts as (number of
distributor items) steps. Agent-backed distributors scale to however many lines
the splitter emits; static item lists should stay short (a handful). Keep the
phase count modest.

# Workflow inputs (parameters)
A workflow may declare named inputs in an "inputs" map. Each key becomes a
{{inputs.<key>}} template variable. Users supply values via --param key=value
(or the TUI / web Variables form).

Input types:
- "string" (default), "number", "boolean" — classic typed params
- "model" — agent model id or friendly alias; UIs offer catalog autocomplete.
  Optional "fallbackModels": ["other-model", …] declares a quota / rate-limit
  safety net. Any step with "model": "{{inputs.<key>}}" inherits those
  fallbacks automatically so a depleted primary does not ruin the run.
- "agent" — configured agent instance id; UIs offer the agent picker.
- "enum" — one of "choices" (required for this type). Optional "choices" also
  constrains string/model/agent params.

Set "default" to make an input optional; without it the user must provide a
value. Use inputs to make workflows reusable — e.g. a "repo" input instead of
hardcoding a repo name in every prompt.

Example:
  "inputs": {
    "repo": { "type": "string", "description": "target repository" },
    "maxIterations": { "type": "number", "default": 3 },
    "coderModel": {
      "type": "model",
      "default": "opencode/mimo-v2.5-free",
      "fallbackModels": ["mimo/mimo-auto", "opencode/north-mini-code-free"]
    },
    "issueTiming": { "type": "enum", "choices": ["live", "end"], "default": "end" }
  }
Then reference in prompts: "Analyze {{inputs.repo}} with up to {{inputs.maxIterations}} passes"
And pin a step model: "model": "{{inputs.coderModel}}"

# Templates available in prompts/items
{{input}} / {{args}} (the user's task), {{inputs.<key>}} (declared workflow input
parameters — define them in the spec's "inputs" map and users pass --param key=value),
{{steps.<id>.output}}, {{steps.<id>.items}},
{{steps.<id>.ok}}, {{steps.<id>.error}}, {{steps.<id>.target}},
{{steps.<id>.exitCode}} (a command step's exit code),
{{steps.<id>.json}} / {{steps.<id>.json.<path>}} (structured output fields),
{{steps.<id>.artifacts.<name>}} (the snapshot path of a declared artifact),
{{steps.<id>.worktree.root}} / {{steps.<id>.worktree.branch}} (an agent step's
isolated git worktree, for custom integration steps — also valid on a "mode":
"worktree" merge step and a "workflow" step with "worktreeStep"), {{item}},
{{item.index}}, {{item.sourceStepId}}, {{iteration}}.

IMPORTANT: validate that every {{steps.<id>...}} reference uses a step id that
exists in the workflow, every {{inputs.<key>}} references a declared input, and
{{item}} only appears inside forEach children. Typos in template references
silently render as empty text at runtime and will produce validation warnings.

# Agents & models
Prefer free models so the workflow runs without paid credentials.
Prefer first-class agent "mimo" with model "mimo/mimo-auto" for tool-heavy
steps (OpenCode Zen's "opencode/deepseek-v4-flash-free" hangs on multi-turn
tool loops). Other free options: agent "opencode" with
"opencode/mimo-v2.5-free", "opencode/nemotron-3-ultra-free",
"opencode/north-mini-code-free".
Model-only bindings are allowed (omit agent) when "model" is a concrete id or
"{{inputs.<modelKey>}}" — the engine picks the matching agent family.
Every agent-backed step MUST set model (or modelClass) and a non-empty prompt.
"model" and "effort" are TEMPLATES, rendered at run time — this is how ONE
spec serves several cost/quality tiers via declared "inputs" instead of
forking the workflow: "model": "{{inputs.coderModel}}" with an "inputs" entry
declaring a sensible free-model default. Prefer model-only bindings for
model-typed inputs (omit "agent" and let the engine pick the family). When
you do set "agent", keep it a plain static string — never templated. A
"model" that renders empty FAILS the step; an "effort" that renders empty is
fine (it just omits the flag) — so give a "reviewerEffort"-style input a
default of "" when you're not sure the chosen agent/model supports
effort/variant.

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
        "workspace": "attach:impl",
        "prompt": "Review the implementation (pass {{iteration}}). If there are NO remaining issues, reply with the single word DONE. Otherwise list the issues.\\n{{steps.impl.output}}" }
    ] },
    { "id": "fix", "title": "Fix", "steps": [
      { "id": "fix", "kind": "worker", "agent": "opencode",
        "model": "opencode/mimo-v2.5-free", "dependsOn": ["review"],
        "workspace": "attach:impl",
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

# Worked example: compose a sub-workflow
This is the canonical shape for "run an existing workflow as one stage of a
larger pipeline". The child workflow is resolved by name from the workflow
catalog, and its internal steps appear in the run history under the
<stepId>::<childStepId> namespace:
{
  "name": "release-checks",
  "description": "Run a reusable bug sweep before the release gate.",
  "phases": [
    { "id": "checks", "title": "Checks", "steps": [
      { "id": "bug-sweep", "kind": "workflow", "workflow": "bug-hunt",
        "input": "{{input}} - pre-release sweep" }
    ] },
    { "id": "gate", "title": "Gate", "steps": [
      { "id": "clean", "kind": "gate", "dependsOn": ["bug-sweep"],
        "condition": { "step": "bug-sweep", "ok": true }, "onFalse": "fail" }
    ] }
  ]
}

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
  return { ok: true, spec, warnings: valid.warnings };
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
      agentId: instance.id,
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

/** Resolve the drafting instance, honoring legacy `binaries`-only deps when `agentConfig` is omitted. */
function resolveGenerationInstance(
  deps: GenerateWorkflowDeps,
  agent: AgentInstanceId,
): ResolvedAgentInstance | undefined {
  const config =
    deps.agentConfig ??
    (deps.binaries ? ({ binaries: deps.binaries } satisfies SteamtrainConfig) : undefined);
  return resolveAgentInstance(config, agent);
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
  const instance = resolveGenerationInstance(deps, req.agent);
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
