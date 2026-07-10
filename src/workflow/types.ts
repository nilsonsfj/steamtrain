import { z } from "zod";
import type { AgentInstanceId, ApiInstanceId, TokenUsage } from "../types/events";
import type { RetryPolicy } from "./retry";
import type { JsonSchema } from "./structured";
// Circular import is safe: template.ts imports types from this module, and this
// module imports lintTemplateRefs from template.ts. Both modules are fully
// initialized before any cross-referenced function is called at runtime.
import { lintTemplateRefs } from "./template";

/**
 * The declarative workflow model. A `WorkflowSpec` is a sequence of phases.
 * Steps are scheduled by their dependencies: a step runs as soon as its
 * `dependsOn` steps (plus any steps its templates/conditions reference) have
 * finished, bounded by `maxConcurrency`. A step that omits `dependsOn`
 * implicitly depends on every step in all earlier phases, so phases act as
 * barriers for it — which is exactly the pre-DAG behavior. Workflows that
 * contain loop-back gates (`loopTo`) run phase-by-phase, since a loop re-runs
 * a contiguous range of phases. Steps are explicit workflow building blocks:
 * distributors fan one input into many items, workers/processors do 1:1 work,
 * consolidators fan results back in, gates route/filter based on conditions,
 * command steps run deterministic shell commands, and merge steps land
 * worktree changes back in the repository.
 *
 * Existing specs without a `kind` field remain valid; those steps are treated as
 * `worker` blocks.
 */

export type WorkflowStepKind =
  | "worker"
  | "processor"
  | "distributor"
  | "consolidator"
  | "gate"
  | "approval"
  | "merge"
  | "command"
  | "llm"
  | "workflow";

export interface WorkflowStepBase {
  /** Unique across the whole workflow; referenced by `dependsOn` and templates. */
  id: string;
  /** Step ids (in earlier phases) whose outputs this step references. */
  dependsOn?: string[];
  /**
   * Per-step condition (same schema as a gate condition). Evaluated right
   * before the step would run; when false the step is *skipped* — recorded as
   * ok with `skipped: true` and empty output, never failed. Steps whose
   * `dependsOn` were all consumed by skips cascade: a non-consolidator step is
   * skipped when ANY explicit dependency was skipped; a consolidator treats
   * skipped inputs as absent and is skipped only when ALL of them were.
   */
  when?: GateCondition;
}

export interface WorkflowItem {
  /** The distributor step that produced this item. */
  sourceStepId: string;
  /** Zero-based position within the distributor output. */
  index: number;
  /** Item payload supplied to one generated worker/processor run. */
  value: string;
}

export interface AgentRunFields {
  agent: AgentInstanceId;
  /** Model string in the agent's own format (claude: `claude-…`, opencode: `provider/model`, codex: plain slug). */
  model: string;
  /** Prompt template; may reference `{{input}}` and `{{steps.<id>.output}}`. */
  prompt: string;
  /** Target working directory (absolute, or relative to the run's base cwd). */
  cwd?: string;
  /** Extra env vars merged over `process.env` for this step only. */
  env?: Record<string, string>;
  /** Extra CLI flags appended to the agent's own args (advanced targets). */
  extraArgs?: string[];
  /** Reasoning effort / variant (claude: `--effort`, opencode: `--variant`, codex: `-c model_reasoning_effort=…`). */
  effort?: string;
  /** Per-step subprocess wall-clock limit in seconds (overrides workflow and config defaults). */
  stepTimeoutSec?: number;
  /** @deprecated Use `stepTimeoutSec`. Milliseconds in JSON are converted at resolve time. */
  stepTimeoutMs?: number;
  /**
   * Optional JSON schema (subset; see `structured.ts`) the agent's final
   * output must match. The agent is prompted to end its reply with matching
   * JSON; the engine extracts and validates it (one bounded "fix your JSON"
   * retry) and stores the parsed value on `StepResult.json`.
   */
  output?: JsonSchema;
}

/**
 * Fields shared by steps that run inside a per-step workspace (worker/processor
 * and command steps): worktree inheritance and declared artifacts.
 */
export interface WorkspaceFields {
  /**
   * `"inherit:<stepId>"` — start this step's isolated worktree from the named
   * earlier step's final worktree state (tracked edits AND untracked files)
   * instead of the original checkout. This is how sequential steps share files:
   * an implement → review → test pipeline where each step actually sees the
   * previous step's edits, while the user's checkout stays untouched.
   *
   * The source becomes an implicit dependency: this step is scheduled after it,
   * skips when it was skipped, and fails when it failed. The source must be a
   * worker/processor/command step without `forEach` (a fan-out parent has many
   * worktrees — merge them first). Outside a git repository steps share the
   * plain cwd, so inheritance is trivially satisfied.
   *
   * Merging an inherited worktree lands the whole chain's changes: its diff
   * base stays the original base commit, so it includes the inherited edits
   * plus this step's own.
   */
  workspace?: string;
  /**
   * Output files/directories this step promises to produce, as paths relative
   * to the step's cwd (e.g. `["report.md", "coverage/"]`). After the step
   * succeeds, each is snapshotted out of the (ephemeral, prunable) worktree
   * into a per-run artifacts directory and recorded on `StepResult.artifacts`;
   * templates reference the snapshot path as `{{steps.<id>.artifacts.<name>}}`
   * where `<name>` is the last path segment minus its extension (`report.md` →
   * `report`, `coverage/` → `coverage`). A declared artifact that was not
   * produced fails the step — declarations are a contract.
   */
  artifacts?: string[];
}

export interface WorkerStep extends WorkflowStepBase, AgentRunFields, WorkspaceFields {
  kind?: "worker" | "processor";
  /**
   * Dynamically fan this worker/processor out over prior distributor items.
   * Syntax: `steps.<id>.items` (or `<id>.items`).
   */
  forEach?: string;
  /** Per-step auto-retry policy for transient failures (overrides the workflow default). */
  retry?: RetryPolicy;
  /**
   * Optional per-step USD budget. Meaningful for `forEach` fan-outs: once the
   * step's children have spent this much, the engine stops dispatching new
   * children (in-flight children finish). The step is marked not-ok with a
   * budget-exceeded error; already-completed children stay cached so a resume
   * (after raising the cap) continues rather than re-running them.
   */
  maxCostUsd?: number;
}

export interface DistributorStep extends WorkflowStepBase {
  kind: "distributor";
  /** Static items to distribute. Each item is templated before execution. */
  items?: string[];
  /** Separator used for the rendered text output (defaults to newline). */
  separator?: string;
  /**
   * Optional agent-backed splitter. When provided, the agent output becomes the
   * distributed payload; when `items` is also present, static items win.
   */
  agent?: AgentInstanceId;
  model?: string;
  prompt?: string;
  cwd?: string;
  env?: Record<string, string>;
  extraArgs?: string[];
  effort?: string;
  stepTimeoutSec?: number;
  stepTimeoutMs?: number;
  /** Output JSON schema for the agent-backed splitter; see {@link AgentRunFields.output}. */
  output?: JsonSchema;
  /**
   * Path into the parsed structured output (e.g. `targets`) whose JSON array
   * becomes the distributed items. Requires `output`; omitted means the parsed
   * value itself must be an array. Without `output`, agent output is split on
   * non-empty lines as before.
   */
  itemsPath?: string;
}

