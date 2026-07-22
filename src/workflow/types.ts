import { z } from "zod";
import type { AgentInstanceId, ApiInstanceId, TokenUsage } from "../types/events";
import { type WorkflowInputType, isStringLikeInputType, workflowInputType } from "./input-params";
import type { ModelFailoverPolicy } from "./model-failover";
import type { RetryPolicy } from "./retry";
import {
  type AgentBackedWorkflowStep,
  MAX_WORKFLOW_NESTING_DEPTH,
  isAgentBackedStep,
  workflowStepKind,
} from "./step-kind";
import type { JsonSchema } from "./structured";
// Circular import is safe: template.ts imports types from this module, and this
// module imports lintTemplateRefs from template.ts. Both modules are fully
// initialized before any cross-referenced function is called at runtime.
import { lintTemplateRefs } from "./template";

export type { WorkflowInputType } from "./input-params";
export { WORKFLOW_INPUT_TYPES, workflowInputType, isStringLikeInputType } from "./input-params";

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
  | "human"
  | "merge"
  | "command"
  | "llm"
  | "workflow"
  | "issues";

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
  /**
   * Agent instance to spawn. Optional when `model` or `modelClass` is set —
   * steamtrain then picks the best ready agent that can provide that model
   * (preferring the model's reference agent).
   */
  agent?: AgentInstanceId;
  /**
   * Model string — either an agent-native id (`claude-opus-4-8`,
   * `opencode/claude-opus-4-8`) or a cross-agent alias (`opus 4.8`).
   * Optional when `modelClass` is set.
   */
  model?: string;
  /**
   * Role-based model class (`thinker` | `ultrathinker` | `implementer` |
   * `reviewer` | `deep-reviewer` | `simple` | `balanced`).
   * Resolved to a concrete family then to a ready agent+model at run time.
   */
  modelClass?:
    | "thinker"
    | "ultrathinker"
    | "implementer"
    | "reviewer"
    | "deep-reviewer"
    | "simple"
    | "balanced";
  /**
   * Ordered failover model queries tried when the primary binding's agent
   * becomes unavailable (or when a transient provider failure triggers
   * model failover on retry). Each entry accepts the same forms as `model`.
   */
  fallbackModels?: string[];
  /**
   * Per-step mid-flight model failover policy (overrides the workflow /
   * project `modelFailover` default). Controls whether quota / rate-limit /
   * transient failures walk `fallbackModels` instead of ruining the run.
   */
  modelFailover?: ModelFailoverPolicy;
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
   * `"attach:<stepId>"` — run this step INSIDE the named earlier step's own
   * worktree instead: no copy, no new branch. Where `inherit` forks a new
   * worktree from the source's state (so a later edit in the forked copy never
   * reaches the source or any sibling that also inherited from it), `attach`
   * shares the ONE worktree, so a chain of attachers actually converges — the
   * canonical shape for an implement → review → fix → test loop where fix's
   * edits must be visible to the next review. `result.worktree` records the
   * SAME root/branch/baseCommit as the source (and the source's
   * `linkedIgnoredPaths`), so templates, `history show --diff`, and `merge`
   * all see it as if this step WAS the source, worktree-wise.
   *
   * Either way the source becomes an implicit dependency: this step is
   * scheduled after it, skips when it was skipped, and fails when it failed.
   * The source must be a worker/processor/command step without `forEach` (a
   * fan-out parent has many worktrees — merge them first) or a `merge` step
   * with `mode: "worktree"` (attaching to an `apply`/`branch`/`pr` merge is
   * rejected — those deliver, they don't leave a worktree). Outside a git
   * repository steps share the plain cwd, so inheritance/attachment is
   * trivially satisfied.
   *
   * `attach` additionally requires STRICT ordering: every step attaching to
   * the same underlying worktree (directly, or transitively through a chain
   * of attachers) must, in spec order, be reachable from the previous one via
   * `dependsOn` (counting implicit workspace/session/forEach deps) — two
   * steps must never run concurrently in one worktree. Validation rejects
   * unordered co-attachers by name. A step with `workspace: "attach:…"` may
   * not itself have `forEach` (fan-out children would race in the one
   * worktree).
   *
   * Merging an inherited or attached worktree lands the whole chain's
   * changes: its diff base stays the original base commit, so it includes the
   * upstream edits plus this step's own.
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
   * `"continue:<stepId>"` — opt-in agent session continuity: resume the named
   * earlier step's recorded agent CLI session (claude `--resume`, opencode
   * `--session`, codex `exec resume`) instead of starting a clean-room
   * conversation, so this step inherits everything the source conversation
   * already established (files read, decisions made, unstated context).
   *
   * The source becomes an implicit dependency (scheduled after it, skipped
   * when it was skipped, failed when it failed) and must be an agent-backed
   * step on the SAME agent instance in an earlier phase — sessions belong to
   * one CLI. Neither side may be a `forEach` fan-out (a parent has one session
   * per child; children resuming one session concurrently would corrupt it),
   * and each source may be continued by at most one step — sibling continuers
   * could race on one recorded session; chain them linearly instead.
   *
   * `"continue:<ownId>"` (self) is the loop form: each `loopTo` iteration
   * resumes the session this step recorded on the previous pass — the
   * canonical "same fixer, every iteration" pattern. The first iteration has
   * no prior session and starts fresh. Self-continuation requires the step to
   * be inside a loop region.
   *
   * The step FAILS (rather than silently degrading to a fresh session) when
   * the configured agent's adapter cannot resume sessions or the source
   * recorded no session id — prompts written for a continued conversation
   * make no sense in an empty one. Steps without this field keep today's
   * clean-room behavior. Recorded session lineage is validated on cache
   * replay: a cached result that resumed a session the source no longer has
   * re-runs instead of replaying stale output.
   */
  session?: string;
  /**
   * Dynamically fan this worker/processor out over prior distributor items.
   * Syntax: `steps.<id>.items` (or `<id>.items`).
   */
  forEach?: string;
  /**
   * Opt-in agent clarifying questions: the engine tells the agent it may end
   * its reply with a single `QUESTION: …` line instead of guessing when it is
   * genuinely blocked. When it does, the step pauses, the question surfaces
   * through the same human-input channel as `human` steps (TUI card, web form,
   * `--human <stepId>=<answer>` headless, `workflow answer` for detached
   * runs), and the agent continues with the answer — resuming its recorded
   * session where the adapter supports it (claude), otherwise re-running with
   * the question and answer appended to the original prompt. Bounded to one
   * question per step (per attempt chain), so a chatty agent can't turn a
   * pipeline into a conversation. Marks the workflow "interactive" for
   * autonomy labeling.
   */
  canAsk?: boolean;
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
  modelClass?:
    | "thinker"
    | "ultrathinker"
    | "implementer"
    | "reviewer"
    | "deep-reviewer"
    | "simple"
    | "balanced";
  fallbackModels?: string[];
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
  modelClass?:
    | "thinker"
    | "ultrathinker"
    | "implementer"
    | "reviewer"
    | "deep-reviewer"
    | "simple"
    | "balanced";
  fallbackModels?: string[];
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
 *  - `"worktree"`: merge into a KEPT staging worktree (same base directory /
 *    naming convention as ordinary step worktrees, so it survives like any
 *    other and is found by the usual prune/GC paths) instead of delivering
 *    anywhere — nothing lands in the user's checkout. The step's own
 *    `result.worktree` records it (`root`, `branch`, `baseCommit` = the
 *    pre-merge target HEAD), so a later step can `workspace: "attach:<this
 *    step>"` (or `inherit:`) to keep working on the merged state, and a
 *    LATER merge step can list this one (or anything attached to it) in
 *    `from` to harvest it like any agent step's worktree. `perSource` is
 *    rejected with this mode (one kept worktree is the point).
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
  mode?: "apply" | "branch" | "pr" | "worktree";
  /** Branch name template for branch/pr modes; generated when omitted. */
  branch?: string;
  /** One branch/PR per source worktree instead of one combined merge (branch/pr modes only). */
  perSource?: boolean;
  /**
   * Prune the source worktrees and their steamtrain branches after a
   * successful delivery — the delivered result (applied diff, merged branch,
   * PR) becomes the single durable copy. Later steps can no longer inherit or
   * re-merge the cleaned worktrees, and `history apply/show --diff` for them
   * will report the worktrees as gone.
   */
  cleanup?: boolean;
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
  modelClass?:
    | "thinker"
    | "ultrathinker"
    | "implementer"
    | "reviewer"
    | "deep-reviewer"
    | "simple"
    | "balanced";
  fallbackModels?: string[];
  effort?: string;
  /** Extra guidance appended to the built-in conflict-resolution prompt. */
  prompt?: string;
  env?: Record<string, string>;
  extraArgs?: string[];
  stepTimeoutSec?: number;
}

