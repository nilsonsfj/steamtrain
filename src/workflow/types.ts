import { z } from "zod";
import type { AgentInstanceId, TokenUsage } from "../types/events";
import type { RetryPolicy } from "./retry";
import type { JsonSchema } from "./structured";

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
  | "merge"
  | "command";

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

export interface GateCondition {
  /** Step whose result is inspected; omitted means inspect the workflow input. */
  step?: string;
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

export type WorkflowStep =
  | WorkerStep
  | DistributorStep
  | ConsolidatorStep
  | GateStep
  | MergeStep
  | CommandStep;

export interface WorkflowPhase {
  id: string;
  title: string;
  /** Steps run in parallel within the phase. */
  steps: WorkflowStep[];
}

export interface WorkflowSpec {
  /** Launch name; unique among available workflows. */
  name: string;
  description?: string;
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
}

/** Total steps a single run may contain (matches the dynamic-workflows cap). */
export const MAX_STEPS = 1000;
/** Hard ceiling on parallel agents; the configured value is clamped to this. */
export const MAX_CONCURRENCY = 16;
/** Default per-loop iteration cap when a loop gate omits `maxIterations`. */
export const DEFAULT_LOOP_MAX_ITERATIONS = 10;
/** Hard ceiling on a loop gate's `maxIterations` (runaway backstop). */
export const LOOP_MAX_ITERATIONS_CEILING = 100;

const agentId = z
  .string()
  .min(1)
  .describe("Configured agent instance id; validated at run time via resolveAgentInstance");

const gateConditionSchema = z
  .object({
    step: z.string().min(1).optional(),
    ok: z.boolean().optional(),
    path: z.string().min(1).optional(),
    contains: z.string().optional(),
    matches: z.string().optional(),
    equals: z.string().optional(),
    not: z.boolean().optional(),
  })
  .superRefine((condition, ctx) => {
    if (
      condition.ok === undefined &&
      condition.contains === undefined &&
      condition.matches === undefined &&
      condition.equals === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "gate condition requires ok, contains, matches, or equals",
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

const workflowStepSchema = z.union([
  workflowGateStepSchema,
  workflowDistributorStepSchema,
  workflowConsolidatorStepSchema,
  workflowMergeStepSchema,
  workflowCommandStepSchema,
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
      if ((step.kind === "worker" || step.kind === "processor" || !step.kind) && step.forEach) {
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
        if (sourceStep?.kind !== "distributor") {
          return {
            ok: false,
            error: `step '${step.id}' forEach source '${sourceStepId}' must be a distributor step`,
          };
        }
        maxPossibleSteps += sourceStep.items?.length ?? 0;
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

  return { ok: true };
}