export interface ConsolidatorStep extends WorkflowStepBase {
  kind: "consolidator";
  /**
   * Optional agent-backed merge. Without an agent, the consolidator emits the
   * rendered prompt or a sectioned merge of its dependencies.
   */
  agent?: AgentInstanceId;
  model?: string;
  prompt?: string;
  cwd?: string;
  env?: Record<string, string>;
  extraArgs?: string[];
  effort?: string;
  stepTimeoutSec?: number;
  stepTimeoutMs?: number;
  separator?: string;
  /** Output JSON schema for the agent-backed merge; see {@link AgentRunFields.output}. */
  output?: JsonSchema;
}

/**
 * Merge-back step: harvest the git worktrees of earlier agent steps and land
 * their changes somewhere useful. Deterministic (engine-executed, no agent) in
 * the common path; an optional agent resolves merge conflicts when
 * `onConflict: "agent"`.
 *
 * Sources are `from` (default: `dependsOn`). A source that is a `forEach`
 * fan-out parent contributes every child worktree. Sources whose worktrees
 * have no changes are skipped.
 *
 * Delivery `mode`:
 *  - `"apply"` (default): the merged diff lands in the user's checkout as
 *    uncommitted working-tree changes (pre-checked, all-or-nothing; the step
 *    fails with guidance when local edits conflict).
 *  - `"branch"`: the merged state is left on a local branch (`branch`, or a
 *    generated `steamtrain/merged/…` name).
 *  - `"pr"`: the branch is pushed to `origin` and a pull request is opened via
 *    the `gh` CLI (`prTitle` / `prBody` templates). With `perSource: true`,
 *    each source worktree gets its own branch + PR — the "one PR per parallel
 *    agent, reviewed by a human" operating model.
 *
 * Conflicts BETWEEN sources (two agents touched the same lines) follow
 * `onConflict`: `"fail"` (default), `"ours"` / `"theirs"` (first-merged wins /
 * incoming wins, via `git merge -X` — content conflicts only; tree-level
 * conflicts such as modify/delete or rename/rename still fail), or `"agent"`
 * — the configured agent is launched inside the staging worktree with the
 * conflict markers and asked to resolve them.
 */
export interface MergeStep extends WorkflowStepBase {
  kind: "merge";
  /** Steps whose worktrees to merge; defaults to `dependsOn`. */
  from?: string[];
  /** Where the merged changes land (see kind docs). Default `"apply"`. */
  mode?: "apply" | "branch" | "pr";
  /** Branch name template for branch/pr modes; generated when omitted. */
  branch?: string;
  /** One branch/PR per source worktree instead of one combined merge (branch/pr modes only). */
  perSource?: boolean;
  /** What to do when source worktrees conflict with each other. Default `"fail"`. */
  onConflict?: "fail" | "ours" | "theirs" | "agent";
  /** Merge-commit message template. */
  commitMessage?: string;
  /** PR title/body templates (pr mode). */
  prTitle?: string;
  prBody?: string;
  /** Conflict-resolution agent (`onConflict: "agent"`). */
  agent?: AgentInstanceId;
  model?: string;
  effort?: string;
  /** Extra guidance appended to the built-in conflict-resolution prompt. */
  prompt?: string;
  env?: Record<string, string>;
  extraArgs?: string[];
  stepTimeoutSec?: number;
}

/**
 * Deterministic shell-command step: run `cmd` through the platform shell and
 * capture its combined stdout+stderr as the step output — no agent, no cost,
 * no LLM in the loop. The canonical use is letting deterministic tools verify
 * what non-deterministic agents produced ("run the test suite", "run the
 * linter") and gating on the result.
 *
 * The step is ok exactly when the command exits 0. The exit code is recorded
 * on the result and available to templates as `{{steps.<id>.exitCode}}`; a
 * gate on `{ "step": "<id>", "ok": true }` is the usual routing.
 *
 * Command steps run inside the same per-step git-worktree isolation as agent
 * steps (when the workflow runs in a git repository), so a command that writes
 * files never touches the user's checkout, and a `merge` step can harvest what
 * it wrote.
 */
export interface CommandStep extends WorkflowStepBase, WorkspaceFields {
  kind: "command";
  /** Shell command line (run via the platform shell). Template. */
  cmd: string;
  /** Target working directory (absolute, or relative to the run's base cwd). */
  cwd?: string;
  /** Extra env vars merged over `process.env` for this step only. */
  env?: Record<string, string>;
  /** Per-step subprocess wall-clock limit in seconds (overrides workflow and config defaults). */
  stepTimeoutSec?: number;
  /**
   * Optional JSON schema (subset; see `structured.ts`) the command's output
   * must match — for commands that print JSON (test reporters, `jq`, custom
   * scripts). The engine extracts and validates it and stores the parsed value
   * on `StepResult.json`. Unlike agent steps there is no "fix your JSON" retry:
   * the command is deterministic, so a mismatch simply fails the step.
   */
  output?: JsonSchema;
}

/**
 * Invokes another named workflow as a child run. The child run's own steps
 * fold into THIS run's history under a namespaced id
 * (`<thisStepId>::<childStepId>`) — see `executeWorkflowStep` in engine.ts.
 * Never itself owns a worktree or spawns an agent; the child's own steps
 * handle that internally, so it deliberately does NOT mix in
 * `AgentRunFields`/`WorkspaceFields` and is not an eligible
 * `workspace: "inherit:<stepId>"` source (enforced by the same allowlist
 * check that already excludes gate/distributor/consolidator/merge steps).
 *
 * Budget note: this step counts as a fixed cost of 1 toward the PARENT
 * spec's own `MAX_STEPS`; the child spec enforces its own independent
 * `MAX_STEPS` at its own validate time. See
 * docs/superpowers/specs/2026-07-04-sub-workflows-design.md
 * ("Step budget decision") for why this is a deliberate deviation from
 * combining both into one static ceiling.
 */
export interface WorkflowCallStep extends WorkflowStepBase {
  kind: "workflow";
  /** Name of the workflow to invoke (resolved via `WorkflowDeps.resolveWorkflow` at run time). */
  workflow: string;
  /** Template rendered to become the child run's `{{input}}`. Omitted ⇒ this run's own `{{input}}` passes through unchanged. */
  input?: string;
  /**
   * Id of the child step whose `output`/`json` surface as this step's own
   * result. Omitted ⇒ the child spec's last step (last phase, last step by
   * array position — NOT chronological completion order, which is
   * non-deterministic under concurrent scheduling).
   *
   * Not validated against the child spec at spec-validate time: the child is
   * resolved via `WorkflowDeps.resolveWorkflow`, which isn't available during
   * pure structural validation. An `outputStep` naming a nonexistent child
   * step is caught at run time (the step fails with a clear "did not produce a
   * result" error).
   */
  outputStep?: string;
}