/**
 * Building block 6 — documents out-of-scope findings as GitHub issues or as a
 * report. Agentless, costless, worktree-free: it reads structured `json`
 * findings arrays that earlier steps already declared via an `output` schema,
 * so it participates in any workflow without a dedicated "findings" step kind
 * upstream.
 *
 * **Collection**: walks each `from` source (default `dependsOn`), descending
 * ONE level into `childResults` leaves (fan-out children, sub-workflow
 * surfaces) — mirroring {@link MergeStep}'s leaf judgment exactly: a
 * skipped/not-run leaf contributes nothing, a failed leaf fails the whole
 * step (a partial findings report from a failed pipeline would be
 * misleading), and a step carrying its own top-level `childResults` alongside
 * a `worktree`/`json` is still treated as one leaf (guards the same future
 * shape `executeMergeStep` guards). From each surviving leaf, `json` is read
 * at `findingsPath` (default `"findings"`); a leaf with no structured output,
 * or nothing at that path, contributes nothing — that's the common case (a
 * clean run has no findings), not an error.
 *
 * **Finding shape**: the array at `findingsPath` may contain plain strings
 * (treated as titles) or objects (`title` required; `body`, `severity`,
 * `file`, `line` optional). An object with no usable string `title` is
 * malformed — counted and reported, not fatal.
 *
 * **Dedupe**: case-insensitive normalized `title` + `file` fingerprint across
 * every source, so the same pre-existing bug spotted by two streams files
 * once.
 *
 * **`mode: "report"`** (default, zero side effects): a severity-ordered
 * markdown report (critical > high > medium > low > unknown, unrecognized
 * severities sorted last but shown verbatim); `json` =
 * `{ findings, created: [], skippedExisting: [] }`.
 *
 * **`mode: "github"`** (side-effectful): creates one issue per finding (up to
 * `limit`) via `gh issue create` — title = `titlePrefix` + the finding title,
 * body = the finding body plus a provenance block (workflow, source step,
 * `file:line`, severity), `--label` per entry in `labels`, `-R repo` when
 * set. Before creating, checks for an existing issue with the same
 * (case-insensitive, exact-normalized) title via `gh issue list --search`
 * (state all) and records a match in `skippedExisting` instead of creating a
 * duplicate. `gh` missing from PATH, or a `gh` failure (commonly missing
 * auth), fails the step with copy-paste guidance. `gh` runs from the run's
 * base cwd. The result carries `noCache: true` — like an approval checkpoint,
 * a resumed run must re-run it rather than replay a stale "created" list that
 * no longer matches GitHub's state.
 *
 * `mode` and `titlePrefix` are templates (rendered with the step's standard
 * context); `mode` is validated ∈ `{"report", "github"}` AFTER rendering, so
 * one spec can switch modes via `{{inputs.issueMode}}`.
 *
 * No agent, no worktree: never a `workspace: "inherit:"/"attach:"` source, and
 * autonomy-neutral (it never pauses for a human).
 */