/**
 * Optional per-million-token USD rates for an `llm` step. The APIs report
 * exact token usage but not dollar cost; when a step declares its model's
 * rates, the engine computes an exact `costUsd` from the returned usage so
 * budget enforcement (`maxCostUsd`) and cost analytics see llm spend. Omitted
 * ⇒ tokens are still recorded but the step contributes $0 to budgets.
 */
export interface LlmPricing {
  inputPerMTok?: number;
  outputPerMTok?: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
}

/**
 * Lightweight LLM step: a single stateless API call (Anthropic or any
 * OpenAI-compatible endpoint) that turns one prompt into one completion — the
 * middle tier between a deterministic `command` step and a full coding-agent
 * `worker`. No worktree, no agent CLI, no doctor preflight; the API key comes
 * from the environment ({@link LlmStep.apiKeyEnv}). The canonical uses are the
 * judge / classify / summarize / route touches that don't need tools:
 * consolidators that merge text, verdict steps feeding gates, splitters that
 * fan a request into a list.
 *
 * With an `output` schema the step reuses the shipped structured-output
 * machinery (instructions + validation + one bounded fix retry), and — where
 * the API supports it — JSON-only response mode is requested at the API level.
 * When the parsed structured value (or the array at `itemsPath`) is a JSON
 * array it becomes the step's `items`, so an llm step can serve as a `forEach`
 * fan-out source exactly like a distributor. An llm step may itself carry
 * `forEach` to run once per item of an earlier splitter.
 *
 * LLM calls are stateless and side-effect-free, so transient failures (rate
 * limits, 5xx, network errors, timeouts) are always auto-retried under the
 * step/workflow retry policy.
 */
export interface LlmStep extends WorkflowStepBase {
  kind: "llm";
  /**
   * Configured API instance this step calls (see `apis` in `steamtrain.json` /
   * `~/.steamtrain/config.json`). The instance supplies the provider, endpoint,
   * key env var, default model, and pricing; the step's own fields override
   * them individually. Omitted ⇒ the built-in instance for the (explicit or
   * inferred) provider, so existing specs keep working unchanged.
   */
  api?: ApiInstanceId;
  /** API dialect. Omitted ⇒ from `api`, else inferred: `claude-*` models → anthropic, everything else → openai. */
  provider?: "anthropic" | "openai";
  /** Model id in the provider's own format. May be omitted when `api` names an instance with a `defaultModel`. */
  model?: string;
  /** Prompt template; may reference `{{input}}` and `{{steps.<id>.output}}`. */
  prompt: string;
  /** Optional system prompt. Templated like `prompt`. */
  system?: string;
  /** Output-token cap (anthropic `max_tokens`, openai `max_completion_tokens`). */
  maxTokens?: number;
  /** Sampling temperature; only sent when set (recent Anthropic models reject it). */
  temperature?: number;
  /** Reasoning effort (anthropic `output_config.effort`, openai `reasoning_effort`). */
  effort?: string;
  /** Env var holding the API key. Default `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` by provider. */
  apiKeyEnv?: string;
  /** Endpoint override for proxies and OpenAI-compatible providers (OpenAI convention: include `/v1`). */
  baseUrl?: string;
  /** Per-call wall-clock limit in seconds (overrides workflow and config defaults). */
  stepTimeoutSec?: number;
  /** Per-step auto-retry policy for transient failures (overrides the workflow default). */
  retry?: RetryPolicy;
  /** Fan this step out over prior splitter items (`steps.<id>.items`). */
  forEach?: string;
  /** Output JSON schema; see {@link AgentRunFields.output}. */
  output?: JsonSchema;
  /**
   * Path into the parsed structured output whose JSON array becomes the
   * distributed items (requires `output`). Omitted ⇒ the parsed value itself
   * becomes `items` when it is an array. See {@link DistributorStep.itemsPath}.
   */
  itemsPath?: string;
  /** Optional per-MTok rates to compute an exact `costUsd`; see {@link LlmPricing}. */
  pricing?: LlmPricing;
  /**
   * Optional per-step USD budget for `forEach` fan-outs, mirroring
   * {@link WorkerStep.maxCostUsd}. Only meaningful together with `pricing` —
   * without declared rates an llm call contributes $0 and the cap never trips.
   */
  maxCostUsd?: number;
}

export interface GateCondition {
  /** Step whose result is inspected; omitted means inspect the workflow input. */
  step?: string;
  /**
   * Human-in-the-loop condition: the gate pauses the run and waits for a
   * human (or an automated `--approve-all` / `--on-approval` policy) to
   * Approve or Reject. `passed` becomes the approval outcome, so the gate's
   * `onFalse` (`continue` / `fail` / `stop`) and `target` route on it exactly
   * like a mechanical gate, and `loopTo` can turn "reject" into a loop-back.
   * When set, the mechanical predicates (`ok` / `contains` / `matches` /
   * `equals` / `path`) are not used (and are rejected by validation). See the
   * ergonomic `approval` step kind for the common case.
   */
  human?: boolean;
  /** Match the referenced step's ok/error state. */
  ok?: boolean;
  /**
   * Path into the referenced step's structured output (e.g. `verdict`,
   * `issues[0].severity`). Text conditions then apply to that field — strings
   * raw, other values JSON-serialized, missing fields as empty text. Requires
   * `step`, and the step must declare an `output` schema to have parsed JSON.
   */
  path?: string;
  /** Text condition against the referenced output (or input). */
  contains?: string;
  /** Regular expression condition against the referenced output (or input). */
  matches?: string;
  /** Exact text condition against the referenced output (or input). */
  equals?: string;
  /** Invert the final condition result. */
  not?: boolean;
}

export interface GateStep extends WorkflowStepBase {
  kind: "gate";
  condition: GateCondition;
  /** Optional state/label emitted when the gate evaluates. */
  target?: string;
  /** What to do when the condition is false (default: continue). */
  onFalse?: "continue" | "fail" | "stop";
  /**
   * When set, this gate is a loop: while its condition is false and the
   * per-loop iteration budget remains, execution jumps back to this (earlier)
   * phase id and re-runs the body. When the budget is exhausted, `onFalse`
   * applies. Omitting `loopTo` makes a plain (non-looping) gate.
   */
  loopTo?: string;
  /** Per-loop iteration cap (1..LOOP_MAX_ITERATIONS_CEILING). Omitted → config default. */
  maxIterations?: number;
}

/**
 * Human-in-the-loop approval checkpoint (§1.2). Pauses the run, surfaces the
 * reviewed step's output — and, when it ran in an isolated git worktree, its
 * diff — and waits for a human (TUI keypress, web Approve/Reject card) or an
 * automated CI policy (`--approve-all` / `--on-approval fail|stop`) to decide.
 * Approve continues the run (emitting `target`); Reject applies `onReject`.
 *
 * Sugar over a `gate` whose condition is `{ human: true }`: the engine routes
 * both through one approval path, so an approval step reuses the gate's
 * `gate_evaluated` event, history, and reducer handling. Unlike a gate it never
 * loops and its reject disposition is `fail`/`stop` only (a "continue on
 * reject" checkpoint is a no-op).
 *
 * Approval decisions are never cached, so a resumed run always re-asks while
 * the cached steps around the checkpoint replay.
 */
export interface ApprovalStep extends WorkflowStepBase {
  kind: "approval";
  /**
   * The step whose output/diff to surface for review. Defaults to this step's
   * sole `dependsOn` entry when it has exactly one; must reference an earlier
   * phase. Omit both `step` and a single `dependsOn` for a bare "proceed?"
   * checkpoint with no reviewed output.
   */
  step?: string;
  /** Human-readable instructions shown alongside the reviewed output. Templated. */
  prompt?: string;
  /** State/label emitted when the checkpoint is approved. Default `"approved"`. */
  target?: string;
  /** What a rejection does to control flow. Default `"fail"`. */
  onReject?: "fail" | "stop";
}

export type WorkflowStep =
  | WorkerStep
  | DistributorStep
  | ConsolidatorStep
  | GateStep
  | ApprovalStep
  | MergeStep
  | CommandStep
  | LlmStep
  | WorkflowCallStep;

export interface WorkflowPhase {
  id: string;
  title: string;
  /** Steps run in parallel within the phase. */
  steps: WorkflowStep[];
}

/**
 * Declares a named input parameter for a workflow. Users supply values via
 * `--param key=value` (CLI) or the input form (TUI/web). Templates reference
 * the resolved value as `{{inputs.key}}`.
 */
export interface WorkflowInputSpec {
  /** Expected type (default `"string"`). */
  type?: "string" | "number" | "boolean";
  /** Human-readable description shown in UIs and help text. */
  description?: string;
  /** Default value when the user omits this input. */
  default?: string | number | boolean;
  /**
   * Whether the user must supply a value. Defaults to `true` when `default`
   * is omitted, `false` when `default` is set.
   */
  required?: boolean;
}

export interface WorkflowSpec {
  /** Launch name; unique among available workflows. */
  name: string;
  description?: string;
  /**
   * Named input parameters. Each key becomes a `{{inputs.<key>}}` template
   * variable. Users supply values via `--param key=value` (CLI) or the run
   * form (TUI/web). Inputs with a `default` are optional; without one the
   * user must provide a value or the run is rejected before it starts.
   */
  inputs?: Record<string, WorkflowInputSpec>;
  phases: WorkflowPhase[];
  /** Default auto-retry policy applied to every agent step (per-step `retry` overrides). */
  retry?: RetryPolicy;
  /** Default per-agent subprocess timeout for agent-backed steps (per-step `stepTimeoutSec` overrides). */
  stepTimeoutSec?: number;
  /** Whole-workflow wall-clock abort limit in seconds. Omitted → stepCount × stepTimeoutSec. */
  workflowTimeoutSec?: number;
  /** @deprecated Use `stepTimeoutSec`. */
  stepTimeoutMs?: number;
  /** @deprecated Use `workflowTimeoutSec`. */
  workflowTimeoutMs?: number;
  /**
   * Optional whole-workflow USD budget. Once the run's accumulated cost reaches
   * this cap the engine stops scheduling new steps; steps already in flight run
   * to completion. The run ends with status `budget-exceeded` and its cache
   * intact, so raising the cap and re-running resumes from where it stopped
   * (completed steps replay from cache) rather than starting over.
   */
  maxCostUsd?: number;
}

export interface AgentWorktreeInfo {
  /** Original resolved cwd requested by the workflow step. */
  originalCwd: string;
  /** Actual cwd used for the agent subprocess. */
  cwd: string;
  /** Root of the isolated git worktree. */
  root: string;
  /** Branch checked out by the isolated git worktree. */
  branch: string;
  /** Commit the worktree branch started from (the merge-back diff base). */
  baseCommit?: string;
  /** Ignored runtime entries linked from the source checkout into the worktree. */
  linkedIgnoredPaths?: string[];
}

/** One declared step output, snapshotted into the run's artifact directory. */
export interface StepArtifact {
  /** Template name (`{{steps.<id>.artifacts.<name>}}`): last path segment minus extension. */
  name: string;
  /** The declared path, relative to the step's cwd. */
  source: string;
  /** Absolute path of the snapshot in the run's artifact directory. */
  path: string;
  /** Total bytes snapshotted (file sizes summed for a directory artifact). */
  bytes: number;
  /** Number of files snapshotted (1 for a plain file artifact). */
  files: number;
}

/** The outcome of one step, fed into downstream templates and the cache. */
export interface StepResult {
  stepId: string;
  ok: boolean;
  /** Final text (a failed step's output is its error message, for templating). */
  output: string;
  /** Distributed item payloads, when a distributor produced structured items. */
  items?: string[];
  /**
   * Parsed structured output, when the step declared an `output` schema and
   * its final text contained matching JSON. Read by
   * `{{steps.<id>.json.<path>}}` templates and gate `path` conditions.
   */
  json?: unknown;
  /** The work item assigned to this generated child result, if any. */
  item?: WorkflowItem;
  /** Parent dynamic step id for generated child results. */
  parentStepId?: string;
  /** Generated child results for a dynamic fan-out parent. */
  childResults?: StepResult[];
  /** Gate target/state label, when a gate evaluated. */
  target?: string;
  gate?: {
    passed: boolean;
    onFalse: GateStep["onFalse"];
  };
  /**
   * True when the step did not run because its `when` condition was false (or
   * a skip cascaded from a skipped dependency). Skipped steps are `ok` with
   * empty output so downstream templates see them as absent, not failed.
   */
  skipped?: boolean;
  /**
   * True for a fan-out child that was never dispatched because a per-step
   * `maxCostUsd` was reached. It is a placeholder (no cost/tokens) that a resume
   * re-runs; analytics skip it so live and recorded step counts agree.
   */
  notRun?: boolean;
  error?: string;
  durationMs: number;
  costUsd?: number;
  /** Normalized token usage the agent reported for this step, when available. */
  tokens?: TokenUsage;
  /**
   * The API instance and effective model a direct-inference `llm` step
   * actually called. Recorded on the result (not just the `step_start` event)
   * so cached replays and analytics attribute the recorded spend to what ran,
   * even if the configured instance's endpoint or defaultModel changed since.
   */
  api?: ApiInstanceId;
  /** Effective model the `llm` step called; see {@link StepResult.api}. */
  model?: string;
  /** Total attempts this step took (auto-retry); omitted/1 means it ran once. */
  attempts?: number;
  /** Subprocess exit code, for `command` steps (`{{steps.<id>.exitCode}}`). */
  exitCode?: number;
  /** Declared artifacts snapshotted after the step succeeded. */
  artifacts?: StepArtifact[];
  /** Isolated git worktree metadata for agent-backed steps. */
  worktree?: AgentWorktreeInfo;
  /** Loop iteration this result belongs to (1-based); omitted ⇒ 1. */
  iteration?: number;
  /**
   * When true this result must never be written to the step cache (in-memory
   * or on-disk). Set for human-approval checkpoints so a resumed run always
   * re-asks the decision instead of replaying a stale approval. Purely a
   * runtime flag: it is not persisted (a `noCache` result is never stored).
   */
  noCache?: boolean;
}