export interface IssuesStep extends WorkflowStepBase {
  kind: "issues";
  /** Steps whose findings to collect; defaults to `dependsOn`. */
  from?: string[];
  /** JSON path into each source's `json` where the findings array lives. Default `"findings"`. */
  findingsPath?: string;
  /** `"report"` (default, safe) or `"github"` (creates issues). Template, validated after rendering. */
  mode?: string;
  /** Prepended to each created issue's title (github mode). Template. */
  titlePrefix?: string;
  /** `--label` flags applied to every created issue (github mode). */
  labels?: string[];
  /** `-R owner/name` target repo for `gh` (github mode); omitted ⇒ the run's cwd repo. */
  repo?: string;
  /** Max issues created before truncating (github mode). Default 20. */
  limit?: number;
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
  /**
   * Template rendered to become the child run's `{{input}}`. Omitted ⇒ this
   * run's own `{{input}}` passes through unchanged. Inside `forEach`, `{{item}}`
   * is available alongside the parent's own template context.
   */
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
  /**
   * Dynamically fan this workflow call out over prior distributor/llm-splitter
   * items — one whole child run per item, mirroring worker/llm `forEach`.
   * Syntax: `steps.<id>.items` (or `<id>.items`). Each generated child run's
   * own steps fold in under `<stepId>[i]::<childStepId>` (extending the plain
   * `<stepId>::<childStepId>` namespace with the per-item fan-out suffix so two
   * items' inner steps never collide), and `{{item}}` / `{{item.index}}` are
   * available in `input` and `params` templates. The parent result's
   * `childResults` holds one entry per item (each itself carrying its own
   * nested `childResults`); the parent is `ok` only when every item's child run
   * completed successfully — see {@link WorkerStep.forEach} for the shared
   * fan-out semantics (concurrency, budget, cache/resume).
   */
  forEach?: string;
  /**
   * Templated values passed as the child run's declared input parameters. Each
   * value is rendered with the parent's template context (including `{{item}}`
   * under `forEach`), then validated against the child spec's own `inputs` via
   * `resolveInputs` — unknown-param and missing-required errors surface
   * exactly like CLI `--param` errors and fail this step with the child's own
   * error text.
   */
  params?: Record<string, string>;
  /**
   * Id of a child step whose recorded worktree surfaces as THIS step's own
   * `result.worktree` — the sub-workflow analog of a worker/processor/command
   * step's own worktree. Resolved at run time (like `outputStep`); an unknown
   * child step id, or a child step that recorded no worktree, fails this step
   * with a clear error. Under `forEach`, each generated child's result carries
   * its own surfaced worktree, so a `merge` step whose `from` names the
   * fan-out parent harvests one worktree per item. A `workflow` step WITH
   * `worktreeStep` and WITHOUT `forEach` is a valid `workspace:
   * "inherit:<stepId>"` / `"attach:<stepId>"` source (see
   * {@link WorkspaceFields.workspace}) and a valid `merge` `from` source,
   * exactly like a worker/processor/command step.
   */
  worktreeStep?: string;
  /**
   * Per-child-step agent-field overrides applied to the resolved child spec at
   * run time — the mechanism by which the parent's model/agent/effort choices
   * (`/set-all`, per-step retargeting, the config modal) reach INTO a
   * sub-workflow instead of stopping at its boundary. The child workflow spec
   * on disk is never mutated (it may be shared by many parents); these patches
   * are layered on top only for this call site.
   *
   * Keys are child step ids. A key MAY be `::`-namespaced to reach a step
   * inside a nested sub-workflow of the child (`<childWorkflowStepId>::<deeperStepId>`,
   * recursively) — the same namespacing the run history and live view already
   * use, so a target selected in a flattened tree round-trips to exactly the
   * step it names. Values are the same partial agent-field patches
   * (`agent`/`model`/`modelClass`/`effort`/`prompt`/…) session overrides carry
   * elsewhere; a value of `null` for a field removes it.
   *
   * Applied via the namespace-aware `applyWorkflowStepOverrides` in
   * `executeWorkflowCallOnce` (see engine.ts): plain keys patch the child's own
   * steps; namespaced keys are routed onto the matching child `workflow` step's
   * own `overrides`, so a single flat map cascades to arbitrary depth.
   */
  overrides?: Record<string, AgentFieldOverridePatch>;
}

/**
 * A partial agent-field patch where each field may also be `null` to mean
 * "remove this field" (vs. `undefined`/absent, which means "leave unchanged").
 * This is the value shape of both session overrides and a sub-workflow call
 * step's {@link WorkflowCallStep.overrides}. The key set is exactly the
 * retargetable agent fields (no `modelFailover`/`output`, which are not part of
 * the override surface), mirroring `workflowCallOverridePatchSchema`.
 */