/** Total steps a single run may contain (matches the dynamic-workflows cap). */
export const MAX_STEPS = 1000;
/** Hard ceiling on parallel agents; the configured value is clamped to this. */
export const MAX_CONCURRENCY = 16;
/** Hard ceiling on `maxParallelRuns` (whole runs executing at once). */
export const MAX_PARALLEL_RUNS_CEILING = 16;
/** Default per-loop iteration cap when a loop gate omits `maxIterations`. */
export const DEFAULT_LOOP_MAX_ITERATIONS = 10;
/** Hard ceiling on a loop gate's `maxIterations` (runaway backstop). */
export const LOOP_MAX_ITERATIONS_CEILING = 100;
/** Hard ceiling on nested `workflow` step call-stack depth (cycle/blast-radius backstop). */
export const MAX_WORKFLOW_NESTING_DEPTH = 5;

const agentId = z
  .string()
  .min(1)
  .describe("Configured agent instance id; validated at run time via resolveAgentInstance");

const gateConditionSchema = z
  .object({
    step: z.string().min(1).optional(),
    human: z.boolean().optional(),
    ok: z.boolean().optional(),
    path: z.string().min(1).optional(),
    contains: z.string().optional(),
    matches: z.string().optional(),
    equals: z.string().optional(),
    not: z.boolean().optional(),
  })
  .superRefine((condition, ctx) => {
    // A human-approval condition pauses for a decision instead of testing a
    // predicate, so it is mutually exclusive with the mechanical checks.
    if (condition.human) {
      const mechanical =
        condition.ok !== undefined ||
        condition.path !== undefined ||
        condition.contains !== undefined ||
        condition.matches !== undefined ||
        condition.equals !== undefined;
      if (mechanical) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "gate condition human cannot be combined with ok/path/contains/matches/equals",
        });
      }
      return;
    }
    if (
      condition.ok === undefined &&
      condition.contains === undefined &&
      condition.matches === undefined &&
      condition.equals === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "gate condition requires human, ok, contains, matches, or equals",
      });
    }
    if (condition.ok !== undefined && !condition.step) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "gate condition ok requires condition.step",
      });
    }
    if (condition.path !== undefined && !condition.step) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "gate condition path requires condition.step",
      });
    }
  });

const baseStepShape = {
  id: z.string().min(1),
  dependsOn: z.array(z.string().min(1)).optional(),
  when: gateConditionSchema.optional(),
};

/** A JSON Schema object for structured step output (subset; see structured.ts). */
const outputJsonSchema = z.record(z.unknown());

const agentRunShape = {
  agent: agentId,
  model: z.string().min(1),
  prompt: z.string().min(1),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string()).optional(),
  extraArgs: z.array(z.string()).optional(),
  effort: z.string().min(1).optional(),
  stepTimeoutSec: z.number().positive().optional(),
  stepTimeoutMs: z.number().positive().optional(),
  output: outputJsonSchema.optional(),
};

const optionalAgentRunShape = {
  agent: agentId.optional(),
  model: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string()).optional(),
  extraArgs: z.array(z.string()).optional(),
  effort: z.string().min(1).optional(),
  stepTimeoutSec: z.number().positive().optional(),
  stepTimeoutMs: z.number().positive().optional(),
  output: outputJsonSchema.optional(),
};

const workspaceShape = {
  workspace: z
    .string()
    .regex(/^inherit:.+$/, 'workspace must be "inherit:<stepId>"')
    .optional(),
  artifacts: z.array(z.string().min(1)).min(1).optional(),
};

const workflowInputSpecSchema = z.object({
  type: z.enum(["string", "number", "boolean"]).optional(),
  description: z.string().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  required: z.boolean().optional(),
});

const retryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10).optional(),
  initialDelayMs: z.number().int().min(0).max(60000).optional(),
  factor: z.number().min(1).max(10).optional(),
  maxDelayMs: z.number().int().min(0).max(600000).optional(),
  jitter: z.boolean().optional(),
});

const workflowWorkerStepSchema = z.object({
  ...baseStepShape,
  kind: z.enum(["worker", "processor"]).optional(),
  forEach: z.string().min(1).optional(),
  retry: retryPolicySchema.optional(),
  maxCostUsd: z.number().positive().optional(),
  ...agentRunShape,
  ...workspaceShape,
});

const workflowDistributorStepSchema = z
  .object({
    ...baseStepShape,
    kind: z.literal("distributor"),
    items: z.array(z.string()).min(1).optional(),
    separator: z.string().optional(),
    itemsPath: z.string().min(1).optional(),
    ...optionalAgentRunShape,
  })
  .superRefine((step, ctx) => {
    if (step.itemsPath && !(step.agent && step.output)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "distributor itemsPath requires an agent-backed step with an output schema",
      });
    }
    if (step.items) return;
    if (step.agent && step.model && step.prompt) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "distributor step requires either non-empty items or agent/model/prompt",
    });
  });

const workflowConsolidatorStepSchema = z
  .object({
    ...baseStepShape,
    kind: z.literal("consolidator"),
    separator: z.string().optional(),
    ...optionalAgentRunShape,
  })
  .superRefine((step, ctx) => {
    if ((step.agent || step.model) && !(step.agent && step.model && step.prompt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "agent-backed consolidator requires agent, model, and prompt together",
      });
    }
    if (!step.dependsOn?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "consolidator step requires dependsOn",
      });
    }
  });

const workflowGateStepSchema = z.object({
  ...baseStepShape,
  kind: z.literal("gate"),
  condition: gateConditionSchema,
  target: z.string().min(1).optional(),
  onFalse: z.enum(["continue", "fail", "stop"]).optional(),
  loopTo: z.string().min(1).optional(),
  maxIterations: z.number().int().min(1).max(LOOP_MAX_ITERATIONS_CEILING).optional(),
});

const workflowApprovalStepSchema = z.object({
  ...baseStepShape,
  kind: z.literal("approval"),
  step: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  target: z.string().min(1).optional(),
  onReject: z.enum(["fail", "stop"]).optional(),
});

const workflowMergeStepSchema = z
  .object({
    ...baseStepShape,
    kind: z.literal("merge"),
    from: z.array(z.string().min(1)).min(1).optional(),
    mode: z.enum(["apply", "branch", "pr"]).optional(),
    branch: z.string().min(1).optional(),
    perSource: z.boolean().optional(),
    onConflict: z.enum(["fail", "ours", "theirs", "agent"]).optional(),
    commitMessage: z.string().min(1).optional(),
    prTitle: z.string().min(1).optional(),
    prBody: z.string().min(1).optional(),
    agent: agentId.optional(),
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    env: z.record(z.string()).optional(),
    extraArgs: z.array(z.string()).optional(),
    stepTimeoutSec: z.number().positive().optional(),
  })
  .superRefine((step, ctx) => {
    if (!step.from?.length && !step.dependsOn?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "merge step requires from or dependsOn (the steps whose worktrees to merge)",
      });
    }
    if (step.onConflict === "agent" && !(step.agent && step.model)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'merge step with onConflict "agent" requires agent and model',
      });
    }
    // Applying source diffs one at a time to the same checkout can't be
    // all-or-nothing across sources (a later source's failed apply would
    // leave earlier sources' changes in the working tree).
    if (step.perSource && (step.mode ?? "apply") === "apply") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'merge step with perSource requires mode "branch" or "pr"',
      });
    }
    if ((step.agent || step.model) && !(step.agent && step.model)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "merge step conflict agent requires agent and model together",
      });
    }
  });

const workflowCommandStepSchema = z.object({
  ...baseStepShape,
  kind: z.literal("command"),
  cmd: z.string().min(1),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string()).optional(),
  stepTimeoutSec: z.number().positive().optional(),
  output: outputJsonSchema.optional(),
  ...workspaceShape,
});

// Strict + non-empty: a typo'd rate key (`inputPerMtok`) or an empty object
// would otherwise validate and silently bill the step at $0 — a money-
// accounting footgun worth rejecting loudly.
export const llmPricingSchema = z
  .object({
    inputPerMTok: z.number().nonnegative().optional(),
    outputPerMTok: z.number().nonnegative().optional(),
    cacheReadPerMTok: z.number().nonnegative().optional(),
    cacheWritePerMTok: z.number().nonnegative().optional(),
  })
  .strict()
  .refine(
    (pricing) => Object.values(pricing).some((rate) => rate !== undefined),
    "pricing must declare at least one per-MTok rate",
  );

const workflowLlmStepSchema = z
  .object({
    ...baseStepShape,
    kind: z.literal("llm"),
    api: z.string().min(1).optional(),
    provider: z.enum(["anthropic", "openai"]).optional(),
    model: z.string().min(1).optional(),
    prompt: z.string().min(1),
    system: z.string().min(1).optional(),
    maxTokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    effort: z.string().min(1).optional(),
    apiKeyEnv: z.string().min(1).optional(),
    baseUrl: z.string().min(1).optional(),
    stepTimeoutSec: z.number().positive().optional(),
    retry: retryPolicySchema.optional(),
    forEach: z.string().min(1).optional(),
    output: outputJsonSchema.optional(),
    itemsPath: z.string().min(1).optional(),
    pricing: llmPricingSchema.optional(),
    maxCostUsd: z.number().positive().optional(),
  })
  .superRefine((step, ctx) => {
    if (step.itemsPath && !step.output) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "llm itemsPath requires an output schema",
      });
    }
    // Without an `api` reference there is no configured instance to supply a
    // defaultModel, so the step must name its model explicitly.
    if (!step.model && !step.api) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "llm step requires a model (or an api whose instance sets a defaultModel)",
      });
    }
  });

const workflowCallStepSchema = z.object({
  ...baseStepShape,
  kind: z.literal("workflow"),
  workflow: z.string().min(1),
  input: z.string().min(1).optional(),
  outputStep: z.string().min(1).optional(),
});

const workflowStepSchema = z.union([
  workflowGateStepSchema,
  workflowApprovalStepSchema,
  workflowDistributorStepSchema,
  workflowConsolidatorStepSchema,
  workflowMergeStepSchema,
  workflowCommandStepSchema,
  workflowLlmStepSchema,
  workflowCallStepSchema,
  workflowWorkerStepSchema,
]);

const workflowPhaseSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  steps: z.array(workflowStepSchema).min(1),
});

/**
 * Shape + size validation. `name` is optional here so a `steamtrain.json`
 * `workflows` map can key by name without repeating it; the loader injects the
 * key as `name`. Cross-phase dependency rules live in {@link validateWorkflow}.
 */
export const workflowSpecSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    inputs: z.record(workflowInputSpecSchema).optional(),
    phases: z.array(workflowPhaseSchema).min(1),
    retry: retryPolicySchema.optional(),
    stepTimeoutSec: z.number().positive().optional(),
    workflowTimeoutSec: z.number().positive().optional(),
    stepTimeoutMs: z.number().positive().optional(),
    workflowTimeoutMs: z.number().positive().optional(),
    maxCostUsd: z.number().positive().optional(),
  })
  .superRefine((spec, ctx) => {
    const seen = new Set<string>();
    let total = 0;
    for (const phase of spec.phases) {
      for (const step of phase.steps) {
        total += 1;
        if (seen.has(step.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `duplicate step id '${step.id}'`,
          });
        }
        seen.add(step.id);
      }
    }
    if (total > MAX_STEPS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `workflow has ${total} steps (max ${MAX_STEPS})`,
      });
    }
  });

/**
 * The raw shape parsed from JSON (config / user file) before a name is injected
 * from the map key. `name` is optional here; loaders normalize it to a string.
 */
export type WorkflowSpecInput = z.infer<typeof workflowSpecSchema>;

export interface ValidationResult {
  ok: boolean;
  error?: string;
  /** Non-fatal template reference warnings from {@link lintTemplateRefs}. */
  warnings?: string[];
}

export function workflowStepKind(step: WorkflowStep): WorkflowStepKind {
  return step.kind ?? "worker";
}

export type AgentBackedWorkflowStep = WorkflowStep & AgentRunFields;

/** The step id a `workspace: "inherit:<stepId>"` field names, if any. */
export function workspaceSourceId(step: WorkflowStep): string | undefined {
  const workspace = "workspace" in step ? step.workspace : undefined;
  if (!workspace) return undefined;
  return /^inherit:(.+)$/.exec(workspace)?.[1];
}

/**
 * Template name an artifact path is referenced by: the last path segment minus
 * a trailing extension (`report.md` → `report`, `coverage/` → `coverage`,
 * `dist/app.tar.gz` → `app.tar`; dotfiles like `.env` keep their name).
 */
export function artifactName(source: string): string {
  const segments = source.split(/[\\/]+/).filter(Boolean);
  const base = segments[segments.length - 1] ?? source;
  return base.replace(/(?<=.)\.[^.]+$/, "");
}

/**
 * Why a declared artifact path is unusable, or undefined when it is fine.
 * Artifact paths must stay inside the step's working directory — they are
 * copied out of the workspace, so an absolute path or a `..` escape would
 * snapshot files the step doesn't own.
 */
function artifactPathError(source: string): string | undefined {
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(source)) return "must be a relative path";
  const parts = source.split(/[\\/]+/).filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0) return "does not name a file or directory";
  let depth = 0;
  for (const part of parts) {
    depth += part === ".." ? -1 : 1;
    if (depth < 0) return "escapes the step directory";
  }
  // The LAST segment becomes the artifact's template name and its snapshot
  // directory entry; a trailing `..` (e.g. `src/..`) would make the snapshot
  // destination the shared run artifacts directory itself.
  if (parts[parts.length - 1] === "..") {
    return "must name a file or directory, not a parent reference";
  }
  return undefined;
}

export function parseForEachSource(source: string): string | undefined {
  const explicit = /^steps\.(.+)\.items$/.exec(source);
  if (explicit) return explicit[1];
  const shorthand = /^(.+)\.items$/.exec(source);
  return shorthand?.[1];
}