export interface AgentFieldOverridePatch {
  agent?: AgentRunFields["agent"];
  model?: string | null;
  modelClass?: AgentRunFields["modelClass"] | null;
  fallbackModels?: string[] | null;
  prompt?: string | null;
  effort?: string | null;
  cwd?: string | null;
  env?: Record<string, string> | null;
  extraArgs?: string[] | null;
  stepTimeoutSec?: number | null;
  stepTimeoutMs?: number | null;
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
  /**
   * A templated text expression tested by the same `contains`/`matches`/
   * `equals` predicates, instead of a step output or the run input. Rendered
   * with the standard template context (inputs, step outputs, iteration) at
   * evaluation time. The canonical use is input-driven routing: `{ value:
   * "{{inputs.issueTiming}}", equals: "live" }`. Mutually exclusive with
   * `step`, `ok`, `path`, and `human`.
   */
  value?: string;
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

/**
 * Human-as-a-step (next-frontier §3): a step whose output a *person* supplies.
 * Where an `approval` step asks for consent (approve/reject), a `human` step
 * asks for *data* — paste the incident timeline, choose one of three proposed
 * designs, answer the question the pipeline can't answer itself. Downstream
 * steps consume `{{steps.<id>.output}}` (and `{{steps.<id>.json.<path>}}`
 * with an `output` schema) exactly like any other step's result.
 *
 * The rendered `prompt` (which may interpolate earlier step outputs) is shown
 * to the human. `choices` renders as pick-one; an `output` schema demands a
 * JSON reply validated against it; with neither, any non-blank text is
 * accepted. `choices` and `output` are mutually exclusive.
 *
 * Headless runs supply values up front via `--human <stepId>=<value|@file>`
 * (or fail fast with guidance); detached runs park until any attached UI
 * answers (`steamtrain workflow answer`). Accepted answers are cached — they
 * are data, so a resumed run replays them instead of re-asking.
 *
 * A workflow containing human steps is labeled "interactive" wherever
 * workflows are listed, so the autonomy cost is visible before launch.
 */
export interface HumanStep extends WorkflowStepBase {
  kind: "human";
  /** Instructions / the question shown to the human. Templated. */
  prompt: string;
  /** Pick-one choices (each templated). Mutually exclusive with `output`. */
  choices?: string[];
  /**
   * JSON schema (subset; see `structured.ts`) the reply must match; the parsed
   * value lands on `StepResult.json`. Mutually exclusive with `choices`.
   */
  output?: JsonSchema;
}

export type WorkflowStep =
  | WorkerStep
  | DistributorStep
  | ConsolidatorStep
  | GateStep
  | ApprovalStep
  | HumanStep
  | MergeStep
  | CommandStep
  | LlmStep
  | WorkflowCallStep
  | IssuesStep;

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
 *
 * Typed parameters unlock richer UIs: `model` and `agent` get catalog
 * autocomplete, `enum` renders as a fixed picker. A `model` input may also
 * declare `fallbackModels` so steps that use `model: "{{inputs.<key>}}"`
 * automatically inherit a quota / rate-limit failover chain — the run keeps
 * going when the primary model is exhausted.
 */
export interface WorkflowInputSpec {
  /**
   * Expected type (default `"string"`).
   * - `string` / `number` / `boolean` — classic typed params
   * - `model` — agent model id or friendly alias; UIs offer catalog autocomplete
   * - `agent` — configured agent instance id; UIs offer the agent picker
   * - `enum` — one of `choices` (required when type is `enum`)
   */
  type?: WorkflowInputType;
  /** Human-readable description shown in UIs and help text. */
  description?: string;
  /** Default value when the user omits this input. */
  default?: string | number | boolean;
  /**
   * Whether the user must supply a value. Defaults to `true` when `default`
   * is omitted, `false` when `default` is set.
   */
  required?: boolean;
  /**
   * Constrained set of allowed values. Required when `type` is `"enum"`.
   * Optional for `"string"` / `"model"` / `"agent"` to restrict the picker
   * (and reject other values at resolve time).
   */
  choices?: string[];
  /**
   * Ordered failover model queries used when a step's `model` template
   * references this input (`model: "{{inputs.<key>}}"`). On quota /
   * rate-limit / transient failures the engine walks these before the step's
   * and workflow's own `fallbackModels`, so picking a different primary at
   * run time does not strand the run without a safety net.
   *
   * Only valid when `type` is `"model"`.
   */
  fallbackModels?: string[];
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
  /**
   * Default mid-flight model failover policy for agent steps (per-step
   * `modelFailover` overrides). Project/user config `modelFailover` is the
   * next fallback. See {@link ModelFailoverPolicy}.
   */
  modelFailover?: ModelFailoverPolicy;
  /**
   * Default ordered failover model queries appended to every agent-backed
   * step's candidate chain (after the step's own `fallbackModels`). Lets a
   * workflow declare "if quota runs out, try these" once instead of on every
   * step.
   */
  fallbackModels?: string[];
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
  /**
   * Effective (rendered) model the step actually ran with. Set by `llm`
   * steps (see {@link StepResult.api}) AND by agent-backed steps
   * (worker/processor, agent-backed distributor/consolidator, merge
   * conflict-resolution agents) so a templated `model: "{{inputs.*}}"` is
   * attributed by its rendered value everywhere cost is broken down by model
   * (`cost.ts`'s `resultLeaves`/`recordLeaves`), not by the raw template text.
   */
  model?: string;
  /** Total attempts this step took (auto-retry); omitted/1 means it ran once. */
  attempts?: number;
  /**
   * Agent CLI session id captured from the step's final attempt (from the
   * adapter's `session_start` event). Enables session continuation: `canAsk`
   * answers resume the same conversation, `session: "continue:<stepId>"`
   * steps chain onto it, and `workflow takeover` drops a human into it
   * interactively.
   */
  sessionId?: string;
  /**
   * The session id a `session: "continue:<stepId>"` step actually resumed —
   * its lineage. Persisted with the cached result so a replay can verify the
   * source still carries the same session; a mismatch (the source re-ran and
   * recorded a fresh session) invalidates the cached entry instead of
   * replaying output produced from a conversation that no longer exists.
   */
  resumedSessionId?: string;
  /**
   * Clarifying question exchanges for a `canAsk` step: the agent asked, a
   * human answered, the step continued. Recorded so a steered step stays an
   * auditable record and UIs can badge it.
   */
  questions?: { question: string; answer: string; by?: string }[];
  /** Who supplied a `human` step's value (e.g. `"human:web"`, `"headless:--human"`). */
  suppliedBy?: string;
  /** Subprocess exit code, for `command` steps (`{{steps.<id>.exitCode}}`). */
  exitCode?: number;
  /** Declared artifacts snapshotted after the step succeeded. */
  artifacts?: StepArtifact[];
  /** Isolated git worktree metadata for agent-backed steps. */
  worktree?: AgentWorktreeInfo;
  /** Loop iteration this result belongs to (1-based); omitted ⇒ 1. */
  iteration?: number;
  /**
   * True when the step executed with a mid-run edit applied (its prompt/cmd/
   * model/effort was changed while the run was paused). The `step_edited`
   * events in the run record carry the patches; this flags the result so UIs
   * and history badge the steered step.
   */
  edited?: boolean;
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
// `MAX_WORKFLOW_NESTING_DEPTH`, `workflowStepKind`, `isAgentBackedStep`, and the
// `AgentBackedWorkflowStep` type live in the zod-free `./step-kind` leaf module
// (so the browser reducer bundle can use them without shipping zod) and are
// re-exported below for existing `from "./types"` / `from "../workflow"` importers.

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
    value: z.string().optional(),
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
        condition.value !== undefined ||
        condition.contains !== undefined ||
        condition.matches !== undefined ||
        condition.equals !== undefined;
      if (mechanical) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "gate condition human cannot be combined with ok/path/value/contains/matches/equals",
        });
      }
      return;
    }
    // A `value` condition tests a rendered template expression instead of a
    // step's output/ok state or the run input, so it is mutually exclusive
    // with the fields that pick THOSE subjects.
    if (condition.value !== undefined) {
      if (condition.step !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "gate condition value cannot be combined with step",
        });
      }
      if (condition.ok !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "gate condition value cannot be combined with ok",
        });
      }
      if (condition.path !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "gate condition value cannot be combined with path",
        });
      }
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