/**
 * Whether a step has an `agent` field set. Returns true for worker, processor,
 * agent-backed distributor, and agent-backed consolidator steps. Gate steps
 * never have an agent field.
 */
export function isAgentBackedStep(step: WorkflowStep): step is AgentBackedWorkflowStep {
  return "agent" in step && typeof step.agent === "string";
}

/** Distinct agent ids a workflow's steps will spawn (empty for agentless flows). */
export function workflowAgentIds(spec: WorkflowSpec): AgentInstanceId[] {
  const set = new Set<AgentInstanceId>();
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      if (isAgentBackedStep(step)) set.add(step.agent);
    }
  }
  return [...set];
}

/** All direct-inference `llm` steps in a spec (empty when none). */
export function workflowLlmSteps(spec: WorkflowSpec): LlmStep[] {
  const out: LlmStep[] = [];
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      if (step.kind === "llm") out.push(step);
    }
  }
  return out;
}

/**
 * Full validation: the zod shape plus the structural rule that a `dependsOn`
 * may only reference a step in an EARLIER phase. Phases run sequentially while
 * steps within a phase run in parallel, so same-phase and forward references
 * (and therefore cycles) are rejected.
 *
 * The worst-case step budget for a loop gate that omits `maxIterations` is
 * computed against `loopMaxIterations` (the runtime config default) — or
 * {@link DEFAULT_LOOP_MAX_ITERATIONS} when neither the gate nor the caller
 * specifies one — NOT the ceiling. The ceiling ({@link
 * LOOP_MAX_ITERATIONS_CEILING}) stays a hard "cannot be configured above this"
 * backstop enforced by the schema; it is not the budget assumption, so that a
 * spec bounded at runtime by the default (10) is not falsely rejected by the
 * static verifier.
 *
 * @param loopMaxIterations the configured runtime cap to budget against when a
 *   gate omits `maxIterations`. Pass the engine's `deps.loopMaxIterations` so
 *   the static budget matches the runtime clamp.
 */
export function validateWorkflow(spec: WorkflowSpec, loopMaxIterations?: number): ValidationResult {
  const parsed = workflowSpecSchema.safeParse(spec);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid workflow" };
  }

  if (spec.inputs) {
    for (const [name, input] of Object.entries(spec.inputs)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name)) {
        return {
          ok: false,
          error: `input name '${name}' is not a valid identifier (use letters, digits, underscores, hyphens; must start with a letter or underscore)`,
        };
      }
      const inputType = input.type ?? "string";
      if (input.default !== undefined) {
        if (inputType === "number" && typeof input.default !== "number") {
          return {
            ok: false,
            error: `input '${name}' declares type "number" but default is not a number`,
          };
        }
        if (inputType === "boolean" && typeof input.default !== "boolean") {
          return {
            ok: false,
            error: `input '${name}' declares type "boolean" but default is not a boolean`,
          };
        }
        if (inputType === "string" && typeof input.default !== "string") {
          return {
            ok: false,
            error: `input '${name}' declares type "string" but default is not a string`,
          };
        }
      }
      if (input.required === true && input.default !== undefined) {
        return {
          ok: false,
          error: `input '${name}' declares required: true but also has a default (required is redundant when default is set)`,
        };
      }
    }
  }

  const stepsById = new Map<string, WorkflowStep>();
  const allIds = new Set<string>();
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      allIds.add(step.id);
      stepsById.set(step.id, step);
    }
  }

  let maxPossibleSteps = spec.phases.reduce((n, p) => n + p.steps.length, 0);
  const earlierIds = new Set<string>();
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      for (const dep of step.dependsOn ?? []) {
        if (!earlierIds.has(dep)) {
          return {
            ok: false,
            error: allIds.has(dep)
              ? `step '${step.id}' dependsOn '${dep}', which is not in an earlier phase (deps must reference earlier phases)`
              : `step '${step.id}' dependsOn unknown step '${dep}'`,
          };
        }
      }
      if (step.kind === "gate" && step.condition.step && !earlierIds.has(step.condition.step)) {
        return {
          ok: false,
          error: allIds.has(step.condition.step)
            ? `gate '${step.id}' condition references '${step.condition.step}', which is not in an earlier phase`
            : `gate '${step.id}' condition references unknown step '${step.condition.step}'`,
        };
      }
      if (step.kind === "approval" && step.step && !earlierIds.has(step.step)) {
        return {
          ok: false,
          error: allIds.has(step.step)
            ? `approval '${step.id}' step references '${step.step}', which is not in an earlier phase`
            : `approval '${step.id}' step references unknown step '${step.step}'`,
        };
      }
      if (step.kind === "merge") {
        for (const ref of step.from ?? []) {
          if (!earlierIds.has(ref)) {
            return {
              ok: false,
              error: allIds.has(ref)
                ? `merge step '${step.id}' from references '${ref}', which is not in an earlier phase`
                : `merge step '${step.id}' from references unknown step '${ref}'`,
            };
          }
        }
      }
      if (step.when?.step && !earlierIds.has(step.when.step)) {
        return {
          ok: false,
          error: allIds.has(step.when.step)
            ? `step '${step.id}' when condition references '${step.when.step}', which is not in an earlier phase`
            : `step '${step.id}' when condition references unknown step '${step.when.step}'`,
        };
      }
      if (
        (step.kind === "worker" ||
          step.kind === "processor" ||
          step.kind === "llm" ||
          !step.kind) &&
        step.forEach
      ) {
        const sourceStepId = parseForEachSource(step.forEach);
        if (!sourceStepId) {
          return {
            ok: false,
            error: `step '${step.id}' has invalid forEach '${step.forEach}' (expected steps.<id>.items)`,
          };
        }
        const sourceStep = stepsById.get(sourceStepId);
        if (!earlierIds.has(sourceStepId)) {
          return {
            ok: false,
            error: allIds.has(sourceStepId)
              ? `step '${step.id}' forEach references '${sourceStepId}', which is not in an earlier phase`
              : `step '${step.id}' forEach references unknown step '${sourceStepId}'`,
          };
        }
        // An llm step with an `output` schema emits `items` from its structured
        // array, so it is a valid fan-out source alongside distributors.
        const validSource =
          sourceStep?.kind === "distributor" ||
          (sourceStep?.kind === "llm" && sourceStep.output !== undefined);
        if (!validSource) {
          return {
            ok: false,
            error: `step '${step.id}' forEach source '${sourceStepId}' must be a distributor step (or an llm step with an output schema)`,
          };
        }
        if (sourceStep.kind === "distributor") {
          maxPossibleSteps += sourceStep.items?.length ?? 0;
        }
      }
      const wsSource = workspaceSourceId(step);
      if (wsSource) {
        if (!earlierIds.has(wsSource)) {
          return {
            ok: false,
            error: allIds.has(wsSource)
              ? `step '${step.id}' workspace inherits '${wsSource}', which is not in an earlier phase`
              : `step '${step.id}' workspace inherits unknown step '${wsSource}'`,
          };
        }
        const sourceStep = stepsById.get(wsSource);
        const sourceKind = sourceStep ? workflowStepKind(sourceStep) : undefined;
        if (sourceKind !== "worker" && sourceKind !== "processor" && sourceKind !== "command") {
          return {
            ok: false,
            error: `step '${step.id}' workspace inherits '${wsSource}', which is a ${sourceKind} step (only worker, processor, and command steps leave a worktree to inherit)`,
          };
        }
        if (sourceStep && "forEach" in sourceStep && sourceStep.forEach) {
          return {
            ok: false,
            error: `step '${step.id}' workspace inherits fan-out step '${wsSource}', which has one worktree per item (merge them first, or inherit a non-forEach step)`,
          };
        }
      }
      const artifacts = "artifacts" in step ? step.artifacts : undefined;
      if (artifacts) {
        const names = new Set<string>();
        for (const source of artifacts) {
          const pathError = artifactPathError(source);
          if (pathError) {
            return {
              ok: false,
              error: `step '${step.id}' artifact '${source}' ${pathError} (artifact paths are relative to the step's cwd)`,
            };
          }
          const name = artifactName(source);
          if (names.has(name)) {
            return {
              ok: false,
              error: `step '${step.id}' artifacts '${source}' and another entry share the template name '${name}' (names are the last path segment minus extension and must be unique per step)`,
            };
          }
          names.add(name);
        }
      }
    }
    // Promote this phase's ids only after the whole phase is checked, so two
    // steps in the same phase can't depend on each other.
    for (const step of phase.steps) earlierIds.add(step.id);
  }

  // ---- Loop (loopTo) validation ----
  const phaseIndexById = new Map<string, number>();
  spec.phases.forEach((p, i) => phaseIndexById.set(p.id, i));

  // Each loop gate defines a region [loopToIndex .. gatePhaseIndex].
  interface LoopRegion {
    gateId: string;
    start: number; // loopTo phase index
    end: number; // gate phase index
    maxIterations: number; // effective bound for the static budget (per-gate, config, or default 10)
  }
  const regions: LoopRegion[] = [];
  for (let pi = 0; pi < spec.phases.length; pi++) {
    const phase = spec.phases[pi];
    if (!phase) continue;
    for (const step of phase.steps) {
      if (step.kind !== "gate" || step.loopTo === undefined) continue;
      const start = phaseIndexById.get(step.loopTo);
      if (start === undefined) {
        return {
          ok: false,
          error: `gate '${step.id}' loopTo references unknown phase '${step.loopTo}'`,
        };
      }
      if (start >= pi) {
        return {
          ok: false,
          error: `gate '${step.id}' loopTo '${step.loopTo}' must be an earlier phase (loops only go backward, not to the gate's own phase)`,
        };
      }
      regions.push({
        gateId: step.id,
        start,
        end: pi,
        maxIterations: step.maxIterations ?? loopMaxIterations ?? DEFAULT_LOOP_MAX_ITERATIONS,
      });
    }
  }

  // Regions must be disjoint or properly nested — never partially overlapping.
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i] as LoopRegion;
      const b = regions[j] as LoopRegion;
      const disjoint = a.end < b.start || b.end < a.start;
      const aContainsB = a.start <= b.start && b.end <= a.end;
      const bContainsA = b.start <= a.start && a.end <= b.end;
      if (!disjoint && !aContainsB && !bContainsA) {
        return {
          ok: false,
          error: `loop regions for gates '${a.gateId}' and '${b.gateId}' partially overlap (loops must be nested or disjoint)`,
        };
      }
    }
  }

  // Worst-case step budget with loops: a region's body steps run `maxIterations`
  // times; nested regions multiply by every region that fully contains them.
  // NOTE: this deliberately DOUBLE-COUNTS nested-region body expansion — the
  // inner region's body is part of the outer region's `bodySteps` (summed from
  // `start..end`), so it is already counted in the outer's
  // `(outer.max - 1) * bodySteps`, AND counted again when the inner region's
  // own `(inner.max - 1) * outerMultiplier` extras fire. The over-estimate is
  // intentional: a verifier should err pessimistic. Do NOT "correct" this to
  // subtract the inner body from the outer sum — that would under-budget real
  // pathological nested loops. The slack is small in practice (nested loops are
  // rare and bodies are modest) and MAX_STEPS is a safety backstop, not a tight
  // quota.
  const phaseStepCount = spec.phases.map((p) => p.steps.length);
  let loopExpansion = 0;
  for (const r of regions) {
    let bodySteps = 0;
    for (let k = r.start; k <= r.end; k++) bodySteps += phaseStepCount[k] ?? 0;
    // multiplier from every OTHER region that fully contains this one
    let outerMultiplier = 1;
    for (const o of regions) {
      if (o === r) continue;
      if (o.start <= r.start && r.end <= o.end) outerMultiplier *= o.maxIterations;
    }
    // (maxIterations - 1) extra passes beyond the first, times outer multiplier
    loopExpansion += bodySteps * (r.maxIterations - 1) * outerMultiplier;
  }
  maxPossibleSteps += loopExpansion;

  if (maxPossibleSteps > MAX_STEPS) {
    return {
      ok: false,
      error: `workflow can expand to ${maxPossibleSteps} steps (max ${MAX_STEPS})`,
    };
  }

  const warnings = lintTemplateRefs(spec);
  return { ok: true, warnings: warnings.length > 0 ? warnings : undefined };
}

export interface ResolvedInputs {
  values: Record<string, string | number | boolean>;
  errors: string[];
}

/**
 * Validate user-supplied params against a workflow's declared `inputs`.
 * Returns the final resolved values (with defaults applied and types coerced)
 * plus any validation errors. Callers should check `errors` before starting
 * the run.
 */
export function resolveInputs(spec: WorkflowSpec, params: Record<string, string>): ResolvedInputs {
  const values: Record<string, string | number | boolean> = {};
  const errors: string[] = [];
  const specInputs = spec.inputs ?? {};

  for (const [name, input] of Object.entries(specInputs)) {
    const raw = params[name];
    const inputType = input.type ?? "string";
    const hasDefault = input.default !== undefined;
    const required = input.required ?? !hasDefault;

    if (raw === undefined || raw === "") {
      if (hasDefault) {
        values[name] = input.default!;
        continue;
      }
      if (required) {
        errors.push(`missing required input '${name}'`);
        continue;
      }
      continue;
    }

    if (inputType === "number") {
      const num = Number(raw);
      if (Number.isNaN(num)) {
        errors.push(`input '${name}' expects a number, got '${raw}'`);
        continue;
      }
      values[name] = num;
    } else if (inputType === "boolean") {
      const lower = raw.toLowerCase();
      if (lower === "true" || lower === "1" || lower === "yes") {
        values[name] = true;
      } else if (lower === "false" || lower === "0" || lower === "no") {
        values[name] = false;
      } else {
        errors.push(`input '${name}' expects a boolean (true/false), got '${raw}'`);
      }
    } else {
      values[name] = raw;
    }
  }

  for (const key of Object.keys(params)) {
    if (!(key in specInputs)) {
      errors.push(`unknown input '${key}' (not declared in workflow inputs)`);
    }
  }

  return { values, errors };
}