const modelClassSchema = z.enum([
  "thinker",
  "ultrathinker",
  "implementer",
  "reviewer",
  "deep-reviewer",
  "simple",
  "balanced",
]);

const agentRunShape = {
  agent: agentId.optional(),
  model: z.string().min(1).optional(),
  modelClass: modelClassSchema.optional(),
  fallbackModels: z.array(z.string().min(1)).min(1).optional(),
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
  modelClass: modelClassSchema.optional(),
  fallbackModels: z.array(z.string().min(1)).min(1).optional(),
  prompt: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string()).optional(),
  extraArgs: z.array(z.string()).optional(),
  effort: z.string().min(1).optional(),
  stepTimeoutSec: z.number().positive().optional(),
  stepTimeoutMs: z.number().positive().optional(),
  output: outputJsonSchema.optional(),
};

/** Shared binding rule: agent+model, model-only, modelClass-only, or agent+modelClass. */
function refineAgentBinding(
  step: {
    agent?: string;
    model?: string;
    modelClass?: string;
    prompt?: string;
  },
  ctx: z.RefinementCtx,
  options: { requirePrompt: boolean; label: string },
): void {
  const hasAgent = Boolean(step.agent);
  const hasModel = Boolean(step.model);
  const hasClass = Boolean(step.modelClass);
  if (!hasAgent && !hasModel && !hasClass) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${options.label} requires agent+model, model, or modelClass`,
    });
    return;
  }
  if (hasAgent && !hasModel && !hasClass) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${options.label} with agent requires model or modelClass`,
    });
  }
  if (options.requirePrompt && !step.prompt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${options.label} requires prompt`,
    });
  }
}

const workspaceShape = {
  workspace: z
    .string()
    .regex(/^(inherit|attach):.+$/, 'workspace must be "inherit:<stepId>" or "attach:<stepId>"')
    .optional(),
  artifacts: z.array(z.string().min(1)).min(1).optional(),
};

const workflowInputSpecSchema = z
  .object({
    type: z.enum(["string", "number", "boolean", "model", "agent", "enum"]).optional(),
    description: z.string().optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    required: z.boolean().optional(),
    choices: z.array(z.string().min(1)).min(1).optional(),
    fallbackModels: z.array(z.string().min(1)).min(1).optional(),
  })
  .superRefine((input, ctx) => {
    const type = input.type ?? "string";
    if (type === "enum" && (!input.choices || input.choices.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'input type "enum" requires a non-empty choices array',
        path: ["choices"],
      });
    }
    if (input.fallbackModels && type !== "model") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'fallbackModels is only valid on inputs with type "model"',
        path: ["fallbackModels"],
      });
    }
    if (input.choices && (type === "number" || type === "boolean")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `choices is not valid on inputs with type "${type}"`,
        path: ["choices"],
      });
    }
  });

const retryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10).optional(),
  initialDelayMs: z.number().int().min(0).max(60000).optional(),
  factor: z.number().min(1).max(10).optional(),
  maxDelayMs: z.number().int().min(0).max(600000).optional(),
  jitter: z.boolean().optional(),
});

const modelFailoverTriggerSchema = z.enum(["quota", "rate_limit", "transient", "auth", "any"]);

const modelFailoverPolicySchema = z
  .object({
    enabled: z.boolean().optional(),
    on: z.array(modelFailoverTriggerSchema).min(1).optional(),
    onCapacityResult: z.boolean().optional(),
    allowAfterToolUse: z.boolean().optional(),
    preferNextModel: z.boolean().optional(),
    failoverDelayMs: z.number().int().min(0).max(60000).optional(),
  })
  .strict();

const workflowWorkerStepSchema = z
  .object({
    ...baseStepShape,
    kind: z.enum(["worker", "processor"]).optional(),
    forEach: z.string().min(1).optional(),
    session: z
      .string()
      .regex(/^continue:.+$/, 'session must be "continue:<stepId>"')
      .optional(),
    retry: retryPolicySchema.optional(),
    modelFailover: modelFailoverPolicySchema.optional(),
    maxCostUsd: z.number().positive().optional(),
    canAsk: z.boolean().optional(),
    ...agentRunShape,
    ...workspaceShape,
  })
  .superRefine((step, ctx) => {
    refineAgentBinding(step, ctx, { requirePrompt: true, label: "worker step" });
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
    if (step.itemsPath && !((step.agent || step.model || step.modelClass) && step.output)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "distributor itemsPath requires an agent-backed step with an output schema",
      });
    }
    if (step.items) return;
    const hasBinding = Boolean(step.agent || step.model || step.modelClass);
    if (hasBinding) {
      refineAgentBinding(step, ctx, { requirePrompt: true, label: "distributor step" });
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "distributor step requires either non-empty items or an agent binding (agent+model, model, or modelClass) with prompt",
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
    const hasBinding = Boolean(step.agent || step.model || step.modelClass);
    if (hasBinding) {
      refineAgentBinding(step, ctx, { requirePrompt: true, label: "agent-backed consolidator" });
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

const workflowHumanStepSchema = z
  .object({
    ...baseStepShape,
    kind: z.literal("human"),
    prompt: z.string().min(1),
    choices: z.array(z.string().min(1)).min(1).optional(),
    output: outputJsonSchema.optional(),
  })
  .superRefine((step, ctx) => {
    // A pick-one and a JSON form at once is ambiguous — the reply can't be
    // both one of the choices and schema-shaped JSON.
    if (step.choices && step.output) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "human step choices and output are mutually exclusive",
      });
    }
  });

const workflowMergeStepSchema = z
  .object({
    ...baseStepShape,
    kind: z.literal("merge"),
    from: z.array(z.string().min(1)).min(1).optional(),
    mode: z.enum(["apply", "branch", "pr", "worktree"]).optional(),
    branch: z.string().min(1).optional(),
    perSource: z.boolean().optional(),
    cleanup: z.boolean().optional(),
    onConflict: z.enum(["fail", "ours", "theirs", "agent"]).optional(),
    commitMessage: z.string().min(1).optional(),
    prTitle: z.string().min(1).optional(),
    prBody: z.string().min(1).optional(),
    agent: agentId.optional(),
    model: z.string().min(1).optional(),
    modelClass: modelClassSchema.optional(),
    fallbackModels: z.array(z.string().min(1)).min(1).optional(),
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
    if (step.onConflict === "agent") {
      refineAgentBinding(step, ctx, {
        requirePrompt: false,
        label: 'merge step with onConflict "agent"',
      });
    } else if (step.agent || step.model || step.modelClass) {
      refineAgentBinding(step, ctx, {
        requirePrompt: false,
        label: "merge step conflict agent",
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
    // "worktree" mode's whole point is ONE kept staging worktree; perSource
    // would need one staging worktree per source, defeating it.
    if (step.perSource && step.mode === "worktree") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'merge step with perSource cannot use mode "worktree" (one kept worktree is the point)',
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

/**
 * Partial agent-field patch layered onto a sub-workflow's child step at run
 * time (see {@link WorkflowCallStep.overrides}). Every field is optional; a
 * field set to `null` removes it from the child step. The key set mirrors the
 * session-override agent fields — nothing here spawns structure, it only
 * retargets an existing step.
 */
const workflowCallOverridePatchSchema = z
  .object({
    agent: agentId.optional(),
    model: z.string().min(1).nullable().optional(),
    modelClass: modelClassSchema.nullable().optional(),
    fallbackModels: z.array(z.string().min(1)).min(1).nullable().optional(),
    prompt: z.string().min(1).nullable().optional(),
    effort: z.string().min(1).nullable().optional(),
    cwd: z.string().min(1).nullable().optional(),
    env: z.record(z.string()).nullable().optional(),
    extraArgs: z.array(z.string()).nullable().optional(),
    stepTimeoutSec: z.number().positive().nullable().optional(),
    stepTimeoutMs: z.number().positive().nullable().optional(),
  })
  .strict();

const workflowCallStepSchema = z.object({
  ...baseStepShape,
  kind: z.literal("workflow"),
  workflow: z.string().min(1),
  input: z.string().min(1).optional(),
  outputStep: z.string().min(1).optional(),
  forEach: z.string().min(1).optional(),
  params: z.record(z.string()).optional(),
  worktreeStep: z.string().min(1).optional(),
  overrides: z.record(workflowCallOverridePatchSchema).optional(),
});

const workflowIssuesStepSchema = z
  .object({
    ...baseStepShape,
    kind: z.literal("issues"),
    from: z.array(z.string().min(1)).min(1).optional(),
    findingsPath: z.string().min(1).optional(),
    mode: z.string().min(1).optional(),
    titlePrefix: z.string().min(1).optional(),
    labels: z.array(z.string().min(1)).optional(),
    repo: z.string().min(1).optional(),
    limit: z.number().int().positive().optional(),
  })
  .superRefine((step, ctx) => {
    if (!step.from?.length && !step.dependsOn?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "issues step requires from or dependsOn (the steps whose findings to collect)",
      });
    }
  });

const workflowStepSchema = z.union([
  workflowGateStepSchema,
  workflowApprovalStepSchema,
  workflowHumanStepSchema,
  workflowDistributorStepSchema,
  workflowConsolidatorStepSchema,
  workflowMergeStepSchema,
  workflowCommandStepSchema,
  workflowLlmStepSchema,
  workflowCallStepSchema,
  workflowIssuesStepSchema,
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
    modelFailover: modelFailoverPolicySchema.optional(),
    fallbackModels: z.array(z.string().min(1)).min(1).optional(),
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

/** A step's parsed `workspace` field: which mode, and which step it names. */
export interface WorkspaceRef {
  mode: "inherit" | "attach";
  sourceId: string;
}

/**
 * Parse a step's `workspace` field (`"inherit:<stepId>"` or
 * `"attach:<stepId>"`) into its mode and source step id, or undefined when
 * the step has no `workspace` field. See {@link WorkspaceFields.workspace}
 * for the semantic difference between the two modes.
 */
export function workspaceRef(step: WorkflowStep): WorkspaceRef | undefined {
  const workspace = "workspace" in step ? step.workspace : undefined;
  if (!workspace) return undefined;
  const match = /^(inherit|attach):(.+)$/.exec(workspace);
  if (!match) return undefined;
  return { mode: match[1] as "inherit" | "attach", sourceId: match[2] as string };
}

/**
 * The step id a `workspace: "inherit:<stepId>"` OR `"attach:<stepId>"` field
 * names, if any — mode-agnostic, for call sites that only care WHICH step is
 * the implicit dependency (scheduling, skip/fail cascade, template lint), not
 * how its worktree is used. Use {@link workspaceRef} where the mode matters.
 */
export function workspaceSourceId(step: WorkflowStep): string | undefined {
  return workspaceRef(step)?.sourceId;
}

/** The step id a `session: "continue:<stepId>"` field names, if any. */
export function sessionSourceId(step: WorkflowStep): string | undefined {
  const session = "session" in step ? step.session : undefined;
  if (!session) return undefined;
  return /^continue:(.+)$/.exec(session)?.[1];
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

// `isAgentBackedStep`, `workflowStepKind`, `AgentBackedWorkflowStep`, and
// `MAX_WORKFLOW_NESTING_DEPTH` are defined in the zod-free `./step-kind` module
// (imported at the top of this file) and re-exported here for existing
// `from "./types"` importers — see the note near the constants above.
export {
  MAX_WORKFLOW_NESTING_DEPTH,
  workflowStepKind,
  isAgentBackedStep,
  type AgentBackedWorkflowStep,
};

/**
 * Distinct agent ids a workflow's steps will spawn. Model-only / class-only
 * steps are omitted here (their agent is chosen at resolve time); use
 * {@link workflowNeedsAgentResolution} / dispatch-time resolution to gate them.
 */
export function workflowAgentIds(spec: WorkflowSpec): AgentInstanceId[] {
  const set = new Set<AgentInstanceId>();
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      if (isAgentBackedStep(step) && typeof step.agent === "string") set.add(step.agent);
    }
  }
  return [...set];
}

/** True when any agent-backed step omits a concrete agent (model/class binding). */
export function workflowNeedsAgentResolution(spec: WorkflowSpec): boolean {
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      if (!isAgentBackedStep(step)) continue;
      if (typeof step.agent !== "string") return true;
      if (typeof step.modelClass === "string") return true;
      if (step.fallbackModels && step.fallbackModels.length > 0) return true;
    }
  }
  return false;
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
      const inputType = workflowInputType(input);
      if (inputType === "enum" && (!input.choices || input.choices.length === 0)) {
        return {
          ok: false,
          error: `input '${name}' declares type "enum" but has no choices`,
        };
      }
      if (input.fallbackModels && inputType !== "model") {
        return {
          ok: false,
          error: `input '${name}' declares fallbackModels but type is "${inputType}" (only type "model" may declare fallbackModels)`,
        };
      }
      if (input.choices && (inputType === "number" || inputType === "boolean")) {
        return {
          ok: false,
          error: `input '${name}' declares choices but type is "${inputType}"`,
        };
      }
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
        if (isStringLikeInputType(inputType) && typeof input.default !== "string") {
          return {
            ok: false,
            error: `input '${name}' declares type "${inputType}" but default is not a string`,
          };
        }
        if (
          input.choices &&
          input.choices.length > 0 &&
          typeof input.default === "string" &&
          !input.choices.includes(input.default)
        ) {
          return {
            ok: false,
            error: `input '${name}' default '${input.default}' is not one of choices [${input.choices.join(", ")}]`,
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
  const stepPhaseIndex = new Map<string, number>();
  spec.phases.forEach((phase, pi) => {
    for (const step of phase.steps) {
      allIds.add(step.id);
      stepsById.set(step.id, step);
      stepPhaseIndex.set(step.id, pi);
    }
  });

  let maxPossibleSteps = spec.phases.reduce((n, p) => n + p.steps.length, 0);
  /** Steps whose `session` names themselves; validated against loop regions below. */
  const selfSessionSteps: string[] = [];
  /** source step id → the step already continuing it (one continuer per source). */
  const sessionContinuedBy = new Map<string, string>();
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
      if (step.kind === "issues") {
        for (const ref of step.from ?? []) {
          if (!earlierIds.has(ref)) {
            return {
              ok: false,
              error: allIds.has(ref)
                ? `issues step '${step.id}' from references '${ref}', which is not in an earlier phase`
                : `issues step '${step.id}' from references unknown step '${ref}'`,
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
          step.kind === "workflow" ||
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
      const sessionSrc = sessionSourceId(step);
      if (sessionSrc) {
        if ("forEach" in step && step.forEach) {
          return {
            ok: false,
            error: `step '${step.id}' cannot combine session with forEach (every fan-out child would resume the same session concurrently)`,
          };
        }
        if (sessionSrc === step.id) {
          // Self-continuation ("resume my own previous loop iteration") is
          // checked against loop regions below, once they are computed.
          selfSessionSteps.push(step.id);
        } else {
          if (!earlierIds.has(sessionSrc)) {
            return {
              ok: false,
              error: allIds.has(sessionSrc)
                ? `step '${step.id}' session continues '${sessionSrc}', which is not in an earlier phase`
                : `step '${step.id}' session continues unknown step '${sessionSrc}'`,
            };
          }
          const sourceStep = stepsById.get(sessionSrc);
          if (!sourceStep || !isAgentBackedStep(sourceStep)) {
            return {
              ok: false,
              error: `step '${step.id}' session continues '${sessionSrc}', which is not an agent-backed step (only agent steps record sessions)`,
            };
          }
          if ("forEach" in sourceStep && sourceStep.forEach) {
            return {
              ok: false,
              error: `step '${step.id}' session continues fan-out step '${sessionSrc}', which records one session per item (continue a non-forEach step, or a consolidator of the fan-out)`,
            };
          }
          if (
            isAgentBackedStep(step) &&
            typeof step.agent === "string" &&
            typeof sourceStep.agent === "string" &&
            sourceStep.agent !== step.agent
          ) {
            return {
              ok: false,
              error: `step '${step.id}' (agent '${step.agent}') session continues '${sessionSrc}' (agent '${sourceStep.agent}') — a session can only be continued on the same agent instance`,
            };
          }
          // One continuer per source: two steps resuming the same recorded
          // session could run concurrently (they need not depend on each
          // other) and corrupt it — the same hazard the forEach rules block.
          // Chains stay linear: continue the PREVIOUS link, not the root.
          const existing = sessionContinuedBy.get(sessionSrc);
          if (existing) {
            return {
              ok: false,
              error: `steps '${existing}' and '${step.id}' both continue session '${sessionSrc}' — a session can be continued by at most one step (chain them instead: continue the previous continuer)`,
            };
          }
          sessionContinuedBy.set(sessionSrc, step.id);
        }
      }
      const wsRef = workspaceRef(step);
      if (wsRef) {
        const wsSource = wsRef.sourceId;
        const verb = wsRef.mode === "attach" ? "attaches to" : "inherits";
        if (!earlierIds.has(wsSource)) {
          return {
            ok: false,
            error: allIds.has(wsSource)
              ? `step '${step.id}' workspace ${verb} '${wsSource}', which is not in an earlier phase`
              : `step '${step.id}' workspace ${verb} unknown step '${wsSource}'`,
          };
        }
        const sourceStep = stepsById.get(wsSource);
        const sourceKind = sourceStep ? workflowStepKind(sourceStep) : undefined;
        const isWorktreeStep =
          sourceKind === "worker" || sourceKind === "processor" || sourceKind === "command";
        // A `merge` step only leaves a worktree behind in `mode: "worktree"` —
        // apply/branch/pr deliver the merge and leave nothing to inherit or
        // attach to. A `workflow` call step WITH `worktreeStep` and WITHOUT
        // `forEach` surfaces a named child step's worktree as its own, so it
        // is eligible too — a fan-out `workflow` step has one worktree per
        // item, same hazard as a fan-out worker/processor/command step.
        const isWorktreeMerge =
          sourceKind === "merge" && (sourceStep as MergeStep).mode === "worktree";
        const isWorktreeWorkflow =
          sourceKind === "workflow" &&
          Boolean((sourceStep as WorkflowCallStep).worktreeStep) &&
          !(sourceStep as WorkflowCallStep).forEach;
        if (!isWorktreeStep && !isWorktreeMerge && !isWorktreeWorkflow) {
          return {
            ok: false,
            error: `step '${step.id}' workspace ${verb} '${wsSource}', which is a ${sourceKind} step (only worker, processor, and command steps — or a merge step with mode "worktree", or a workflow step with worktreeStep — leave a worktree to inherit or attach)`,
          };
        }
        if (isWorktreeStep && sourceStep && "forEach" in sourceStep && sourceStep.forEach) {
          return {
            ok: false,
            error: `step '${step.id}' workspace ${verb} fan-out step '${wsSource}', which has one worktree per item (merge them first, or ${wsRef.mode} a non-forEach step)`,
          };
        }
        if (wsRef.mode === "attach" && "forEach" in step && step.forEach) {
          return {
            ok: false,
            error: `step '${step.id}' cannot combine workspace attach with forEach (fan-out children would race in one worktree — merge or drop the forEach)`,
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

  // ---- Attach ordering validation ----
  // Two steps must never run concurrently in the same worktree, so every step
  // attaching to a given worktree must, in spec order, be strictly reachable
  // from the previous attacher (the first is reachable from the source by
  // construction — the source is always an implicit dependency). Reachability
  // is computed over `dependsOn` plus the SAME implicit deps the scheduler
  // adds (workspace/session/forEach sources; see `computeDependencies` in
  // engine.ts) — a lighter, validation-only mirror of that graph.
  {
    const immediateDeps = new Map<string, Set<string>>();
    for (const phase of spec.phases) {
      for (const step of phase.steps) {
        const set = new Set<string>(step.dependsOn ?? []);
        const wsSrc = workspaceSourceId(step);
        if (wsSrc) set.add(wsSrc);
        const sessSrc = sessionSourceId(step);
        if (sessSrc && sessSrc !== step.id) set.add(sessSrc);
        if ("forEach" in step && step.forEach) {
          const feSrc = parseForEachSource(step.forEach);
          if (feSrc) set.add(feSrc);
        }
        if (step.kind === "merge") {
          for (const ref of step.from ?? []) set.add(ref);
        }
        immediateDeps.set(step.id, set);
      }
    }

    // Is `toId` a (transitive) dependency of `fromId`?
    const reachable = (fromId: string, toId: string): boolean => {
      const seen = new Set<string>();
      const stack = [fromId];
      while (stack.length > 0) {
        const cur = stack.pop() as string;
        if (cur === toId) return true;
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const dep of immediateDeps.get(cur) ?? []) stack.push(dep);
      }
      return false;
    };

    // Follow a chain of `attach:`s to the ultimate non-attach worktree owner
    // (a worker/processor/command step, or a `mode: "worktree"` merge step).
    // Two steps attaching to different LINKS of the same chain still share
    // one worktree, so they must be grouped and ordered together.
    const ultimateOwner = (stepId: string): string => {
      const visited = new Set<string>();
      let current = stepId;
      while (!visited.has(current)) {
        visited.add(current);
        const s = stepsById.get(current);
        const ref = s ? workspaceRef(s) : undefined;
        if (ref?.mode !== "attach") return current;
        current = ref.sourceId;
      }
      return current; // defensive: a cycle shouldn't be reachable given phase ordering
    };

    const attachersByOwner = new Map<string, string[]>();
    for (const phase of spec.phases) {
      for (const step of phase.steps) {
        const ref = workspaceRef(step);
        if (ref?.mode !== "attach") continue;
        const owner = ultimateOwner(ref.sourceId);
        const list = attachersByOwner.get(owner) ?? [];
        list.push(step.id);
        attachersByOwner.set(owner, list);
      }
    }

    for (const [owner, attachers] of attachersByOwner) {
      for (let i = 1; i < attachers.length; i++) {
        const prev = attachers[i - 1] as string;
        const cur = attachers[i] as string;
        if (!reachable(cur, prev)) {
          return {
            ok: false,
            error: `steps '${prev}' and '${cur}' both attach to the worktree owned by '${owner}' but are not ordered — add 'dependsOn: ["${prev}"]' to '${cur}' (or reorder the phases) so they never run concurrently in the same worktree`,
          };
        }
      }
    }
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

  // A self-continuation only ever finds a previous session when a loop gate
  // re-runs the step's phase — outside a loop region it would silently start
  // fresh on every run, which is never what the author meant.
  for (const stepId of selfSessionSteps) {
    const pi = stepPhaseIndex.get(stepId);
    const inLoop =
      pi !== undefined && regions.some((region) => region.start <= pi && pi <= region.end);
    if (!inLoop) {
      return {
        ok: false,
        error: `step '${stepId}' session "continue:${stepId}" (self) requires the step to be inside a loop region (a later gate's loopTo range) — outside a loop there is no previous iteration to continue`,
      };
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
    const inputType = workflowInputType(input);
    const hasDefault = input.default !== undefined;
    const required = input.required ?? !hasDefault;
    const choices = input.choices;

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
      // string | model | agent | enum — all store as string
      if (inputType === "enum" && (!choices || choices.length === 0)) {
        errors.push(`input '${name}' declares type "enum" but has no choices`);
        continue;
      }
      if (choices && choices.length > 0 && !choices.includes(raw)) {
        errors.push(`input '${name}' expects one of [${choices.join(", ")}], got '${raw}'`);
        continue;
      }
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
