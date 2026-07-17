import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join as joinPath, resolve as resolvePath } from "node:path";
import { resolveAgentInstance } from "../agents";
import type { AgentAdapter } from "../agents";
import { llmStepApiId, resolveLlmStepApi } from "../apis/resolve";
import type { SteamtrainConfig } from "../config/types";
import type { AgentEvent, AgentInstanceId, AgentProviderId, TokenUsage } from "../types/events";
import {
  APPROVAL_DIFF_CAP,
  APPROVAL_OUTPUT_CAP,
  type ApprovalDecision,
  type ApprovalProvider,
  type ApprovalRejectDisposition,
  type ApprovalRequest,
  capApprovalText,
  noProviderApprovalDecision,
} from "./approval";
import { collectArtifacts } from "./artifacts";
import { runShellCommand } from "./command";
import type { StepEditPatch, WorkflowRunControl } from "./control";
import { addTokens } from "./cost";
import type { WorkflowEvent } from "./events";
import { mergeConflictGuidance } from "./gc";
import {
  HUMAN_INPUT_MAX_ATTEMPTS,
  HUMAN_INPUT_PROMPT_CAP,
  HUMAN_INPUT_VALUE_CAP,
  type HumanInputOrigin,
  type HumanInputProvider,
  type HumanInputRequest,
  type HumanInputResponse,
  capHumanInputText,
  noProviderHumanInputResponse,
  validateHumanInputValue,
} from "./human-input";
import { type LlmCallResult, type LlmComplete, type LlmProviderId, callLlm } from "./llm";
import {
  type ConflictResolver,
  type HarvestResult,
  MergeConflictError,
  type WorktreeDiff,
  type WorktreeSource,
  defaultHarvestBranchName,
  harvestWorktrees,
  pruneWorktree,
  worktreeDiff,
  worktreeSourceFromInfo,
} from "./merge";
import { createChannel, runPool } from "./pool";
import { type RetryPolicy, backoffDelayMs, resolveRetryPolicy } from "./retry";
import {
  type JsonSchema,
  jsonFieldText,
  jsonPathGet,
  parseStructuredOutput,
  structuredOutputFixPrompt,
  withStructuredOutputInstructions,
} from "./structured";
import { renderPrompt } from "./template";
import { resolveStepTimeoutSec, timeoutMsFromSec } from "./timeout";
import {
  type AgentBackedWorkflowStep,
  type AgentWorktreeInfo,
  type ApprovalStep,
  type CommandStep,
  DEFAULT_LOOP_MAX_ITERATIONS,
  type GateCondition,
  type GateStep,
  type HumanStep,
  type LlmPricing,
  type LlmStep,
  MAX_CONCURRENCY,
  MAX_STEPS,
  MAX_WORKFLOW_NESTING_DEPTH,
  type MergeStep,
  type StepResult,
  type WorkerStep,
  type WorkflowCallStep,
  type WorkflowItem,
  type WorkflowPhase,
  type WorkflowSpec,
  type WorkflowStep,
  isAgentBackedStep,
  parseForEachSource,
  sessionSourceId,
  validateWorkflow,
  workflowStepKind,
  workspaceSourceId,
} from "./types";
import { type AgentWorkspaceLease, type AgentWorkspaceManager, runGitText } from "./worktree";

/**
 * Everything the engine needs from the outside world. `createAdapter` is
 * injected (not imported) so tests can supply a fake adapter and the engine
 * never spawns a real CLI in a unit test.
 */
export interface WorkflowDeps {
  createAdapter: (id: AgentProviderId, binary?: string) => AgentAdapter;
  binaries?: Partial<Record<AgentProviderId, string>>;
  agentConfig?: SteamtrainConfig;
  /** Config default per-agent subprocess timeout (seconds). */
  stepTimeoutSec?: number;
  maxConcurrency: number;
  /** Base cwd; a step's relative `cwd` resolves against this. */
  cwd: string;
  /** Optional per-agent workspace isolation. */
  agentWorkspace?: AgentWorkspaceManager;
  /**
   * Directory declared step artifacts are snapshotted into (one subdirectory
   * per step). Defaults to a fresh per-run directory under the OS tmpdir, the
   * same lifetime story as the step worktrees themselves.
   */
  artifactsDir?: string;
  /** Default per-loop iteration cap; a gate's own `maxIterations` overrides it. */
  loopMaxIterations?: number;
  /**
   * Resolves a `workflow`-kind step's `workflow` name to its spec, e.g. via
   * an already-loaded catalog (`Record<string, WorkflowSpec>` lookup).
   * Injected (not imported from `catalog.ts`) so the engine stays decoupled
   * from filesystem/home-dir concerns and unit-testable with fakes. Omitted
   * ⇒ any `workflow` step fails immediately with a clear "not supported in
   * this context" error rather than crashing.
   */
  resolveWorkflow?: (name: string) => WorkflowSpec | undefined;
  /**
   * Completion transport for `llm` steps. Injected (not imported) so tests can
   * supply a fake and never touch the network; defaults to the fetch-based
   * {@link callLlm}.
   */
  llmComplete?: LlmComplete;
  /**
   * Resolves a human-approval checkpoint (an `approval` step or a `gate` with
   * `condition.human`). Injected per surface: the TUI resolves on a keypress,
   * the web UI on a `POST /api/runs/:id/approval`, the headless CLI immediately
   * from `--approve-all` / `--on-approval`. Omitted ⇒ the engine rejects every
   * checkpoint with its own disposition (see {@link noProviderApprovalDecision})
   * rather than hanging.
   */
  requestApproval?: ApprovalProvider;
  /**
   * Resolves a pending human-input request (a `human` step, or a `canAsk`
   * agent step's clarifying question). Injected per surface: the TUI resolves
   * from an inline answer box, the web UI on a `POST /api/runs/:id/input`, the
   * headless CLI immediately from `--human <stepId>=<value>` values. Omitted ⇒
   * the engine cancels every request with guidance (see
   * {@link noProviderHumanInputResponse}) rather than hanging.
   */
  requestHumanInput?: HumanInputProvider;
  /**
   * Mid-run steering handle (pause / edit pending steps / resume). Injected per
   * run by the driver; the engine binds validation hooks at run start, stops
   * scheduling new steps while a pause is requested, and applies accepted step
   * edits when the edited step executes. Omitted ⇒ the run is not steerable.
   * Deliberately NOT forwarded into `workflow`-step child runs: a sub-run
   * behaves like one in-flight step, so a pause waits for it to finish.
   */
  control?: WorkflowRunControl;
}

export interface WorkflowRunContext {
  /** The user's prompt; available to steps as `{{input}}` / `{{args}}`. */
  input: string;
  /**
   * Resolved workflow input parameters, available to steps as
   * `{{inputs.<key>}}`. Values are already validated and type-coerced by the
   * caller (e.g. via `resolveInputs`).
   */
  inputs?: Record<string, string | number | boolean>;
  /**
   * In-session cache of completed step results. Successful steps are stored
   * here; on a re-run they replay without spawning, which is how a cancelled
   * run resumes. Pass the same Map across runs to enable resume.
   */
  cache?: Map<string, StepResult>;
  /**
   * Names of workflows currently being invoked in the call stack that led to
   * this run (outermost first). Only ever set internally, when a `workflow`
   * step recurses into `runWorkflow` for a child spec — used to detect
   * cycles (A invokes B invokes A) and to enforce
   * `MAX_WORKFLOW_NESTING_DEPTH`. Callers starting a top-level run should
   * never set this.
   */
  workflowCallStack?: string[];
}

/**
 * Shared mutable state one run's schedulers and step executions operate on.
 * Built once per {@link runWorkflow} call and threaded through both scheduling
 * strategies so the per-step execution logic is identical in each.
 */
interface RunEnv {
  spec: WorkflowSpec;
  ctx: WorkflowRunContext;
  deps: WorkflowDeps;
  signal?: AbortSignal;
  cache: Map<string, StepResult>;
  outputs: Map<string, string>;
  results: Map<string, StepResult>;
  allResults: StepResult[];
  /**
   * Latest agent CLI session id each step recorded, feeding
   * `session: "continue:<stepId>"` resolution. Deliberately NOT cleared by a
   * loop jump's `invalidateRegion` (unlike `results`): a self-continuing step
   * reads its own previous iteration's session from here. Entries are
   * overwritten — or removed, when a re-run recorded no session — as each
   * step's result lands, so a source that re-ran fresh is never resumed stale.
   */
  sessions: Map<string, string>;
  limit: number;
  /** Resolved per-run artifact snapshot directory. */
  artifactsDir: string;
  /** Dynamic (forEach child) step budget; see the resync note in the phased scheduler. */
  budget: { generated: number };
  reserveDynamicSteps: (count: number) => boolean;
  /**
   * Running total of leaf-step spend (USD) for workflow-level `maxCostUsd`
   * enforcement. Fan-out children add their own cost as they settle; the parent
   * (whose cost is the sum of its children) adds nothing to avoid double-count.
   */
  spent: { costUsd: number };
  /** Latched once a cost budget stops scheduling, so `budget_exceeded` emits once. */
  budgetState: { exceeded: boolean };
  /**
   * Step ids that have begun executing (or replaying) in this run. Feeds the
   * mid-run edit validation — only steps that have not started may be edited.
   * A loop jump removes the re-run region's ids so its steps become editable
   * again during a pause between iterations.
   */
  startedSteps: Set<string>;
  /** Tracks the emitted pause state so `run_paused`/`run_resumed` fire once per transition. */
  pauseState: { acked: boolean };
}

/** What one step's completion means for its phase and for run control flow. */
interface StepFlags {
  /** The step failed in a way that should mark the phase (and run) not-ok. */
  notOk: boolean;
  /** A gate requested a halt: no step in a LATER phase may start. */
  stop: boolean;
}

/**
 * Execute a workflow as a single ordered stream of {@link WorkflowEvent}s.
 *
 * Scheduling: loop-free workflows are dependency (DAG) scheduled — a step
 * starts as soon as every step it depends on has finished (see
 * {@link computeEffectiveDeps} for what "depends on" includes), bounded by
 * `deps.maxConcurrency`. A step that omits `dependsOn` implicitly depends on
 * every step in all earlier phases, so phases act as barriers for it exactly
 * as they did before DAG scheduling. Workflows containing loop-back gates
 * (`loopTo`) run phase-by-phase, since a loop re-runs a contiguous range of
 * phases and its body must be complete before the gate re-checks convergence.
 *
 * Cached steps replay immediately. Aborting `signal` cancels in-flight steps
 * (their processes are killed) and ends the run.
 */
export async function* runWorkflow(
  spec: WorkflowSpec,
  ctx: WorkflowRunContext,
  deps: WorkflowDeps,
  signal?: AbortSignal,
): AsyncGenerator<WorkflowEvent> {
  const valid = validateWorkflow(spec, deps.loopMaxIterations);
  if (!valid.ok) throw new Error(`invalid workflow '${spec.name}': ${valid.error}`);

  const cache = ctx.cache ?? new Map<string, StepResult>();
  const outputs = new Map<string, string>();
  const results = new Map<string, StepResult>();
  const sessions = new Map<string, string>();
  for (const [id, res] of cache) {
    outputs.set(id, res.output);
    results.set(id, res);
    if (res.sessionId) sessions.set(id, res.sessionId);
  }

  const limit = Math.min(Math.max(1, deps.maxConcurrency), MAX_CONCURRENCY);
  const totalSteps = spec.phases.reduce((n, p) => n + p.steps.length, 0);
  const budget = { generated: countCachedDynamicSteps(cache) };
  const reserveDynamicSteps = (count: number): boolean => {
    if (budget.generated + count > MAX_STEPS - totalSteps) return false;
    budget.generated += count;
    return true;
  };
  yield {
    kind: "workflow_start",
    name: spec.name,
    phaseCount: spec.phases.length,
    stepCount: totalSteps,
    ts: Date.now(),
  };

  const env: RunEnv = {
    spec,
    ctx,
    deps,
    signal,
    cache,
    outputs,
    results,
    allResults: [],
    sessions,
    limit,
    artifactsDir:
      deps.artifactsDir ??
      joinPath(tmpdir(), "steamtrain-artifacts", randomBytes(5).toString("hex")),
    budget,
    reserveDynamicSteps,
    spent: { costUsd: costOfCachedResults(cache) },
    budgetState: { exceeded: false },
    startedSteps: new Set<string>(),
    pauseState: { acked: false },
  };

  deps.control?.attachRun({
    stepEditIssue: (stepId, patch) => stepEditIssue(env, stepId, patch),
    onEditAccepted: (stepId) => invalidateEditedStep(env, stepId),
  });

  const workflowOk = specHasLoopGates(spec)
    ? yield* runPhasedScheduler(env)
    : yield* runDagScheduler(env);

  // Drain any control events accepted in the final scheduling window so every
  // intervention lands in the record even when the run ends right after it.
  yield* drainControlEvents(env);

  // `allResults` accumulates one entry per step per loop iteration (a body
  // step that ran 3 passes has 3 entries, plus 3 intermediate "not yet
  // converged" gate results). Downstream consumers — the CLI/web run summary,
  // cost roll-ups — would otherwise double-count every intermediate pass. Keep
  // only the latest result per step id (the final state of each step); earlier
  // iterations were superseded by re-runs.
  const finalResults = new Map<string, StepResult>();
  for (const r of env.allResults) finalResults.set(r.stepId, r);

  yield {
    kind: "workflow_done",
    ok: workflowOk && !signal?.aborted && !env.budgetState.exceeded,
    results: [...finalResults.values()],
    budgetExceeded: env.budgetState.exceeded,
    ts: Date.now(),
  };
}

/** Sum leaf-step cost across cached results, so a resumed run counts prior spend. */
function costOfCachedResults(cache: Map<string, StepResult>): number {
  let total = 0;
  for (const result of cache.values()) {
    // A parent that carries children (a `forEach` fan-out or a `workflow`
    // sub-run) never has its own `costUsd` — the spend lives on the leaves in
    // `childResults`. Summing only the leaves here avoids double-counting the
    // wrapper against those leaves.
    if (result.childResults?.length) {
      for (const child of result.childResults) total += child.costUsd ?? 0;
    } else if (result.parentStepId === undefined) {
      total += result.costUsd ?? 0;
    }
  }
  return total;
}

/**
 * Latch and describe a workflow-level budget breach. Returns a one-shot
 * `budget_exceeded` event the first time accumulated spend reaches the cap, and
 * `undefined` afterwards (already latched) or when no cap is set / the cap isn't
 * reached yet. Once latched, `env.budgetState.exceeded` stays true so schedulers
 * stop launching new steps.
 */
function maybeWorkflowBudgetEvent(env: RunEnv): WorkflowEvent | undefined {
  const cap = env.spec.maxCostUsd;
  if (cap === undefined || env.spent.costUsd < cap) return undefined;
  if (env.budgetState.exceeded) return undefined;
  env.budgetState.exceeded = true;
  return {
    kind: "budget_exceeded",
    scope: "workflow",
    limitUsd: cap,
    spentUsd: env.spent.costUsd,
    ts: Date.now(),
  };
}

/** Yield any control events (accepted step edits) pending in the run's control. */
function* drainControlEvents(env: RunEnv): Generator<WorkflowEvent> {
  if (!env.deps.control) return;
  for (const event of env.deps.control.takeEvents()) yield event;
}

/**
 * Compare the control's requested pause state with what the run last emitted;
 * on a transition, latch it and return the one-shot `run_paused`/`run_resumed`
 * event. Returns undefined when nothing changed.
 */
function pauseTransitionEvent(env: RunEnv): WorkflowEvent | undefined {
  const control = env.deps.control;
  if (!control) return undefined;
  const requested = control.isPauseRequested();
  if (requested && !env.pauseState.acked) {
    env.pauseState.acked = true;
    return { kind: "run_paused", by: control.pauseRequestedBy(), ts: Date.now() };
  }
  if (!requested && env.pauseState.acked) {
    env.pauseState.acked = false;
    return { kind: "run_resumed", by: control.resumeRequestedBy(), ts: Date.now() };
  }
  return undefined;
}

/** Step kinds whose `prompt` field a mid-run edit may rewrite. */
const PROMPT_EDITABLE_KINDS: ReadonlySet<string> = new Set([
  "worker",
  "processor",
  "llm",
  "consolidator",
  "approval",
  "human",
]);

/**
 * Validate a mid-run edit against the live spec: the step must exist, must not
 * have started in this run, and every patched field must exist on its kind.
 * Returns the human-readable reason the edit is rejected, or undefined when it
 * is acceptable.
 */
function stepEditIssue(env: RunEnv, stepId: string, patch: StepEditPatch): string | undefined {
  let target: WorkflowStep | undefined;
  for (const phase of env.spec.phases) {
    target = phase.steps.find((step) => step.id === stepId);
    if (target) break;
  }
  if (!target) return `unknown step '${stepId}'`;
  if (env.startedSteps.has(stepId)) {
    return `step '${stepId}' has already started — only steps that have not run yet can be edited`;
  }
  const kind = workflowStepKind(target);
  const agentBacked = isAgentBackedStep(target);
  if (patch.prompt !== undefined) {
    const promptable = PROMPT_EDITABLE_KINDS.has(kind) || (kind === "distributor" && agentBacked);
    if (!promptable) return `step '${stepId}' (${kind}) has no editable prompt`;
    if (!patch.prompt.trim()) return "prompt must not be empty";
  }
  if (patch.cmd !== undefined) {
    if (kind !== "command") return `step '${stepId}' (${kind}) has no command to edit`;
    if (!patch.cmd.trim()) return "cmd must not be empty";
  }
  if (patch.model !== undefined || patch.effort !== undefined) {
    if (!agentBacked && kind !== "llm") {
      return `step '${stepId}' (${kind}) has no model/effort to edit`;
    }
    if (patch.model !== undefined && !patch.model.trim()) return "model must not be empty";
  }
  return undefined;
}

/**
 * Drop the stale cached state of a just-edited step (and its `forEach`
 * children) so the edited version actually executes instead of replaying a
 * result produced by the pre-edit spec.
 *
 * Transitive dependents that have NOT started are invalidated too: a resumed
 * run seeds the cache from disk, so a dependent may hold a cached result
 * computed from the pre-edit upstream output — replaying it would silently
 * keep the stale text. Steps that already ran in this run are left alone
 * (there is no rewind); a not-yet-started dependent simply re-executes
 * against the edited step's fresh output.
 */
function invalidateEditedStep(env: RunEnv, stepId: string): void {
  dropStepEntries(env, stepId);
  const deps = computeEffectiveDeps(env.spec);
  const invalidated = new Set([stepId]);
  // Fixed-point pass: cheap at spec scale, and only runs on a human edit.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, stepDeps] of deps) {
      if (invalidated.has(id)) continue;
      for (const dep of stepDeps) {
        if (!invalidated.has(dep)) continue;
        invalidated.add(id);
        changed = true;
        break;
      }
    }
  }
  for (const id of invalidated) {
    if (id === stepId || env.startedSteps.has(id)) continue;
    dropStepEntries(env, id);
  }
}

/**
 * Track the latest agent session a step's result carries: set on a recorded
 * session, removed when a (re)executed or replayed result recorded none — a
 * later `continue:` of that step must not resume a session from a superseded
 * pass. Only called for results that actually executed or replayed; skipped
 * and dependency-failed placeholders leave the last real session in place.
 */
function recordStepSession(sessions: Map<string, string>, result: StepResult): void {
  if (result.sessionId) sessions.set(result.stepId, result.sessionId);
  else sessions.delete(result.stepId);
}

/** Delete one step's cache/results/outputs entries, including `forEach` children. */
function dropStepEntries(env: RunEnv, stepId: string): void {
  const childPrefix = `${stepId}[`;
  for (const map of [env.cache, env.results]) {
    map.delete(stepId);
    for (const key of map.keys()) if (key.startsWith(childPrefix)) map.delete(key);
  }
  env.outputs.delete(stepId);
  for (const key of env.outputs.keys()) if (key.startsWith(childPrefix)) env.outputs.delete(key);
}

/** A shallow copy of `step` with an accepted mid-run edit applied. */
function applyStepEdit(step: WorkflowStep, patch: StepEditPatch): WorkflowStep {
  // The patch was validated against the step's kind when it was accepted
  // (see stepEditIssue), so assigning through a loose record shape is safe.
  const edited = { ...step } as WorkflowStep & Record<string, unknown>;
  if (patch.prompt !== undefined) edited.prompt = patch.prompt;
  if (patch.cmd !== undefined) edited.cmd = patch.cmd;
  if (patch.model !== undefined) edited.model = patch.model;
  // An empty-string effort clears the step's effort (back to the model default).
  if (patch.effort !== undefined) edited.effort = patch.effort || undefined;
  return edited;
}

/** Whether any gate in the spec is a loop-back gate (`loopTo`). */
function specHasLoopGates(spec: WorkflowSpec): boolean {
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      if (step.kind === "gate" && step.loopTo !== undefined) return true;
    }
  }
  return false;
}

/**
 * Phase-sequential scheduler, used for workflows with loop-back gates: phases
 * run one after another and the steps within a phase run in parallel. A loop
 * re-runs a contiguous phase range, which only makes sense when the range ran
 * to completion as a unit — so loop workflows keep the barrier model.
 * Returns whether the run is ok.
 */
async function* runPhasedScheduler(env: RunEnv): AsyncGenerator<WorkflowEvent, boolean> {
  const { spec, deps, signal, cache, results, limit } = env;
  // Failure accounting is per phase index, not a single latch: when a loop
  // gate jumps back, every failure inside the re-run region is superseded by
  // the next pass (a `command` step's failing tests are EXPECTED mid-loop) and
  // must not poison the final verdict if a later pass succeeds. Failures in
  // phases outside any jumped region stay recorded.
  const notOkPhases = new Set<number>();

  // Loop bookkeeping: gateId → { loopToIndex, gatePhaseIndex, iteration count so far }.
  const phaseIndexById = new Map<string, number>();
  spec.phases.forEach((p, i) => phaseIndexById.set(p.id, i));
  const loopState = new Map<
    string,
    { loopToIndex: number; gatePhaseIndex: number; iteration: number }
  >();
  spec.phases.forEach((phase, gatePhaseIndex) => {
    for (const step of phase.steps) {
      if (step.kind === "gate" && step.loopTo !== undefined) {
        const loopToIndex = phaseIndexById.get(step.loopTo);
        if (loopToIndex !== undefined) {
          loopState.set(step.id, { loopToIndex, gatePhaseIndex, iteration: 1 });
        }
      }
    }
  });
  const effectiveLoopMax = deps.loopMaxIterations ?? DEFAULT_LOOP_MAX_ITERATIONS;

  // Per-phase monotonic run counter: how many times phase index `pi` has
  // STARTED. Used (not the gate's own loop-iteration counter) as the
  // `iteration` event tag, so every (re)execution of a phase — at any
  // nesting depth — gets a unique tag. Never reset on a loop jump: that is
  // exactly what prevents an outer loop's re-run of an inner loop's body from
  // re-emitting iteration tags already used by a previous outer pass (which
  // would collide in the `phaseId+iteration`-keyed folds and overwrite
  // history/reducer state instead of appending to it).
  const phaseRunCount = new Map<number, number>();

  let pi = 0;
  while (pi < spec.phases.length) {
    const phase = spec.phases[pi];
    if (!phase) {
      pi++;
      continue;
    }
    // Re-sync the dynamic-step budget to the cache at the start of every phase.
    // `budget.generated` is otherwise a monotonic accumulator that only ever
    // grows, but `invalidateRegion` drops forEach children (ids like `step[n]`)
    // from the cache on a loop jump. Without this re-sync, each pass over a
    // forEach body re-reserves its N children and the budget accumulates N per
    // pass — so a forEach inside a loop falsely hits the MAX_STEPS cap after
    // enough iterations despite the live footprint never exceeding N. During
    // forward progress the cache only grows, so this is a no-op then; it only
    // releases budget that invalidation just freed.
    env.budget.generated = countCachedDynamicSteps(cache);

    // Cost budget: enforced at phase boundaries here (a loop workflow runs
    // phase-by-phase, so a phase is the scheduling unit). If prior phases have
    // already reached the cap, stop before starting this one — its steps never
    // dispatch, so raising the cap and resuming continues from here.
    const budgetEvent = maybeWorkflowBudgetEvent(env);
    if (budgetEvent) {
      yield budgetEvent;
      break;
    }

    // Mid-run steering: a loop workflow schedules phase-by-phase, so a pause
    // takes effect here, at the phase boundary — the running phase's steps
    // finish first. Park until resumed; a cancel unblocks the wait.
    yield* drainControlEvents(env);
    const pausedEvent = pauseTransitionEvent(env);
    if (pausedEvent) yield pausedEvent;
    if (deps.control) {
      while (deps.control.isPauseRequested() && !signal?.aborted) {
        await deps.control.waitForWake(signal);
        yield* drainControlEvents(env);
      }
      if (signal?.aborted) return false;
      const resumedEvent = pauseTransitionEvent(env);
      if (resumedEvent) yield resumedEvent;
    }

    const runs = (phaseRunCount.get(pi) ?? 0) + 1;
    phaseRunCount.set(pi, runs);
    const iteration = runs;

    yield {
      kind: "phase_start",
      phaseId: phase.id,
      title: phase.title,
      index: pi,
      stepCount: phase.steps.length,
      iteration,
      ts: Date.now(),
    };

    const channel = createChannel<WorkflowEvent>();
    let phaseOk = true;
    let stopAfterPhase = false;

    // runSingleStep never throws (it captures its own errors), so runPool never
    // rejects; the channel closes once every step in the phase settles.
    const poolDone = runPool(
      phase.steps,
      limit,
      async (step) => {
        const flags = await runSingleStep(step, phase, iteration, env, channel.push);
        if (flags.notOk) phaseOk = false;
        if (flags.stop) stopAfterPhase = true;
      },
      signal,
    ).finally(() => channel.close());

    for await (const ev of channel) yield ev;
    await poolDone;

    yield { kind: "phase_done", phaseId: phase.id, ok: phaseOk, iteration, ts: Date.now() };

    if (signal?.aborted) return false;

    // Loop-back decision: did this phase contain an unmet loop gate? A jump
    // means this pass — the whole region being re-run, not just the gate's
    // phase — is superseded, so its failures must NOT poison the verdict.
    const contended = findContendedLoopGate(phase, results, loopState, effectiveLoopMax);
    if (contended) {
      // The predicate found the gate; this is the only place its iteration
      // counter advances, keeping the decision (findContendedLoopGate) and the
      // mutation (increment + jump) as separate steps.
      const state = loopState.get(contended.gateId)!;
      state.iteration += 1;
      const loopToIndex = contended.loopToIndex;
      // invalidate cache + results for the region so the body re-runs
      invalidateRegion(spec, loopToIndex, pi, cache, results, env.startedSteps);
      // The outer loop is restarting a region that may contain other (inner)
      // loop gates; their iteration budgets must restart too, or the inner
      // loop would already be "exhausted" on the outer loop's 2nd+ pass.
      resetNestedLoops(loopState, loopToIndex, pi, contended.gateId);
      yield {
        kind: "loop_iteration",
        gateStepId: contended.gateId,
        loopTo: spec.phases[loopToIndex]?.id ?? "",
        iteration: state.iteration,
        maxIterations: contended.cap,
        ts: Date.now(),
      };
      // The jump re-runs [loopToIndex..pi]; failures recorded for phases in
      // that region belong to the superseded pass.
      for (let k = loopToIndex; k <= pi; k++) notOkPhases.delete(k);
      pi = loopToIndex;
      continue;
    }

    if (!phaseOk) notOkPhases.add(pi);
    if (stopAfterPhase) break;
    pi++;
  }

  return notOkPhases.size === 0;
}

/**
 * Dependency (DAG) scheduler, used for loop-free workflows: every step starts
 * the moment its effective dependencies have settled, bounded by the global
 * concurrency limit — a slow step no longer blocks unrelated steps in later
 * phases. Phases remain presentation/grouping: `phase_start` is emitted just
 * before a phase's first step starts and `phase_done` once all of its steps
 * settle, so phases may overlap in time.
 *
 * A failed stop/fail gate halts scheduling of every step in a LATER phase
 * (steps in the gate's own or earlier phases still run to completion, matching
 * the phase-sequential semantics). This is safe because every step in a later
 * phase carries an implicit control dependency on such gates — none of them
 * can already be running when the gate settles.
 *
 * Returns whether the run is ok.
 */
async function* runDagScheduler(env: RunEnv): AsyncGenerator<WorkflowEvent, boolean> {
  const { spec, signal, limit } = env;

  interface DagNode {
    step: WorkflowStep;
    phase: WorkflowPhase;
    phaseIndex: number;
    deps: ReadonlySet<string>;
  }
  const effectiveDeps = computeEffectiveDeps(spec);
  const pending: DagNode[] = [];
  spec.phases.forEach((phase, phaseIndex) => {
    for (const step of phase.steps) {
      pending.push({ step, phase, phaseIndex, deps: effectiveDeps.get(step.id) ?? new Set() });
    }
  });

  const phaseState = spec.phases.map((p) => ({
    started: false,
    remaining: p.steps.length,
    ok: true,
  }));
  const settled = new Set<string>();
  // Steps in phases strictly after this index are not scheduled (a stop/fail
  // gate at this index failed). Infinity ⇒ no halt.
  let haltAfterPhase = Number.POSITIVE_INFINITY;
  let workflowOk = true;

  const channel = createChannel<WorkflowEvent>();

  const launch = (node: DagNode, inFlight: Map<string, Promise<void>>): void => {
    const state = phaseState[node.phaseIndex]!;
    if (!state.started) {
      state.started = true;
      channel.push({
        kind: "phase_start",
        phaseId: node.phase.id,
        title: node.phase.title,
        index: node.phaseIndex,
        stepCount: node.phase.steps.length,
        iteration: 1,
        ts: Date.now(),
      });
    }
    const task = runSingleStep(node.step, node.phase, 1, env, channel.push)
      .then((flags) => {
        if (flags.notOk) {
          state.ok = false;
          workflowOk = false;
        }
        if (flags.stop) haltAfterPhase = Math.min(haltAfterPhase, node.phaseIndex);
      })
      .finally(() => {
        settled.add(node.step.id);
        inFlight.delete(node.step.id);
        state.remaining -= 1;
        if (state.remaining === 0) {
          channel.push({
            kind: "phase_done",
            phaseId: node.phase.id,
            ok: state.ok,
            iteration: 1,
            ts: Date.now(),
          });
        }
      });
    inFlight.set(node.step.id, task);
  };

  const control = env.deps.control;
  const driver = (async () => {
    const inFlight = new Map<string, Promise<void>>();
    while (true) {
      // A reached cost budget stops scheduling NEW steps; in-flight steps run to
      // completion, and any still-pending steps stay pending (recorded as
      // not-run), so raising the cap and resuming replays the cache and picks up
      // exactly where the budget stopped it.
      const budgetEvent = maybeWorkflowBudgetEvent(env);
      if (budgetEvent) channel.push(budgetEvent);
      // Mid-run steering: surface accepted edits, acknowledge pause/resume
      // transitions, and stop launching new steps while a pause is requested
      // (in-flight steps drain to completion, exactly like the budget stop).
      if (control) {
        for (const event of control.takeEvents()) channel.push(event);
        const transition = pauseTransitionEvent(env);
        if (transition) channel.push(transition);
      }
      const paused = control?.isPauseRequested() ?? false;
      if (!signal?.aborted && !env.budgetState.exceeded && !paused) {
        // Launch every ready step, scanning in spec order so ties dispatch
        // deterministically. Steps in phases beyond a halt stay pending
        // forever — the loop below exits once nothing is in flight.
        let i = 0;
        while (i < pending.length && inFlight.size < limit) {
          const node = pending[i]!;
          if (node.phaseIndex > haltAfterPhase || !isSubsetOf(node.deps, settled)) {
            i++;
            continue;
          }
          // Safe to mutate `pending` mid-scan: the driver is single-threaded
          // between awaits, so there are no concurrent readers, and the O(n)
          // splice is negligible at the ≤1000-step scale we schedule.
          pending.splice(i, 1);
          launch(node, inFlight);
        }
      }
      if (inFlight.size === 0) {
        // Quiesced while paused with work remaining: park until a resume (or
        // an accepted edit to surface, or a cancel) wakes the driver.
        if (paused && pending.length > 0 && !signal?.aborted && !env.budgetState.exceeded) {
          await control!.waitForWake(signal);
          continue;
        }
        break;
      }
      const waiters: Promise<unknown>[] = [...inFlight.values()];
      // While pausing, also wake on control changes so a resume immediately
      // relaunches instead of waiting for the next in-flight step to settle.
      if (control && paused) waiters.push(control.waitForWake(signal));
      await Promise.race(waiters);
    }
  })().finally(() => channel.close());

  for await (const ev of channel) yield ev;
  await driver;

  if (signal?.aborted) workflowOk = false;
  return workflowOk;
}

function isSubsetOf(subset: ReadonlySet<string>, superset: ReadonlySet<string>): boolean {
  for (const item of subset) {
    if (!superset.has(item)) return false;
  }
  return true;
}

/**
 * Matches `{{steps.<id>.<field>}}` template references; group 1 is the id.
 * Deliberately LOOSER than the renderer's field regexes (template.ts): this
 * only feeds dependency tracking, where over-matching a ref the renderer would
 * leave unresolved (e.g. a misspelled artifact name) merely adds a harmless
 * wait on the referenced step — don't tighten it to mirror the renderer.
 */
const TEMPLATE_STEP_REF =
  /\{\{\s*steps\.(.+?)\.(?:output|items|ok|error|target|iteration|exitCode|worktree\.(?:root|branch|cwd)|artifacts\.[^{}]+?|json(?:[.[][^{}]*)?)\s*\}\}/g;

function templateStepRefs(text: string | undefined): string[] {
  if (!text) return [];
  const refs: string[] = [];
  for (const match of text.matchAll(TEMPLATE_STEP_REF)) refs.push(match[1] as string);
  return refs;
}

/**
 * The step ids each step must wait for under DAG scheduling:
 *
 *  - its explicit `dependsOn` — or, when omitted, EVERY step in all earlier
 *    phases (the barrier default that preserves pre-DAG behavior);
 *  - implicit data references: a gate's `condition.step`, a `when` condition's
 *    `step`, a `forEach` source, and any `{{steps.<id>.…}}` template reference
 *    in prompts / distributor items / condition strings. Under the phase
 *    barrier these were always complete; scheduling on `dependsOn` alone would
 *    otherwise let them race and silently render as empty text;
 *  - implicit control dependencies: every stop/fail gate in an earlier phase.
 *    Later-phase steps must not start before such a gate decides whether the
 *    run halts.
 *
 * Referenced ids that are unknown (a typo'd template ref) or not in an earlier
 * phase are ignored — templates already render them as-is/empty, and the
 * validator has its own rules for the explicit fields. A `steps.work[3].…`
 * child reference resolves to its `work` parent.
 */
function computeEffectiveDeps(spec: WorkflowSpec): Map<string, Set<string>> {
  const idsByPhase = spec.phases.map((p) => p.steps.map((s) => s.id));
  const phaseIndexOf = new Map<string, number>();
  idsByPhase.forEach((ids, pi) => {
    for (const id of ids) phaseIndexOf.set(id, pi);
  });
  const controlGates: { id: string; phaseIndex: number }[] = [];
  spec.phases.forEach((phase, pi) => {
    for (const step of phase.steps) {
      // A human-approval checkpoint (approval step, or a gate with
      // `condition.human`) pauses the run: every later-phase step must wait for
      // the decision regardless of its reject disposition. Mechanical gates are
      // control deps only when they can halt (fail/stop).
      const isApprovalCheckpoint =
        step.kind === "approval" || (step.kind === "gate" && step.condition.human === true);
      if (
        isApprovalCheckpoint ||
        (step.kind === "gate" && (step.onFalse === "fail" || step.onFalse === "stop"))
      ) {
        controlGates.push({ id: step.id, phaseIndex: pi });
      }
    }
  });

  const deps = new Map<string, Set<string>>();
  spec.phases.forEach((phase, pi) => {
    for (const step of phase.steps) {
      const stepDeps = new Set<string>();
      const addEarlier = (ref: string | undefined): void => {
        if (!ref) return;
        // A namespaced sub-workflow child reference (`wf::child`) depends on
        // its owning `workflow` step; strip to the owner BEFORE the existing
        // forEach `[n]`-suffix stripping, so `wf::child[2]`-shaped refs (a
        // forEach step nested inside a sub-workflow) still resolve correctly.
        const owner = ref.includes("::") ? ref.slice(0, ref.indexOf("::")) : ref;
        // A `work[3]` fan-out child reference depends on its `work` parent.
        const id = phaseIndexOf.has(owner) ? owner : owner.replace(/\[\d+\]$/, "");
        const refPhase = phaseIndexOf.get(id);
        if (refPhase !== undefined && refPhase < pi) stepDeps.add(id);
      };

      if (step.dependsOn) {
        for (const dep of step.dependsOn) addEarlier(dep);
      } else {
        for (let pj = 0; pj < pi; pj++) {
          for (const id of idsByPhase[pj] ?? []) stepDeps.add(id);
        }
      }

      const conditions: (GateCondition | undefined)[] = [step.when];
      if (step.kind === "gate") conditions.push(step.condition);
      // An approval step reviews `step` (else its sole dependsOn, already added).
      if (step.kind === "approval") addEarlier(step.step);
      // Condition predicates aren't templates themselves, but they're rendered
      // as such (their {{steps.*}} refs resolve), so they contribute deps too.
      const renderableTexts: (string | undefined)[] = [];
      for (const condition of conditions) {
        if (!condition) continue;
        addEarlier(condition.step);
        renderableTexts.push(condition.contains, condition.equals, condition.matches);
      }
      if (
        (step.kind === "worker" ||
          step.kind === "processor" ||
          step.kind === "llm" ||
          !step.kind) &&
        step.forEach
      ) {
        addEarlier(parseForEachSource(step.forEach));
      }
      // Inheriting a workspace means waiting for the source's worktree.
      addEarlier(workspaceSourceId(step));
      // Continuing a session means waiting for the source's recorded session.
      // A self-reference (`continue:<ownId>`, the loop form) is ignored here
      // by construction: addEarlier only admits ids from earlier phases.
      addEarlier(sessionSourceId(step));
      if (step.kind === "merge") {
        for (const ref of step.from ?? []) addEarlier(ref);
        renderableTexts.push(step.branch, step.commitMessage, step.prTitle, step.prBody);
      }
      if ("prompt" in step) renderableTexts.push(step.prompt);
      if (step.kind === "llm") renderableTexts.push(step.system);
      if (step.kind === "command") renderableTexts.push(step.cmd);
      if (step.kind === "workflow") renderableTexts.push(step.input);
      if (step.kind === "distributor" && step.items) renderableTexts.push(...step.items);
      for (const text of renderableTexts) {
        for (const ref of templateStepRefs(text)) addEarlier(ref);
      }

      for (const gate of controlGates) {
        if (gate.phaseIndex < pi && gate.id !== step.id) stepDeps.add(gate.id);
      }

      deps.set(step.id, stepDeps);
    }
  });
  return deps;
}

/**
 * Run one step end to end — emit its `step_start`, resolve it via failed-
 * dependency skip, cache replay, `when` skip, or live execution, record the
 * result into the shared maps, and emit its `step_done`. Shared by both
 * schedulers; never throws.
 */
async function runSingleStep(
  specStep: WorkflowStep,
  phase: WorkflowPhase,
  iteration: number,
  env: RunEnv,
  push: (event: WorkflowEvent) => void,
): Promise<StepFlags> {
  // Mark the step started FIRST (mid-run edits are only accepted for steps
  // that have not started), then apply any already-accepted edit — both on the
  // same tick, so an edit can never land between the check and the apply.
  env.startedSteps.add(specStep.id);
  const stepEdit = env.deps.control?.stepEdit(specStep.id);
  const step = stepEdit ? applyStepEdit(specStep, stepEdit) : specStep;
  const { spec, ctx, deps, signal, cache, outputs, results, allResults } = env;
  const agentBacked = isAgentBackedStep(step) ? step : undefined;
  // llm steps have an api/model/effort but no agent; carry them on the events
  // so live views and history/cost roll-ups attribute the spend. The api and
  // model resolve against the configured instance (a step may inherit its
  // model from the instance's defaultModel); on a resolution error fall back
  // to the step's literal fields so the display still shows what was asked.
  const llm = step.kind === "llm" ? step : undefined;
  // A cache hit replays a completed result: prefer the api/model recorded on
  // it (what actually ran and was billed) over a fresh resolution — the
  // configured instance's endpoint or defaultModel may have changed since.
  const cachedHit = cache.get(step.id);
  const llmApi = llm && !cachedHit?.api ? resolveLlmStepApi(llm, deps.agentConfig) : undefined;
  const llmApiId = llm
    ? (cachedHit?.api ?? (llmApi?.ok ? llmApi.api.id : llmStepApiId(llm)))
    : undefined;
  const llmModel = llm ? (cachedHit?.model ?? (llmApi?.ok ? llmApi.model : llm.model)) : undefined;
  push({
    kind: "step_start",
    phaseId: phase.id,
    stepId: step.id,
    blockKind: workflowStepKind(step),
    agent: agentBacked?.agent,
    api: llmApiId,
    model: agentBacked?.model ?? llmModel,
    effort: agentBacked?.effort ?? llm?.effort,
    cwd: "cwd" in step ? step.cwd : undefined,
    dependsOn: step.dependsOn,
    iteration,
    loopTo: step.kind === "gate" ? step.loopTo : undefined,
    maxIterations: step.kind === "gate" ? step.maxIterations : undefined,
    ts: Date.now(),
  });

  const failedDependency = findFailedDependency(step, results);
  if (failedDependency) {
    const failed = dependencyFailedResult(step.id, failedDependency);
    failed.iteration = iteration;
    outputs.set(step.id, failed.output);
    results.set(step.id, failed);
    allResults.push(failed);
    const stop = step.kind === "gate" && (step.onFalse === "fail" || step.onFalse === "stop");
    push({
      kind: "step_done",
      phaseId: phase.id,
      stepId: step.id,
      result: failed,
      cached: false,
      iteration,
      ts: Date.now(),
    });
    return { notOk: true, stop };
  }

  // Cache hit → replay without spawning (resume). A session-continuing step's
  // cached result is only replayable when its recorded lineage still matches
  // the source's CURRENT session: if the source re-ran (or its own cache was
  // dropped) and recorded a different session, this step's cached output came
  // from a conversation that no longer exists — re-run it against the new one.
  let cached = cachedHit;
  const lineageSrc = sessionSourceId(step);
  if (cached && lineageSrc && lineageSrc !== step.id) {
    // The source has settled (it is an effective dependency), so env.sessions
    // already reflects what this step would resume if it ran now.
    if (cached.resumedSessionId !== env.sessions.get(lineageSrc)) {
      cache.delete(step.id);
      cached = undefined;
    }
  }
  if (cached) {
    for (const child of cached.childResults ?? []) {
      outputs.set(child.stepId, child.output);
      results.set(child.stepId, child);
      allResults.push(child);
      push({
        kind: "step_start",
        phaseId: phase.id,
        stepId: child.stepId,
        blockKind: workflowStepKind(step),
        agent: agentBacked?.agent,
        api: llm ? (child.api ?? llmApiId) : undefined,
        model: agentBacked?.model ?? (llm ? (child.model ?? llmModel) : undefined),
        effort: agentBacked?.effort ?? llm?.effort,
        cwd: "cwd" in step ? step.cwd : undefined,
        dependsOn: step.dependsOn,
        parentStepId: step.id,
        item: child.item,
        iteration,
        ts: Date.now(),
      });
      push({
        kind: "step_done",
        phaseId: phase.id,
        stepId: child.stepId,
        result: child,
        cached: true,
        iteration,
        ts: Date.now(),
      });
    }
    outputs.set(step.id, cached.output);
    results.set(step.id, cached);
    recordStepSession(env.sessions, cached);
    allResults.push(cached);
    let notOk = false;
    let stop = false;
    if (!cached.ok) {
      // onFalse: "stop" is a graceful halt — same logic as the live path
      const isGracefulStop = cached.gate?.onFalse === "stop";
      if (!isGracefulStop) notOk = true;
    }
    if (cached.gate) {
      push({
        kind: "gate_evaluated",
        phaseId: phase.id,
        stepId: step.id,
        passed: cached.gate.passed,
        target: cached.target,
        onFalse: cached.gate.onFalse,
        iteration,
        ts: Date.now(),
      });
      if (!cached.gate.passed) {
        const onFalse = cached.gate.onFalse;
        if (onFalse === "fail" || onFalse === "stop") stop = true;
      }
    }
    push({
      kind: "step_done",
      phaseId: phase.id,
      stepId: step.id,
      result: cached,
      cached: true,
      iteration,
      ts: Date.now(),
    });
    return { notOk, stop };
  }

  // `when` condition / skip cascade: the step is recorded as skipped (ok,
  // empty output) rather than executed. Skips are cached like any other ok
  // result so a resumed run replays the same decision.
  const skipReason = findSkipReason(step, {
    input: ctx.input,
    inputs: ctx.inputs,
    outputs,
    results,
    iteration,
  });
  if (skipReason) {
    const skipped = skippedStepResult(step.id);
    skipped.iteration = iteration;
    outputs.set(step.id, skipped.output);
    results.set(step.id, skipped);
    cache.set(step.id, skipped);
    allResults.push(skipped);
    push({
      kind: "step_done",
      phaseId: phase.id,
      stepId: step.id,
      result: skipped,
      cached: false,
      iteration,
      ts: Date.now(),
    });
    return { notOk: false, stop: false };
  }

  const execution = await executeStep(
    step,
    {
      input: ctx.input,
      inputs: ctx.inputs,
      outputs,
      results,
      cache,
      sessions: env.sessions,
      reserveDynamicSteps: env.reserveDynamicSteps,
      deps,
      signal,
      workflowName: spec.name,
      artifactsDir: env.artifactsDir,
      retryDefault: spec.retry,
      stepTimeoutDefault: spec.stepTimeoutSec,
      iteration,
      workflowCallStack: ctx.workflowCallStack ?? [],
    },
    {
      pushAgentEvent: (stepId, event) => {
        push({
          kind: "step_event",
          phaseId: phase.id,
          stepId,
          event,
          iteration,
          ts: Date.now(),
        });
      },
      pushWorkflowEvent: push,
      phaseId: phase.id,
    },
  );

  if (execution.gate) {
    push({
      kind: "gate_evaluated",
      phaseId: phase.id,
      stepId: step.id,
      passed: execution.gate.passed,
      target: execution.gate.target,
      onFalse: execution.gate.onFalse,
      iteration,
      ts: Date.now(),
    });
  }

  const { result } = execution;
  result.iteration = iteration;
  if (stepEdit) result.edited = true;
  for (const child of execution.childResults ?? []) {
    child.iteration = iteration;
    if (stepEdit) child.edited = true;
    outputs.set(child.stepId, child.output);
    results.set(child.stepId, child);
    allResults.push(child);
    // Fan-out children hold the real cost; the parent's is their sum, so count
    // children here and skip the parent below to avoid double-counting.
    env.spent.costUsd += child.costUsd ?? 0;
  }
  outputs.set(step.id, result.output);
  results.set(step.id, result);
  recordStepSession(env.sessions, result);
  // Approval checkpoints are never cached (`noCache`): a resumed run must
  // re-ask the decision instead of replaying a stale approval.
  if (result.ok && !result.noCache) cache.set(step.id, result);
  allResults.push(result);
  if (!execution.childResults) env.spent.costUsd += result.costUsd ?? 0;
  let notOk = false;
  if (!result.ok) {
    // onFalse: "stop" is a graceful halt — the step is not ok (gate
    // condition failed) but the workflow stays ok per the documented
    // contract. onFalse: "fail" should make the workflow fail.
    const isGracefulStop = execution.gate?.onFalse === "stop";
    if (!isGracefulStop) notOk = true;
  }

  push({
    kind: "step_done",
    phaseId: phase.id,
    stepId: step.id,
    result,
    cached: false,
    iteration,
    ts: Date.now(),
  });
  return { notOk, stop: Boolean(execution.stop) };
}

/**
 * Pure predicate: find the first loop gate in `phase` whose condition failed
 * and whose iteration budget still remains, without mutating any state. Returns
 * the gate id, its target index, and the cap to apply. The caller owns the
 * counter increment (see the call site), which keeps "decide" separate from
 * "mutate" so H1-class bugs (a scan that bails early) are easy to grep and test.
 *
 * A gate is skipped (not contended) when it has no evaluated result (e.g. a
 * dependency failed so it never tested its condition), when it passed
 * (condition true ⇒ converged), or when its budget is exhausted (onFalse
 * already applied). None of those say anything about *other* loop gates that
 * may share this phase (validation permits several loop gates per phase when
 * their regions are nested or disjoint), so the scan keeps going instead of
 * bailing the whole phase.
 */
function findContendedLoopGate(
  phase: WorkflowPhase,
  results: Map<string, StepResult>,
  loopState: Map<string, { loopToIndex: number; gatePhaseIndex: number; iteration: number }>,
  effectiveLoopMax: number,
): { gateId: string; loopToIndex: number; cap: number } | undefined {
  for (const step of phase.steps) {
    if (step.kind !== "gate" || step.loopTo === undefined) continue;
    const state = loopState.get(step.id);
    if (!state) continue;
    const res = results.get(step.id);
    if (!res?.gate || res.gate.passed) continue;
    const cap = step.maxIterations ?? effectiveLoopMax;
    if (state.iteration >= cap) continue; // exhausted ⇒ onFalse already applied
    return { gateId: step.id, loopToIndex: state.loopToIndex, cap };
  }
  return undefined;
}

/**
 * Delete cache/results entries for every step id in phases [start..end] so
 * they re-run. `outputs` is deliberately left untouched here — it lives in
 * the caller's closure and is never cleared on a loop jump, so the previous
 * iteration's text stays readable (e.g. a fix step reads the prior review)
 * until each step overwrites its own output as it re-runs.
 */
function invalidateRegion(
  spec: WorkflowSpec,
  start: number,
  end: number,
  cache: Map<string, StepResult>,
  results: Map<string, StepResult>,
  startedSteps?: Set<string>,
): void {
  // Collect all step ids in the region and their forEach-child prefixes so we
  // can invalidate in a single pass over each Map instead of scanning all keys
  // per step (avoids O(steps_in_region × cache_size) with large fan-outs).
  const exact = new Set<string>();
  const childPrefixes: string[] = [];
  for (let i = start; i <= end; i++) {
    const phase = spec.phases[i];
    if (!phase) continue;
    for (const step of phase.steps) {
      exact.add(step.id);
      childPrefixes.push(`${step.id}[`);
    }
  }
  const shouldDelete = (key: string): boolean => {
    if (exact.has(key)) return true;
    for (const prefix of childPrefixes) if (key.startsWith(prefix)) return true;
    return false;
  };
  for (const key of cache.keys()) if (shouldDelete(key)) cache.delete(key);
  for (const key of results.keys()) if (shouldDelete(key)) results.delete(key);
  // The region's steps are about to re-run, so they become mid-run-editable
  // again during a pause between loop iterations.
  if (startedSteps) {
    for (const key of startedSteps) if (shouldDelete(key)) startedSteps.delete(key);
  }
}

/**
 * When loop gate `jumpGateId` jumps back to re-run region [loopToIndex..gatePhaseIndex],
 * reset to 1 the iteration budget of every OTHER loop gate nested inside that
 * region (its own gate phase index falls within the region) — they are part of
 * the body being re-run, so their budgets must restart on each outer pass. The
 * jumping gate itself is excluded: it just incremented its own counter as part
 * of deciding to jump.
 */
function resetNestedLoops(
  loopState: Map<string, { loopToIndex: number; gatePhaseIndex: number; iteration: number }>,
  loopToIndex: number,
  gatePhaseIndex: number,
  jumpGateId: string,
): void {
  for (const [gateId, state] of loopState) {
    if (gateId === jumpGateId) continue;
    if (state.gatePhaseIndex >= loopToIndex && state.gatePhaseIndex <= gatePhaseIndex) {
      state.iteration = 1;
    }
  }
}

interface ExecuteContext {
  input: string;
  inputs?: Record<string, string | number | boolean>;
  outputs: Map<string, string>;
  results: Map<string, StepResult>;
  cache: Map<string, StepResult>;
  /** Latest recorded agent session id per step (see {@link RunEnv.sessions}). */
  sessions: Map<string, string>;
  reserveDynamicSteps: (count: number) => boolean;
  deps: WorkflowDeps;
  signal?: AbortSignal;
  workflowName: string;
  /** Per-run artifact snapshot directory (see {@link WorkflowDeps.artifactsDir}). */
  artifactsDir: string;
  /** Workflow-level auto-retry default; per-step `retry` overrides it. */
  retryDefault?: RetryPolicy;
  /** Workflow-level per-step timeout default in seconds; per-step `stepTimeoutSec` overrides it. */
  stepTimeoutDefault?: number;
  /** Loop iteration this step is executing under (1-based). */
  iteration: number;
  /** Names of workflows already on the call stack (see `WorkflowRunContext.workflowCallStack`). Always an array (never undefined) once inside `executeStep`. */
  workflowCallStack: string[];
}

interface ExecutionOutcome {
  result: StepResult;
  childResults?: StepResult[];
  gate?: { passed: boolean; target?: string; onFalse?: "continue" | "fail" | "stop" };
  stop?: boolean;
}

interface ExecuteHooks {
  phaseId: string;
  pushAgentEvent: (stepId: string, event: AgentEvent) => void;
  pushWorkflowEvent: (event: WorkflowEvent) => void;
}

async function executeStep(
  step: WorkflowStep,
  ctx: ExecuteContext,
  hooks: ExecuteHooks,
): Promise<ExecutionOutcome> {
  const kind = workflowStepKind(step);

  if (kind === "worker" || kind === "processor") {
    const worker = step as WorkerStep & AgentBackedWorkflowStep;
    if (worker.forEach) return executeForEachStep(worker, ctx, hooks);
    return { result: await executeAgentStep(worker, ctx, hooks, step.id) };
  }

  if (kind === "distributor") {
    if (step.kind === "distributor" && step.items?.length) {
      const started = Date.now();
      const items = step.items
        .map((item) =>
          renderPrompt(item, {
            input: ctx.input,
            inputs: ctx.inputs,
            outputs: ctx.outputs,
            results: ctx.results,
            iteration: ctx.iteration,
          }),
        )
        .map((item) => item.trim())
        .filter(Boolean);
      if (items.length === 0) {
        return {
          result: {
            stepId: step.id,
            ok: false,
            output: "distributor produced no items",
            error: "distributor produced no items",
            durationMs: Date.now() - started,
          },
        };
      }
      return {
        result: {
          stepId: step.id,
          ok: true,
          output: items.join(step.separator ?? "\n"),
          items,
          durationMs: Date.now() - started,
        },
      };
    }
    if (isAgentBackedStep(step)) {
      const result = await executeAgentStep(step, ctx, hooks, step.id);
      if (!result.ok) return { result };
      // With an `output` schema the parsed JSON (or the array at `itemsPath`)
      // is the distribution source — a typed contract instead of line-splitting.
      if (step.kind === "distributor" && step.output) {
        const source = step.itemsPath ? jsonPathGet(result.json, step.itemsPath) : result.json;
        if (!Array.isArray(source)) {
          const where = step.itemsPath ? `at itemsPath '${step.itemsPath}'` : "output";
          const message = `distributor structured ${where} is not a JSON array`;
          return { result: { ...result, ok: false, output: message, error: message } };
        }
        return { result: { ...result, items: source.map(jsonFieldText) } };
      }
      return { result: { ...result, items: splitItemsFromOutput(result.output) } };
    }
  }

  if (kind === "consolidator" && step.kind === "consolidator") {
    if (isAgentBackedStep(step)) {
      return { result: await executeAgentStep(step, ctx, hooks, step.id) };
    }
    const started = Date.now();
    const output = step.prompt
      ? renderPrompt(step.prompt, {
          input: ctx.input,
          inputs: ctx.inputs,
          outputs: ctx.outputs,
          results: ctx.results,
          iteration: ctx.iteration,
        })
      : consolidateOutputs(step.dependsOn ?? [], ctx.outputs, ctx.results, step.separator);
    return {
      result: {
        stepId: step.id,
        ok: true,
        output,
        durationMs: Date.now() - started,
      },
    };
  }

  if (kind === "merge" && step.kind === "merge") {
    return executeMergeStep(step, ctx, hooks);
  }

  if (kind === "command" && step.kind === "command") {
    return { result: await executeCommandStep(step, ctx, hooks) };
  }

  if (kind === "llm" && step.kind === "llm") {
    if (step.forEach) return executeForEachStep(step, ctx, hooks);
    return { result: await executeLlmStep(step, ctx, hooks, step.id) };
  }

  if (kind === "approval" && step.kind === "approval") {
    return executeApproval(step, ctx, hooks);
  }

  if (kind === "human" && step.kind === "human") {
    return { result: await executeHumanStep(step, ctx, hooks) };
  }

  if (kind === "gate" && step.kind === "gate") {
    if (step.condition.human) return executeApproval(step, ctx, hooks);
    const started = Date.now();
    const evaluation = evaluateGate(step.condition, ctx);
    const onFalse = step.onFalse ?? "continue";
    const ok = evaluation.passed || onFalse === "continue";
    const target = step.target ?? (evaluation.passed ? "passed" : "blocked");
    return {
      result: {
        stepId: step.id,
        ok,
        output: target,
        target,
        gate: { passed: evaluation.passed, onFalse },
        error: ok ? undefined : evaluation.message,
        durationMs: Date.now() - started,
      },
      gate: { passed: evaluation.passed, target, onFalse },
      stop: !evaluation.passed && (onFalse === "stop" || onFalse === "fail"),
    };
  }

  if (kind === "workflow" && step.kind === "workflow") {
    return executeWorkflowStep(step, ctx, hooks);
  }

  return {
    result: {
      stepId: step.id,
      ok: false,
      output: `unsupported workflow step kind '${kind}'`,
      error: `unsupported workflow step kind '${kind}'`,
      durationMs: 0,
    },
  };
}

/**
 * One agent invocation. Returns its result plus whether the failure (if any) is
 * a *retryable transient*: a transport-level `error` event or a thrown exception
 * where the agent did **no observable work** — it neither completed a turn (no
 * `result` event) nor invoked any tool (no `tool_use`). A completed `result`
 * (even `isError`) is never retryable, and — conservatively — neither is any
 * attempt in which the agent started using tools, because a tool call may have
 * had side effects (a commit, a file write, an API call) even if the agent later
 * crashed before reporting a result. Cancellation is never retryable. This errs
 * on the side of safety: we only retry failures that almost certainly changed
 * nothing (spawn failures, immediate transport/rate-limit errors before any
 * tool ran).
 */
async function runAgentAttempt(
  step: AgentBackedWorkflowStep,
  ctx: ExecuteContext,
  hooks: ExecuteHooks,
  stepId: string,
  item: WorkflowItem | undefined,
  prompt: string,
  stepCwd: string,
  resumeSessionId?: string,
): Promise<{ result: StepResult; retryable: boolean }> {
  const started = Date.now();
  let finalText = "";
  let streamedText = "";
  let costUsd: number | undefined;
  let tokens: TokenUsage | undefined;
  let sessionId: string | undefined;
  let errored = false;
  let errorMessage: string | undefined;
  let sawResult = false;
  let sawToolUse = false;

  try {
    for await (const event of adapterRun(step, ctx, stepCwd, prompt, resumeSessionId)) {
      hooks.pushAgentEvent(stepId, event);
      if (event.kind === "text_delta") {
        if (!event.thinking) streamedText += event.text;
      } else if (event.kind === "session_start") {
        // Captured for session continuity: `canAsk` answers resume this
        // session, and `workflow takeover` drops a human into it.
        if (event.sessionId) sessionId = event.sessionId;
      } else if (event.kind === "tool_use" || event.kind === "tool_result") {
        // The agent invoked a tool — assume it may have caused a side effect.
        sawToolUse = true;
      } else if (event.kind === "result") {
        sawResult = true;
        if (event.text) finalText = event.text;
        if (typeof event.costUsd === "number") costUsd = event.costUsd;
        // Tokens follow the same "last result wins" semantics as `costUsd`:
        // adapters that emit several `result` events per turn (opencode's
        // per-step finishes) report cumulative running totals, so the final
        // event already carries the whole-turn usage.
        if (event.tokens) tokens = event.tokens;
        if (event.isError) {
          errored = true;
          errorMessage ??= event.text;
        }
      } else if (event.kind === "error") {
        errored = true;
        errorMessage ??= event.message;
      } else if (event.kind === "unknown") {
        // An adapter downgrades an envelope it can't parse to `unknown` rather
        // than dropping it (e.g. a malformed/future-shaped tool_use or assistant
        // line). Honor the tagged `rawType` so a side-effecting tool call — or a
        // completed turn — still blocks retry even when its payload didn't parse.
        if (
          event.rawType === "tool_use" ||
          event.rawType === "tool_result" ||
          event.rawType === "assistant" ||
          event.rawType === "user"
        ) {
          sawToolUse = true;
        } else if (event.rawType === "result") {
          sawResult = true;
        }
      }
    }
  } catch (err) {
    errored = true;
    errorMessage ??= err instanceof Error ? err.message : String(err);
  }

  // A cancelled step is never cached, so resume re-runs it.
  const cancelled = Boolean(ctx.signal?.aborted);
  const ok = !errored && !cancelled;
  const output = ok
    ? finalText || streamedText
    : errorMessage || finalText || streamedText || (cancelled ? "cancelled" : "");

  return {
    result: {
      stepId,
      ok,
      output,
      item,
      error: ok ? undefined : (errorMessage ?? (cancelled ? "cancelled" : "failed")),
      durationMs: Date.now() - started,
      costUsd,
      tokens,
      sessionId,
    },
    // Transient + side-effect-free: errored, not cancelled, and the agent neither
    // completed a turn (`result`) nor invoked a tool (`tool_use`/`tool_result`),
    // including unparsed `unknown` envelopes tagged as such.
    retryable: errored && !cancelled && !sawResult && !sawToolUse,
  };
}

function adapterRun(
  step: AgentBackedWorkflowStep,
  ctx: ExecuteContext,
  stepCwd: string,
  prompt: string,
  resumeSessionId?: string,
): AsyncIterable<AgentEvent> {
  const instance = resolveAgentInstance(ctx.deps.agentConfig, step.agent);
  if (!instance) throw new Error(`agent '${step.agent}' is disabled or not configured`);
  const adapter = ctx.deps.createAdapter(instance.provider, instance.binary);
  const timeoutSec = resolveStepTimeoutSec(
    step,
    { stepTimeoutSec: ctx.stepTimeoutDefault },
    {
      stepTimeoutSec: ctx.deps.stepTimeoutSec,
    },
  );
  return adapter.run({
    prompt,
    model: step.model,
    effort: step.effort,
    cwd: stepCwd,
    env: { ...instance.env, ...step.env },
    extraArgs: [...(instance.extraArgs ?? []), ...(step.extraArgs ?? [])],
    agentId: instance.id,
    timeoutMs: timeoutMsFromSec(timeoutSec),
    signal: ctx.signal,
    resumeSessionId,
  });
}

/** Whether a step's configured adapter can resume a recorded session natively. */
function adapterSupportsResume(step: AgentBackedWorkflowStep, ctx: ExecuteContext): boolean {
  const instance = resolveAgentInstance(ctx.deps.agentConfig, step.agent);
  if (!instance) return false;
  const adapter = ctx.deps.createAdapter(instance.provider, instance.binary);
  return adapter.supportsResume === true;
}

/**
 * Resolve a step's `session: "continue:<stepId>"` to the session id the agent
 * should resume. Fails LOUDLY (instead of silently starting a clean-room
 * session) when the adapter cannot resume or the source recorded no session —
 * a prompt written for a continued conversation is meaningless in an empty
 * one. The self form (`continue:<ownId>`, the loop pattern) is the exception:
 * its first iteration has no previous session by construction and starts
 * fresh. A missing agent instance falls through to the run path, whose
 * "disabled or not configured" error is the clearer diagnosis.
 */
function resolveSessionResume(
  step: AgentBackedWorkflowStep,
  ctx: ExecuteContext,
): { ok: true; sessionId?: string } | { ok: false; error: string } {
  const sourceId = sessionSourceId(step);
  if (!sourceId) return { ok: true };
  const instance = resolveAgentInstance(ctx.deps.agentConfig, step.agent);
  if (instance) {
    const adapter = ctx.deps.createAdapter(instance.provider, instance.binary);
    if (adapter.supportsResume !== true) {
      return {
        ok: false,
        error: `step declares session "continue:${sourceId}" but agent '${step.agent}' (provider '${instance.provider}') cannot resume recorded sessions`,
      };
    }
  }
  if (sourceId === step.id) {
    return { ok: true, sessionId: ctx.sessions.get(step.id) };
  }
  const sessionId = ctx.sessions.get(sourceId);
  if (!sessionId) {
    return {
      ok: false,
      error: `session source '${sourceId}' recorded no agent session id to continue (the agent may not have reported one)`,
    };
  }
  return { ok: true, sessionId };
}

/** Sleep `ms`, resolving early if the signal aborts. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function executeAgentStep(
  step: AgentBackedWorkflowStep,
  ctx: ExecuteContext,
  hooks: ExecuteHooks,
  stepId: string,
  item?: WorkflowItem,
): Promise<StepResult> {
  const rendered = renderPrompt(step.prompt, {
    input: ctx.input,
    inputs: ctx.inputs,
    outputs: ctx.outputs,
    results: ctx.results,
    item,
    iteration: ctx.iteration,
  });
  const outputSchema = step.output;
  const kindForAsk = workflowStepKind(step);
  const canAsk =
    (kindForAsk === "worker" || kindForAsk === "processor") &&
    "canAsk" in step &&
    step.canAsk === true;
  const withSchema = outputSchema
    ? withStructuredOutputInstructions(rendered, outputSchema)
    : rendered;
  const prompt = canAsk ? withSchema + AGENT_QUESTION_PROTOCOL : withSchema;
  const stepCwd = step.cwd ? resolvePath(ctx.deps.cwd, step.cwd) : ctx.deps.cwd;
  const resume = resolveSessionResume(step, ctx);
  if (!resume.ok) {
    return {
      stepId,
      ok: false,
      output: resume.error,
      item,
      error: resume.error,
      durationMs: 0,
    };
  }
  const workspaceStarted = Date.now();
  let workspace: AgentWorkspaceLease;
  try {
    workspace = await allocateAgentWorkspace(step, ctx, stepId, item, stepCwd);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      stepId,
      ok: false,
      output: message,
      item,
      error: message,
      durationMs: Date.now() - workspaceStarted,
    };
  }
  pushWorkspaceEvent(hooks, ctx, stepId, workspace, stepCwd);
  // Auto-retry is scoped to worker/processor steps (and their fan-out children).
  // Agent-backed distributors/consolidators run exactly once.
  const kind = workflowStepKind(step);
  const retryEligible = kind === "worker" || kind === "processor";
  const stepRetry =
    retryEligible && "retry" in step ? (step.retry as RetryPolicy | undefined) : undefined;
  const policy = resolveRetryPolicy(
    stepRetry,
    retryEligible ? ctx.retryDefault : { maxAttempts: 1 },
  );

  const firstStarted = Date.now();
  let attempt = 0;
  try {
    let result: StepResult;
    while (true) {
      attempt += 1;
      const attemptOutcome = await runAgentAttempt(
        step,
        ctx,
        hooks,
        stepId,
        item,
        prompt,
        workspace.cwd,
        resume.sessionId,
      );
      result = attemptOutcome.result;
      const isLastAttempt = attempt >= policy.maxAttempts;
      if (result.ok || !attemptOutcome.retryable || isLastAttempt || ctx.signal?.aborted) break;
      const delayMs = backoffDelayMs(policy, attempt);
      hooks.pushWorkflowEvent({
        kind: "step_retry",
        phaseId: hooks.phaseId,
        stepId,
        attempt,
        maxAttempts: policy.maxAttempts,
        delayMs,
        reason: result.error ?? "transient failure",
        iteration: ctx.iteration,
        ts: Date.now(),
      });
      await abortableSleep(delayMs, ctx.signal);
      // A cancel during the backoff wait ends the step now — don't start another
      // attempt (which would spawn the agent again).
      if (ctx.signal?.aborted) {
        return attachWorktreeInfo(
          { ...result, attempts: attempt, durationMs: Date.now() - firstStarted },
          workspace,
          stepCwd,
        );
      }
    }
    if (canAsk && result.ok) {
      const question = parseAgentQuestion(result.output);
      if (question) {
        result = await continueAfterAgentQuestion(
          step,
          ctx,
          hooks,
          stepId,
          item,
          result,
          question,
          workspace.cwd,
          prompt,
        );
      }
    }
    if (outputSchema && result.ok) {
      const fixed = await enforceStructuredOutput(
        step,
        ctx,
        hooks,
        stepId,
        item,
        result,
        outputSchema,
        workspace.cwd,
        attempt,
      );
      result = fixed.result;
      attempt = fixed.attempt;
    }
    // Record the resumed lineage on the result so cache replays can verify the
    // source still carries this session (see the staleness check in runSingleStep).
    if (resume.sessionId !== undefined) result = { ...result, resumedSessionId: resume.sessionId };
    result = await applyDeclaredArtifacts(step, ctx, stepId, workspace.cwd, result);
    const finalResult = attachWorktreeInfo(result, workspace, stepCwd);
    // After a retry, report true wall-clock for the whole step (all attempts
    // plus the backoff waits between them), not just the last attempt.
    return attempt > 1
      ? { ...finalResult, attempts: attempt, durationMs: Date.now() - firstStarted }
      : finalResult;
  } finally {
    await workspace.dispose();
  }
}

/**
 * Parse + validate a successful agent result against the step's `output`
 * schema. On a mismatch, run ONE bounded "fix your JSON" retry — the agent is
 * re-invoked with the schema, the validation error, and its previous reply —
 * then the step fails if the retry still doesn't match. Costs of the extra
 * attempt are summed into the returned result.
 */
async function enforceStructuredOutput(
  step: AgentBackedWorkflowStep,
  ctx: ExecuteContext,
  hooks: ExecuteHooks,
  stepId: string,
  item: WorkflowItem | undefined,
  result: StepResult,
  outputSchema: JsonSchema,
  workspaceCwd: string,
  attempt: number,
): Promise<{ result: StepResult; attempt: number }> {
  const parsed = parseStructuredOutput(result.output, outputSchema);
  if (parsed.ok) return { result: { ...result, json: parsed.value }, attempt };
  if (ctx.signal?.aborted) {
    return {
      result: { ...result, ok: false, error: `structured output invalid: ${parsed.error}` },
      attempt,
    };
  }
  hooks.pushWorkflowEvent({
    kind: "step_retry",
    phaseId: hooks.phaseId,
    stepId,
    attempt,
    maxAttempts: attempt + 1,
    delayMs: 0,
    reason: `structured output invalid: ${parsed.error}`,
    iteration: ctx.iteration,
    ts: Date.now(),
  });
  // Resume the step's own just-recorded session where the adapter supports it,
  // so the fix turn keeps the agent's context AND the step's session lineage
  // stays one conversation (a later `continue:` of this step resumes a session
  // that actually did the work, not a context-free JSON-fixup). The fix prompt
  // is self-contained either way, so non-resumable adapters lose nothing.
  const fixResume =
    result.sessionId && adapterSupportsResume(step, ctx) ? result.sessionId : undefined;
  const fix = await runAgentAttempt(
    step,
    ctx,
    hooks,
    stepId,
    item,
    structuredOutputFixPrompt(outputSchema, result.output, parsed.error),
    workspaceCwd,
    fixResume,
  );
  const costUsd =
    result.costUsd === undefined && fix.result.costUsd === undefined
      ? undefined
      : (result.costUsd ?? 0) + (fix.result.costUsd ?? 0);
  // The fix attempt is a second billable turn — sum both turns' token usage so
  // the step's recorded tokens match its recorded cost.
  const tokens =
    result.tokens || fix.result.tokens ? addTokens(result.tokens, fix.result.tokens) : undefined;
  const reparsed = fix.result.ok
    ? parseStructuredOutput(fix.result.output, outputSchema)
    : undefined;
  // Like the canAsk continuation: keep the last known session when the fix
  // attempt reported none, so takeover/session-continuation still find one.
  const sessionId = fix.result.sessionId ?? result.sessionId;
  if (reparsed?.ok) {
    return {
      result: { ...fix.result, json: reparsed.value, costUsd, tokens, sessionId },
      attempt: attempt + 1,
    };
  }
  const reason = reparsed ? reparsed.error : (fix.result.error ?? "the retry attempt failed");
  return {
    result: {
      ...fix.result,
      ok: false,
      error: `structured output retry failed: ${reason}`,
      costUsd,
      tokens,
      sessionId,
    },
    attempt: attempt + 1,
  };
}

/**
 * Handle a `canAsk` step's clarifying question: surface it through the shared
 * human-input channel, then continue the agent with the answer — resuming its
 * recorded session where the adapter supports it (the agent keeps every bit of
 * context it built up), otherwise re-running with the original prompt plus the
 * Q&A appended (self-contained, works for every adapter). Costs and tokens of
 * both turns are summed; the exchange is recorded on `result.questions`.
 *
 * Bounded to ONE question per step: a continuation that asks again fails the
 * step rather than looping a pipeline into a conversation.
 */
async function continueAfterAgentQuestion(
  step: AgentBackedWorkflowStep,
  ctx: ExecuteContext,
  hooks: ExecuteHooks,
  stepId: string,
  item: WorkflowItem | undefined,
  result: StepResult,
  question: string,
  workspaceCwd: string,
  originalPrompt: string,
): Promise<StepResult> {
  const ask = await askHuman(ctx, hooks, {
    stepId,
    prompt: question,
    origin: "agent-question",
  });
  if (!ask.ok) {
    return {
      ...result,
      ok: false,
      error: `clarifying question unanswered: ${ask.error}`,
      questions: [{ question, answer: "", by: undefined }],
    };
  }

  const resumable = Boolean(result.sessionId) && adapterSupportsResume(step, ctx);
  const continuationPrompt = resumable
    ? `Answer to your question: ${ask.output}\n\nContinue and complete the original task. Do not ask further questions.`
    : `${originalPrompt}\n\nYou previously asked:\nQUESTION: ${question}\nAnswer: ${ask.output}\n\nContinue and complete the task. Do not ask further questions.`;
  const continuation = await runAgentAttempt(
    step,
    ctx,
    hooks,
    stepId,
    item,
    continuationPrompt,
    workspaceCwd,
    resumable ? result.sessionId : undefined,
  );

  const costUsd =
    result.costUsd === undefined && continuation.result.costUsd === undefined
      ? undefined
      : (result.costUsd ?? 0) + (continuation.result.costUsd ?? 0);
  const tokens =
    result.tokens || continuation.result.tokens
      ? addTokens(result.tokens, continuation.result.tokens)
      : undefined;
  const questions = [{ question, answer: ask.output, by: ask.by }];
  const merged: StepResult = {
    ...continuation.result,
    costUsd,
    tokens,
    questions,
    sessionId: continuation.result.sessionId ?? result.sessionId,
    durationMs: result.durationMs + continuation.result.durationMs,
  };
  if (merged.ok && parseAgentQuestion(merged.output)) {
    const message =
      "the agent asked a second clarifying question — canAsk allows one per step (split the step, or enrich its prompt/context)";
    return { ...merged, ok: false, error: message };
  }
  return merged;
}

/** The lease's worktree metadata, or undefined when the step runs in the plain cwd. */
function worktreeInfoFromLease(
  workspace: AgentWorkspaceLease,
  originalCwd: string,
): AgentWorktreeInfo | undefined {
  if (!workspace.root || !workspace.branch) return undefined;
  return {
    originalCwd,
    cwd: workspace.cwd,
    root: workspace.root,
    branch: workspace.branch,
    baseCommit: workspace.baseCommit,
    linkedIgnoredPaths: workspace.linkedIgnoredPaths,
  };
}

function attachWorktreeInfo(
  result: StepResult,
  workspace: AgentWorkspaceLease,
  originalCwd: string,
): StepResult {
  const worktree = worktreeInfoFromLease(workspace, originalCwd);
  return worktree ? { ...result, worktree } : result;
}

/**
 * Announce a just-allocated workspace on the event stream (`step_workspace`),
 * so live views can show the directory/worktree a step is working in while it
 * runs — the same metadata otherwise only lands on the final result.
 */
function pushWorkspaceEvent(
  hooks: ExecuteHooks,
  ctx: ExecuteContext,
  stepId: string,
  workspace: AgentWorkspaceLease,
  originalCwd: string,
): void {
  hooks.pushWorkflowEvent({
    kind: "step_workspace",
    phaseId: hooks.phaseId,
    stepId,
    cwd: workspace.cwd,
    worktree: worktreeInfoFromLease(workspace, originalCwd),
    iteration: ctx.iteration,
    ts: Date.now(),
  });
}

async function allocateAgentWorkspace(
  step: AgentBackedWorkflowStep,
  ctx: ExecuteContext,
  stepId: string,
  item: WorkflowItem | undefined,
  stepCwd: string,
): Promise<AgentWorkspaceLease> {
  if (!ctx.deps.agentWorkspace) return { cwd: stepCwd, dispose: () => {} };
  return ctx.deps.agentWorkspace.allocate({
    workflowName: ctx.workflowName,
    stepId,
    agent: step.agent,
    baseCwd: ctx.deps.cwd,
    stepCwd,
    iteration: ctx.iteration,
    item,
    inheritFrom: resolveInheritedWorkspace(step, ctx),
    signal: ctx.signal,
  });
}

/**
 * Resolve a step's `workspace: "inherit:<stepId>"` to the source step's
 * recorded worktree. Undefined when the step doesn't inherit — or when the
 * source ran in the plain cwd (no git repo / no isolation manager), in which
 * case this step runs there too and already sees the source's files.
 * Throws when the source's worktrees are ambiguous or absent; the callers'
 * allocation error handling turns that into a failed step.
 */
function resolveInheritedWorkspace(
  step: WorkflowStep,
  ctx: ExecuteContext,
): { stepId: string; root: string; baseCommit?: string } | undefined {
  const sourceId = workspaceSourceId(step);
  if (!sourceId) return undefined;
  const source = ctx.results.get(sourceId);
  if (!source) {
    throw new Error(`workspace inherit source '${sourceId}' has not produced a result`);
  }
  if (source.childResults?.length) {
    throw new Error(
      `workspace inherit source '${sourceId}' fanned out into ${source.childResults.length} worktrees; merge them first`,
    );
  }
  if (!source.worktree) return undefined;
  return {
    stepId: sourceId,
    root: source.worktree.root,
    baseCommit: source.worktree.baseCommit,
  };
}

/**
 * Snapshot a successful step's declared `artifacts` out of its workspace into
 * the run's artifact directory and record them on the result. A declared
 * artifact the step did not produce fails the step — the declaration is a
 * contract downstream steps rely on.
 */
async function applyDeclaredArtifacts(
  step: WorkflowStep,
  ctx: ExecuteContext,
  stepId: string,
  workspaceCwd: string,
  result: StepResult,
): Promise<StepResult> {
  const declared = "artifacts" in step ? step.artifacts : undefined;
  // Runs AFTER structured-output enforcement: a step that already failed (an
  // agent error, invalid JSON, …) keeps its original error and snapshots
  // nothing — artifacts are a product of success, and the first failure in
  // the chain is the one worth reporting.
  if (!declared?.length || !result.ok) return result;
  try {
    const collected = await collectArtifacts({
      declared,
      stepCwd: workspaceCwd,
      artifactsDir: ctx.artifactsDir,
      stepId,
      signal: ctx.signal,
    });
    if (collected.missing.length > 0) {
      const message = `declared artifact${collected.missing.length > 1 ? "s" : ""} not produced: ${collected.missing.join(", ")}`;
      return {
        ...result,
        ok: false,
        error: message,
        artifacts: collected.artifacts.length > 0 ? collected.artifacts : undefined,
      };
    }
    return { ...result, artifacts: collected.artifacts };
  } catch (err) {
    const message = `artifact snapshot failed: ${err instanceof Error ? err.message : String(err)}`;
    return { ...result, ok: false, error: message };
  }
}

async function executeForEachStep(
  step: (WorkerStep & AgentBackedWorkflowStep) | LlmStep,
  ctx: ExecuteContext,
  hooks: ExecuteHooks,
): Promise<ExecutionOutcome> {
  const started = Date.now();
  const maxCostUsd = step.maxCostUsd;
  const childAgent = isAgentBackedStep(step) ? step.agent : undefined;
  const childCwd = "cwd" in step ? step.cwd : undefined;
  // llm fan-outs: the effective api/model for child step_start events (a step
  // may inherit its model from the configured instance's defaultModel).
  const llmApi = step.kind === "llm" ? resolveLlmStepApi(step, ctx.deps.agentConfig) : undefined;
  const childApi =
    step.kind === "llm" ? (llmApi?.ok ? llmApi.api.id : llmStepApiId(step)) : undefined;
  const childModel = llmApi?.ok ? llmApi.model : step.model;
  const runChild = (childId: string, item: WorkflowItem): Promise<StepResult> =>
    step.kind === "llm"
      ? executeLlmStep(step, ctx, hooks, childId, item)
      : executeAgentStep(step, ctx, hooks, childId, item);
  const sourceStepId = parseForEachSource(step.forEach ?? "");
  const source = sourceStepId ? ctx.results.get(sourceStepId) : undefined;

  if (!sourceStepId || !source) {
    return {
      result: {
        stepId: step.id,
        ok: false,
        output: `forEach source '${step.forEach}' is unavailable`,
        error: `forEach source '${step.forEach}' is unavailable`,
        durationMs: Date.now() - started,
      },
    };
  }
  if (!source.ok) {
    return {
      result: {
        stepId: step.id,
        ok: false,
        output: `forEach source '${sourceStepId}' failed`,
        error: `forEach source '${sourceStepId}' failed`,
        durationMs: Date.now() - started,
      },
    };
  }

  const values = source.items ?? splitItemsFromOutput(source.output);
  if (!ctx.reserveDynamicSteps(values.length)) {
    return {
      result: {
        stepId: step.id,
        ok: false,
        output: `forEach would expand '${step.id}' by ${values.length} child steps beyond the workflow step budget`,
        error: `forEach would exceed max workflow steps (${MAX_STEPS})`,
        durationMs: Date.now() - started,
      },
    };
  }

  // Announce the resolved fan-out size before dispatching children, so consumers
  // (live reducers + history recorder) know how many child runs to expect even
  // if the run is canceled before the pool gets to all of them.
  hooks.pushWorkflowEvent({
    kind: "fan_out",
    phaseId: hooks.phaseId,
    parentStepId: step.id,
    count: values.length,
    iteration: ctx.iteration,
    ts: Date.now(),
  });

  const childResults: StepResult[] = values.map((_value, index) => ({
    stepId: `${step.id}[${index}]`,
    ok: false,
    output: "child failed before producing a result",
    durationMs: 0,
  }));
  const limit = Math.min(Math.max(1, ctx.deps.maxConcurrency), MAX_CONCURRENCY);
  // Per-step cost budget: once this fan-out's dispatched children have spent
  // `step.maxCostUsd`, stop dispatching new ones. Undispatched children are
  // never started (no events emitted) so they show as not-run and a resume
  // re-runs only them. `stepSpent` is safe to mutate without a lock — runPool
  // workers interleave only at `await` points, never truly in parallel.
  const stepSpent = { costUsd: 0 };
  let stepBudgetHit = false;
  const stepBudgetReached = (): boolean =>
    maxCostUsd !== undefined && stepSpent.costUsd >= maxCostUsd;
  await runPool(
    values.map((value, index) => ({
      value,
      item: { sourceStepId, index, value },
      stepId: `${step.id}[${index}]`,
    })),
    limit,
    async ({ value: _value, item, stepId }) => {
      // A child already in cache is a cheap replay — always allow it (it adds no
      // new spend), so a resume completes the fan-out. Only gate fresh work.
      if (!ctx.cache.get(stepId) && stepBudgetReached()) {
        if (!stepBudgetHit) {
          stepBudgetHit = true;
          hooks.pushWorkflowEvent({
            kind: "budget_exceeded",
            scope: "step",
            stepId: step.id,
            limitUsd: maxCostUsd as number,
            spentUsd: stepSpent.costUsd,
            iteration: ctx.iteration,
            ts: Date.now(),
          });
        }
        // Leave this child not-run (no events): it shows as a not-run placeholder
        // and a resume re-runs only the undispatched children.
        childResults[item.index] = {
          stepId,
          parentStepId: step.id,
          item,
          ok: false,
          notRun: true,
          output: "not run: step cost budget reached",
          error: "step cost budget reached",
          durationMs: 0,
          iteration: ctx.iteration,
        };
        return;
      }
      // A cached child replays a completed call: attribute it to the api/model
      // recorded on its result rather than a fresh (possibly drifted) resolution.
      const cached = ctx.cache.get(stepId);
      hooks.pushWorkflowEvent({
        kind: "step_start",
        phaseId: hooks.phaseId,
        stepId,
        blockKind: workflowStepKind(step),
        agent: childAgent,
        api: step.kind === "llm" ? (cached?.api ?? childApi) : undefined,
        model: step.kind === "llm" ? (cached?.model ?? childModel) : childModel,
        effort: step.effort,
        cwd: childCwd,
        dependsOn: step.dependsOn,
        parentStepId: step.id,
        item,
        iteration: ctx.iteration,
        ts: Date.now(),
      });

      const result = cached
        ? { ...cached, stepId, parentStepId: step.id, item, iteration: ctx.iteration }
        : {
            ...(await runChild(stepId, item)),
            stepId,
            parentStepId: step.id,
            item,
            iteration: ctx.iteration,
          };

      ctx.outputs.set(stepId, result.output);
      ctx.results.set(stepId, result);
      if (result.ok) ctx.cache.set(stepId, result);
      childResults[item.index] = result;
      // Count freshly-run children toward the per-step budget (cached replays
      // add no new spend). This gates whether later children still dispatch.
      if (!cached) stepSpent.costUsd += result.costUsd ?? 0;

      hooks.pushWorkflowEvent({
        kind: "step_done",
        phaseId: hooks.phaseId,
        stepId,
        result,
        cached: Boolean(cached),
        iteration: ctx.iteration,
        ts: Date.now(),
      });
    },
    ctx.signal,
  );

  const ok = childResults.length === values.length && childResults.every((child) => child.ok);
  const output = childResults
    .map((child) => `--- ${child.stepId} (${child.item?.value ?? "item"}) ---\n${child.output}`)
    .join("\n\n");

  const error = ok
    ? undefined
    : stepBudgetHit
      ? `step cost budget $${(maxCostUsd as number).toFixed(4)} reached after $${stepSpent.costUsd.toFixed(4)}`
      : "one or more fan-out items failed";

  return {
    result: {
      stepId: step.id,
      ok,
      output,
      items: values,
      childResults,
      error,
      durationMs: Date.now() - started,
      // Stamp llm parents like their children, so a resumed fan-out's parent
      // step_start replays with the api/model that actually ran.
      ...(step.kind === "llm" ? { api: childApi, model: childModel } : {}),
    },
    childResults,
  };
}

/**
 * Execute a `command` step: render the `cmd` template and run it through the
 * platform shell, inside the same per-step worktree isolation as agent steps.
 * Deterministic — no agent, no cost. The step is ok exactly when the command
 * exits 0; the exit code lands on the result for `{{steps.<id>.exitCode}}`.
 * Output (stdout+stderr interleaved) streams as `text_delta` step events so
 * long commands tail live in the TUI/web UI like agent steps do.
 */
async function executeCommandStep(
  step: CommandStep,
  ctx: ExecuteContext,
  hooks: ExecuteHooks,
): Promise<StepResult> {
  const started = Date.now();
  const cmd = renderPrompt(step.cmd, {
    input: ctx.input,
    inputs: ctx.inputs,
    outputs: ctx.outputs,
    results: ctx.results,
    iteration: ctx.iteration,
  });
  const stepCwd = step.cwd ? resolvePath(ctx.deps.cwd, step.cwd) : ctx.deps.cwd;

  let workspace: AgentWorkspaceLease;
  try {
    workspace = ctx.deps.agentWorkspace
      ? await ctx.deps.agentWorkspace.allocate({
          workflowName: ctx.workflowName,
          stepId: step.id,
          agent: "command",
          baseCwd: ctx.deps.cwd,
          stepCwd,
          iteration: ctx.iteration,
          inheritFrom: resolveInheritedWorkspace(step, ctx),
          signal: ctx.signal,
        })
      : { cwd: stepCwd, dispose: () => {} };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      stepId: step.id,
      ok: false,
      output: message,
      error: message,
      durationMs: Date.now() - started,
    };
  }
  pushWorkspaceEvent(hooks, ctx, step.id, workspace, stepCwd);

  try {
    const timeoutSec = resolveStepTimeoutSec(
      step,
      { stepTimeoutSec: ctx.stepTimeoutDefault },
      { stepTimeoutSec: ctx.deps.stepTimeoutSec },
    );
    const run = await runShellCommand(cmd, {
      cwd: workspace.cwd,
      env: step.env,
      timeoutMs: timeoutMsFromSec(timeoutSec),
      signal: ctx.signal,
      onChunk: (text) => {
        hooks.pushAgentEvent(step.id, {
          kind: "text_delta",
          agent: "command",
          ts: Date.now(),
          text,
        });
      },
    });

    const error = run.cancelled
      ? "cancelled"
      : run.timedOut
        ? `command timed out after ${timeoutSec}s`
        : run.spawnError
          ? `command failed to start: ${run.spawnError}`
          : run.exitCode === undefined
            ? "command was killed before exiting"
            : run.exitCode !== 0
              ? `command exited with code ${run.exitCode}`
              : undefined;

    // Unlike agent steps, a failed command keeps its captured output as the
    // step output (the diagnostics ARE the output); the error is appended so
    // downstream prompts and the UIs see both.
    const output = error
      ? [run.output.trimEnd(), `[${error}]`].filter(Boolean).join("\n")
      : run.output;
    let result: StepResult = {
      stepId: step.id,
      ok: error === undefined,
      output,
      error,
      exitCode: run.exitCode,
      durationMs: Date.now() - started,
    };
    if (result.ok && step.output) {
      const parsed = parseStructuredOutput(result.output, step.output);
      // No "fix your JSON" retry here — the command is deterministic, so a
      // mismatch is a real contract violation and re-running can't change it.
      result = parsed.ok
        ? { ...result, json: parsed.value }
        : {
            ...result,
            ok: false,
            error: `structured output invalid: ${parsed.error}`,
          };
    }
    result = await applyDeclaredArtifacts(step, ctx, step.id, workspace.cwd, result);
    return attachWorktreeInfo(result, workspace, stepCwd);
  } finally {
    await workspace.dispose();
  }
}

/** Exact USD cost from the effective per-MTok rates and the API-reported usage. */
function llmCostUsd(
  pricing: LlmPricing | undefined,
  tokens: TokenUsage | undefined,
): number | undefined {
  if (!pricing || !tokens) return undefined;
  const per = (count: number | undefined, rate: number | undefined): number =>
    ((count ?? 0) * (rate ?? 0)) / 1_000_000;
  return (
    per(tokens.input, pricing.inputPerMTok) +
    per(tokens.output, pricing.outputPerMTok) +
    per(tokens.cacheRead, pricing.cacheReadPerMTok) +
    per(tokens.cacheWrite, pricing.cacheWritePerMTok)
  );
}

/**
 * The effective call settings an `llm` step resolved against its API instance:
 * the step's own fields override the instance's, which override the provider
 * conventions (see `resolveLlmStepApi`). Computed once per step execution and
 * threaded through every attempt (including the structured-output fix retry).
 */
interface LlmCallSettings {
  /** Resolved API instance id, recorded on results for spend attribution. */
  api: string;
  provider: LlmProviderId;
  model: string;
  apiKey: string;
  baseUrl?: string;
  pricing?: LlmPricing;
}

/**
 * One completion call for an `llm` step, wrapped into the StepResult shape.
 * Streams the completion text as a `text_delta` step event (like command steps
 * do) so the TUI/web live views show the output as it lands.
 */
async function runLlmAttempt(
  step: LlmStep,
  ctx: ExecuteContext,
  hooks: ExecuteHooks,
  stepId: string,
  item: WorkflowItem | undefined,
  prompt: string,
  system: string | undefined,
  settings: LlmCallSettings,
  timeoutMs: number,
): Promise<{ result: StepResult; retryable: boolean }> {
  const started = Date.now();
  const complete = ctx.deps.llmComplete ?? callLlm;
  let outcome: LlmCallResult;
  try {
    outcome = await complete({
      provider: settings.provider,
      model: settings.model,
      prompt,
      system,
      maxTokens: step.maxTokens,
      temperature: step.temperature,
      effort: step.effort,
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      jsonOutput: step.output !== undefined,
      timeoutMs,
      signal: ctx.signal,
    });
  } catch (err) {
    // The injected transport should never throw, but a throw is by definition
    // "the call may not have completed" — treat like a transport error.
    outcome = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      retryable: true,
    };
  }

  const cancelled = Boolean(ctx.signal?.aborted);
  if (outcome.ok && !cancelled) {
    if (outcome.text) {
      hooks.pushAgentEvent(stepId, {
        kind: "text_delta",
        agent: "llm",
        ts: Date.now(),
        text: outcome.text,
      });
    }
    return {
      result: {
        stepId,
        ok: true,
        output: outcome.text,
        item,
        durationMs: Date.now() - started,
        costUsd: llmCostUsd(settings.pricing, outcome.tokens),
        tokens: outcome.tokens,
        api: settings.api,
        model: settings.model,
      },
      retryable: false,
    };
  }
  // Reached when cancelled OR the call failed; a cancel wins the label even
  // if the (raced) call happened to complete.
  const error = !outcome.ok && !cancelled ? outcome.error : "cancelled";
  return {
    result: {
      stepId,
      ok: false,
      output: error,
      item,
      error,
      durationMs: Date.now() - started,
      costUsd: outcome.ok ? llmCostUsd(settings.pricing, outcome.tokens) : undefined,
      tokens: outcome.ok ? outcome.tokens : undefined,
      api: settings.api,
      model: settings.model,
    },
    // A cancelled step is never retried (and never cached, so resume re-runs it).
    retryable: !cancelled && !outcome.ok && outcome.retryable,
  };
}

/**
 * Execute an `llm` step: render the prompt/system templates, make one
 * stateless completion call, and (when an `output` schema is declared) enforce
 * structured output with the same one-bounded-fix-retry contract agent steps
 * get. No workspace, no worktree, no doctor dependency — the only external
 * requirement is the provider API key in the environment.
 *
 * Transient failures (rate limit / 5xx / network / timeout) are auto-retried
 * under the step/workflow retry policy: unlike agent attempts, an llm call is
 * stateless and side-effect-free, so retry is always safe.
 */
async function executeLlmStep(
  step: LlmStep,
  ctx: ExecuteContext,
  hooks: ExecuteHooks,
  stepId: string,
  item?: WorkflowItem,
): Promise<StepResult> {
  const started = Date.now();
  const renderCtx = {
    input: ctx.input,
    inputs: ctx.inputs,
    outputs: ctx.outputs,
    results: ctx.results,
    item,
    iteration: ctx.iteration,
  };
  const rendered = renderPrompt(step.prompt, renderCtx);
  const system = step.system ? renderPrompt(step.system, renderCtx) : undefined;
  const outputSchema = step.output;
  const prompt = outputSchema ? withStructuredOutputInstructions(rendered, outputSchema) : rendered;

  const resolved = resolveLlmStepApi(step, ctx.deps.agentConfig);
  if (!resolved.ok) {
    return {
      stepId,
      ok: false,
      output: resolved.error,
      item,
      error: resolved.error,
      durationMs: Date.now() - started,
    };
  }
  const apiKey = process.env[resolved.apiKeyEnv];
  if (!apiKey && !resolved.keyless) {
    const message = `llm step requires an API key in the ${resolved.apiKeyEnv} environment variable (api '${resolved.api.id}')`;
    return {
      stepId,
      ok: false,
      output: message,
      item,
      error: message,
      durationMs: Date.now() - started,
    };
  }
  const settings: LlmCallSettings = {
    api: resolved.api.id,
    provider: resolved.provider,
    model: resolved.model,
    // Keyless instances (e.g. opencode-zen free models) send no auth header.
    apiKey: apiKey ?? "",
    baseUrl: resolved.baseUrl,
    pricing: resolved.pricing,
  };

  const timeoutSec = resolveStepTimeoutSec(
    step,
    { stepTimeoutSec: ctx.stepTimeoutDefault },
    { stepTimeoutSec: ctx.deps.stepTimeoutSec },
  );
  const timeoutMs = timeoutMsFromSec(timeoutSec);
  const policy = resolveRetryPolicy(step.retry, ctx.retryDefault);

  let attempt = 0;
  let result: StepResult;
  while (true) {
    attempt += 1;
    const attemptOutcome = await runLlmAttempt(
      step,
      ctx,
      hooks,
      stepId,
      item,
      prompt,
      system,
      settings,
      timeoutMs,
    );
    result = attemptOutcome.result;
    const isLastAttempt = attempt >= policy.maxAttempts;
    if (result.ok || !attemptOutcome.retryable || isLastAttempt || ctx.signal?.aborted) break;
    const delayMs = backoffDelayMs(policy, attempt);
    hooks.pushWorkflowEvent({
      kind: "step_retry",
      phaseId: hooks.phaseId,
      stepId,
      attempt,
      maxAttempts: policy.maxAttempts,
      delayMs,
      reason: result.error ?? "transient failure",
      iteration: ctx.iteration,
      ts: Date.now(),
    });
    await abortableSleep(delayMs, ctx.signal);
    if (ctx.signal?.aborted) break;
  }

  if (outputSchema && result.ok) {
    const enforced = await enforceLlmStructuredOutput(
      step,
      ctx,
      hooks,
      stepId,
      item,
      result,
      outputSchema,
      settings,
      timeoutMs,
      attempt,
    );
    result = enforced.result;
    attempt = enforced.attempt;
  }

  if (result.ok && step.itemsPath !== undefined) {
    const source = jsonPathGet(result.json, step.itemsPath);
    if (!Array.isArray(source)) {
      const message = `llm structured output at itemsPath '${step.itemsPath}' is not a JSON array`;
      result = { ...result, ok: false, output: message, error: message };
    } else {
      result = { ...result, items: source.map(jsonFieldText) };
    }
  } else if (result.ok && Array.isArray(result.json)) {
    // A bare-array structured output is a splitter by construction; expose the
    // elements as items so `forEach` consumers can fan out over them.
    result = { ...result, items: result.json.map(jsonFieldText) };
  }

  return attempt > 1 ? { ...result, attempts: attempt, durationMs: Date.now() - started } : result;
}

/**
 * The llm-step analog of {@link enforceStructuredOutput}: parse + validate the
 * completion against the step's `output` schema, and on a mismatch run ONE
 * bounded "fix your JSON" retry. Costs and tokens of the extra call are summed
 * into the returned result.
 */
async function enforceLlmStructuredOutput(
  step: LlmStep,
  ctx: ExecuteContext,
  hooks: ExecuteHooks,
  stepId: string,
  item: WorkflowItem | undefined,
  result: StepResult,
  outputSchema: JsonSchema,
  settings: LlmCallSettings,
  timeoutMs: number,
  attempt: number,
): Promise<{ result: StepResult; attempt: number }> {
  const parsed = parseStructuredOutput(result.output, outputSchema);
  if (parsed.ok) return { result: { ...result, json: parsed.value }, attempt };
  if (ctx.signal?.aborted) {
    return {
      result: { ...result, ok: false, error: `structured output invalid: ${parsed.error}` },
      attempt,
    };
  }
  hooks.pushWorkflowEvent({
    kind: "step_retry",
    phaseId: hooks.phaseId,
    stepId,
    attempt,
    maxAttempts: attempt + 1,
    delayMs: 0,
    reason: `structured output invalid: ${parsed.error}`,
    iteration: ctx.iteration,
    ts: Date.now(),
  });
  const fix = await runLlmAttempt(
    step,
    ctx,
    hooks,
    stepId,
    item,
    structuredOutputFixPrompt(outputSchema, result.output, parsed.error),
    step.system
      ? renderPrompt(step.system, {
          input: ctx.input,
          inputs: ctx.inputs,
          outputs: ctx.outputs,
          results: ctx.results,
          item,
          iteration: ctx.iteration,
        })
      : undefined,
    settings,
    timeoutMs,
  );
  const costUsd =
    result.costUsd === undefined && fix.result.costUsd === undefined
      ? undefined
      : (result.costUsd ?? 0) + (fix.result.costUsd ?? 0);
  const tokens =
    result.tokens || fix.result.tokens ? addTokens(result.tokens, fix.result.tokens) : undefined;
  const reparsed = fix.result.ok
    ? parseStructuredOutput(fix.result.output, outputSchema)
    : undefined;
  if (reparsed?.ok) {
    return {
      result: { ...fix.result, json: reparsed.value, costUsd, tokens },
      attempt: attempt + 1,
    };
  }
  const reason = reparsed ? reparsed.error : (fix.result.error ?? "the retry attempt failed");
  return {
    result: {
      ...fix.result,
      ok: false,
      error: `structured output retry failed: ${reason}`,
      costUsd,
      tokens,
    },
    attempt: attempt + 1,
  };
}

/** The last step (by array position, NOT chronological completion order) of a spec's last phase. Deterministic default output source for a `workflow` step that omits `outputStep`. */
function lastStepId(spec: WorkflowSpec): string | undefined {
  const lastPhase = spec.phases[spec.phases.length - 1];
  const steps = lastPhase?.steps ?? [];
  return steps[steps.length - 1]?.id;
}

/**
 * Execute a `workflow` step: recursively run another named workflow (resolved
 * via `ctx.deps.resolveWorkflow`) and fold its event stream into this run's
 * own, under the namespace `<thisStepId>::<childId>` for both phase and step
 * ids. The child's leaf step results become this step's `childResults` —
 * exactly the shape a `forEach` fan-out parent already produces — so the
 * existing cost/token summation (`runSingleStep`) and run-history flattening
 * (`computeRunTotals`, which already skips any step whose result carries
 * `childResults`) apply completely unmodified. Cycle/depth-guarded via
 * `ctx.workflowCallStack`; never itself allocates a worktree (no agent, no
 * `WorkspaceFields`) — the child's own steps handle that internally.
 */
async function executeWorkflowStep(
  step: WorkflowCallStep,
  ctx: ExecuteContext,
  hooks: ExecuteHooks,
): Promise<ExecutionOutcome> {
  const started = Date.now();
  const fail = (message: string): ExecutionOutcome => ({
    result: {
      stepId: step.id,
      ok: false,
      output: message,
      error: message,
      durationMs: Date.now() - started,
    },
  });

  const resolveWorkflow = ctx.deps.resolveWorkflow;
  if (!resolveWorkflow) {
    return fail("workflow steps are not supported in this context (no resolveWorkflow configured)");
  }
  const childSpec = resolveWorkflow(step.workflow);
  if (!childSpec) return fail(`unknown workflow '${step.workflow}'`);

  // `ctx.workflowCallStack` tracks workflows already entered via a `workflow`
  // step; a non-root spec's own name is already its last entry (its parent
  // appended it before recursing). The root run's call stack starts `[]` and
  // never gets its own name pushed (per `WorkflowRunContext.workflowCallStack`
  // — "callers starting a top-level run should never set this"), so a root
  // spec invoking itself (or being re-entered indirectly) wouldn't otherwise
  // show up in `stack`. Fold `ctx.workflowName` in so cycle/depth accounting
  // is uniform regardless of nesting level.
  const stack = ctx.workflowCallStack.includes(ctx.workflowName)
    ? ctx.workflowCallStack
    : [...ctx.workflowCallStack, ctx.workflowName];
  if (stack.includes(step.workflow)) {
    return fail(`workflow cycle detected: ${[...stack, step.workflow].join(" -> ")}`);
  }
  if (stack.length >= MAX_WORKFLOW_NESTING_DEPTH) {
    return fail(
      `workflow nesting depth exceeded ${MAX_WORKFLOW_NESTING_DEPTH} (invoking '${step.workflow}')`,
    );
  }

  const childInput = step.input
    ? renderPrompt(step.input, {
        input: ctx.input,
        inputs: ctx.inputs,
        outputs: ctx.outputs,
        results: ctx.results,
        iteration: ctx.iteration,
      })
    : ctx.input;

  const namespace = (id: string): string => `${step.id}::${id}`;
  const childResults: StepResult[] = [];
  const rawResults = new Map<string, StepResult>();
  let childOk = false;

  // Translated events below carry `iteration` (and `result.iteration`)
  // straight through via `...event`/`...event.result` — that's always the
  // CHILD run's own independent loop-iteration counter, not this parent
  // spec's current iteration. If this `workflow` step sits inside a
  // loop-back gate's body (`runPhasedScheduler`) and the parent loop re-runs
  // it multiple times, every pass's namespaced nested steps will show
  // whatever iteration the child run itself was on (typically always 1),
  // not the parent's 1/2/3… — a live-view/history display limitation only,
  // not a cost/correctness bug (see docs/superpowers/plans/2026-07-04-sub-workflows.md,
  // "Post-plan follow-ups").
  for await (const event of runWorkflow(
    childSpec,
    { input: childInput, workflowCallStack: [...stack, step.workflow] },
    // The steering control stays with the top-level run: a sub-run is one
    // in-flight step from the parent's point of view (a pause waits for it),
    // and forwarding the control would re-bind its edit validation to the
    // child spec mid-run.
    { ...ctx.deps, control: undefined },
    ctx.signal,
  )) {
    switch (event.kind) {
      case "workflow_start":
        break;
      case "workflow_done":
        childOk = event.ok;
        break;
      case "phase_start":
      case "phase_done":
        hooks.pushWorkflowEvent({ ...event, phaseId: namespace(event.phaseId) });
        break;
      case "step_start":
        hooks.pushWorkflowEvent({
          ...event,
          phaseId: namespace(event.phaseId),
          stepId: namespace(event.stepId),
          parentStepId: event.parentStepId ? namespace(event.parentStepId) : step.id,
          dependsOn: event.dependsOn?.map(namespace),
          loopTo: event.loopTo ? namespace(event.loopTo) : undefined,
        });
        break;
      case "step_done": {
        rawResults.set(event.result.stepId, event.result);
        // Only this event's own top-level stepId/parentStepId get namespaced
        // here. If `event.result` itself carries a nested `childResults`
        // array (e.g. this child step was itself a `forEach` fan-out parent,
        // or itself a nested `workflow` step), that array's own inner ids are
        // left as whatever id they already carried one level down (raw or
        // namespaced-once, never re-namespaced at this level). This is
        // intentional, not a bug: a fan-out/nested-workflow wrapper's own
        // result never carries `costUsd` (see `runSingleStep`), so cost
        // summation is unaffected, and `computeRunTotals` derives totals
        // from the flat, already-namespaced `step_done` *event* stream —
        // it never walks into `childResults` — so nothing actually reads
        // these inner ids for anything that would be namespace-sensitive.
        const namespaced: StepResult = {
          ...event.result,
          stepId: namespace(event.result.stepId),
          parentStepId: event.result.parentStepId ? namespace(event.result.parentStepId) : step.id,
        };
        childResults.push(namespaced);
        hooks.pushWorkflowEvent({
          ...event,
          phaseId: namespace(event.phaseId),
          stepId: namespace(event.stepId),
          result: namespaced,
        });
        break;
      }
      case "step_event":
      case "step_retry":
      case "gate_evaluated":
      case "step_workspace":
        hooks.pushWorkflowEvent({
          ...event,
          phaseId: namespace(event.phaseId),
          stepId: namespace(event.stepId),
        });
        break;
      case "approval_pending":
        hooks.pushWorkflowEvent({
          ...event,
          phaseId: namespace(event.phaseId),
          stepId: namespace(event.stepId),
          // The reviewed step lives in the child run too — namespace it so it
          // matches the namespaced step in the surfaced tree.
          reviewStepId: event.reviewStepId ? namespace(event.reviewStepId) : undefined,
        });
        break;
      case "approval_resolved":
        hooks.pushWorkflowEvent({
          ...event,
          phaseId: namespace(event.phaseId),
          stepId: namespace(event.stepId),
        });
        break;
      // Human-input requests (human steps / canAsk questions) must surface at
      // the parent level like approvals do, or a nested ask would block the
      // child run with no UI able to discover or answer it.
      case "human_input_pending":
      case "human_input_resolved":
        hooks.pushWorkflowEvent({
          ...event,
          phaseId: namespace(event.phaseId),
          stepId: namespace(event.stepId),
        });
        break;
      case "fan_out":
        hooks.pushWorkflowEvent({
          ...event,
          phaseId: namespace(event.phaseId),
          parentStepId: namespace(event.parentStepId),
        });
        break;
      case "loop_iteration":
        hooks.pushWorkflowEvent({
          ...event,
          gateStepId: namespace(event.gateStepId),
          loopTo: namespace(event.loopTo),
        });
        break;
      case "budget_exceeded":
        // A step-scoped breach carries a child stepId we namespace; a
        // workflow-scoped breach (the child run hitting its own maxCostUsd)
        // has no stepId and passes through as-is — it describes the child
        // run's budget, not a step, and the child's partial leaf costs still
        // roll up via `childResults` so the parent's accounting stays correct.
        hooks.pushWorkflowEvent(
          event.stepId ? { ...event, stepId: namespace(event.stepId) } : event,
        );
        break;
    }
  }

  const outputStepId = step.outputStep ?? lastStepId(childSpec);
  const outputResult = outputStepId ? rawResults.get(outputStepId) : undefined;
  if (!outputResult) {
    return fail(
      step.outputStep
        ? `outputStep '${step.outputStep}' did not produce a result in workflow '${step.workflow}'`
        : `workflow '${step.workflow}' produced no step results`,
    );
  }

  return {
    result: {
      stepId: step.id,
      ok: childOk,
      output: outputResult.output,
      json: outputResult.json,
      error: childOk ? undefined : `sub-workflow '${step.workflow}' did not complete successfully`,
      durationMs: Date.now() - started,
      childResults,
    },
    childResults,
  };
}

/**
 * Execute a `merge` step: collect the source steps' recorded worktrees (a
 * fan-out parent contributes every child worktree), merge them in an isolated
 * staging worktree, and deliver per `mode` — apply to the user's checkout,
 * leave a branch, or push + open a PR. Deterministic except for
 * `onConflict: "agent"`, where the configured agent is launched inside the
 * staging worktree to resolve real conflict markers; its cost/tokens are
 * accounted to this step.
 */
async function executeMergeStep(
  step: MergeStep,
  ctx: ExecuteContext,
  hooks: ExecuteHooks,
): Promise<ExecutionOutcome> {
  const started = Date.now();
  let conflictCostUsd = 0;
  let conflictTokens: TokenUsage | undefined;
  const fail = (message: string): ExecutionOutcome => ({
    result: {
      stepId: step.id,
      ok: false,
      output: message,
      error: message,
      durationMs: Date.now() - started,
      costUsd: conflictCostUsd > 0 ? conflictCostUsd : undefined,
      tokens: conflictTokens,
    },
  });

  let repoRoot: string;
  try {
    repoRoot = (
      await runGitText(["rev-parse", "--show-toplevel"], ctx.deps.cwd, ctx.signal)
    ).trim();
  } catch {
    return fail(`merge step '${step.id}' requires the workflow to run inside a git repository`);
  }

  const sourceIds = step.from ?? step.dependsOn ?? [];
  const sources: WorktreeSource[] = [];
  const missingWorktrees: string[] = [];
  for (const id of sourceIds) {
    const result = ctx.results.get(id);
    if (!result) return fail(`merge source '${id}' has no result`);
    if (result.skipped) continue;
    // Judge fan-out sources leaf by leaf, not by the parent's ok flag: a
    // parent is not-ok when ANY child failed or never ran (budget), but
    // skipped/not-run children are simply absent from the merge — only a
    // child that actually failed poisons it and fails the step.
    const leaves = result.childResults?.length ? result.childResults : [result];
    for (const leaf of leaves) {
      if (leaf.skipped || leaf.notRun) continue;
      if (!leaf.ok) return fail(`merge source '${leaf.stepId}' failed; nothing was merged`);
      if (leaf.worktree) sources.push(worktreeSourceFromInfo(leaf.stepId, leaf.worktree));
      else missingWorktrees.push(leaf.stepId);
    }
  }
  if (sources.length === 0) {
    return fail(
      missingWorktrees.length > 0
        ? `merge step '${step.id}': no worktrees recorded for ${missingWorktrees.join(", ")} (only worker/processor/command steps get worktrees, and only inside a git repository; gate/llm/consolidator steps never produce one)`
        : `merge step '${step.id}' has no source worktrees to merge`,
    );
  }

  const mode = step.mode ?? "apply";
  const onConflict = step.onConflict ?? "fail";
  const render = (text: string | undefined): string | undefined =>
    text === undefined
      ? undefined
      : renderPrompt(text, {
          input: ctx.input,
          inputs: ctx.inputs,
          outputs: ctx.outputs,
          results: ctx.results,
          iteration: ctx.iteration,
        });

  const resolver: ConflictResolver | undefined =
    onConflict === "agent"
      ? async ({ stagingRoot, stepId: sourceStepId, files }) => {
          // Synthetic one-shot step for the conflict-resolution turn. The
          // schema guarantees agent+model whenever onConflict is "agent"
          // (workflowMergeStepSchema's superRefine), hence the casts. The
          // `kind: "processor"` label only describes the attempt to event
          // consumers — runAgentAttempt reads agent/model/effort/env/
          // extraArgs/stepTimeoutSec plus the prompt argument and never
          // dispatches on kind (this does NOT go through executeStep).
          const synthetic: AgentBackedWorkflowStep = {
            id: step.id,
            kind: "processor",
            agent: step.agent as AgentInstanceId,
            model: step.model as string,
            effort: step.effort,
            env: step.env,
            extraArgs: step.extraArgs,
            stepTimeoutSec: step.stepTimeoutSec,
            prompt: "",
          };
          const prompt = conflictResolutionPrompt(sourceStepId, files, render(step.prompt));
          const attempt = await runAgentAttempt(
            synthetic,
            ctx,
            hooks,
            step.id,
            undefined,
            prompt,
            stagingRoot,
          );
          conflictCostUsd += attempt.result.costUsd ?? 0;
          if (attempt.result.tokens) {
            conflictTokens = addTokens(conflictTokens, attempt.result.tokens);
          }
          if (!attempt.result.ok) {
            throw new Error(
              `conflict-resolution agent failed: ${attempt.result.error ?? "unknown error"}`,
            );
          }
        }
      : undefined;
  const strategyOption = onConflict === "ours" || onConflict === "theirs" ? onConflict : undefined;

  const harvests: HarvestResult[] = [];
  try {
    if (step.perSource) {
      const branchBase = render(step.branch);
      for (const [index, source] of sources.entries()) {
        harvests.push(
          await harvestWorktrees({
            repoRoot,
            sources: [source],
            mode,
            branchName: branchBase
              ? `${branchBase}-${index}`
              : defaultHarvestBranchName(source.stepId),
            commitMessage: render(step.commitMessage),
            prTitle: render(step.prTitle),
            prBody: render(step.prBody),
            strategyOption,
            resolveConflicts: resolver,
            signal: ctx.signal,
          }),
        );
      }
    } else {
      harvests.push(
        await harvestWorktrees({
          repoRoot,
          sources,
          mode,
          // `||`, not `??`: a branch template that renders to "" (e.g. an
          // empty step output) must still fall back to a generated name.
          branchName: render(step.branch) || defaultHarvestBranchName(step.id),
          commitMessage: render(step.commitMessage),
          prTitle: render(step.prTitle),
          prBody: render(step.prBody),
          strategyOption,
          resolveConflicts: resolver,
          signal: ctx.signal,
        }),
      );
    }
  } catch (err) {
    const base = err instanceof Error ? err.message : String(err);
    return fail(
      err instanceof MergeConflictError
        ? `${base}\nhint: ${mergeConflictGuidance("merge-step")}`
        : base,
    );
  }
  if (ctx.signal?.aborted) return fail("cancelled");

  // Lifecycle closure: with `cleanup: true` the delivered result (applied
  // diff / merged branch / PR) is the durable copy, so the source worktrees
  // and their steamtrain branches are discarded now instead of accumulating
  // in $TMPDIR + `git branch` until a manual prune. Only reached when every
  // harvest succeeded; failures keep the worktrees for post-mortem harvesting.
  const cleaned: string[] = [];
  if (step.cleanup) {
    // Dedupe by root defensively; the engine allocates a unique worktree per
    // leaf, so in practice each root maps to exactly one stepId.
    const byRoot = new Map(sources.map((source) => [source.root, source]));
    for (const source of byRoot.values()) {
      if (ctx.signal?.aborted) break;
      // The boolean return (did `git worktree remove` itself succeed) is
      // deliberately ignored: pruneWorktree still rm -rf's the directory and
      // deletes the branch afterwards, so "cleaned" means "discarded", not
      // "every git command succeeded".
      await pruneWorktree(source, repoRoot);
      cleaned.push(source.stepId);
    }
  }

  const merged = harvests.flatMap((h) => h.mergedSources);
  const unchanged = harvests.flatMap((h) => h.unchangedSources);
  const conflicts = harvests.flatMap((h) =>
    h.conflicts.map((c) => ({ stepId: c.stepId, files: c.files, resolvedBy: c.resolvedBy })),
  );
  const branches = harvests.map((h) => h.branch).filter((b): b is string => Boolean(b));
  const prUrls = harvests.map((h) => h.prUrl).filter((u): u is string => Boolean(u));
  const additions = harvests.reduce((n, h) => n + h.additions, 0);
  const deletions = harvests.reduce((n, h) => n + h.deletions, 0);
  const fileCount = harvests.reduce((n, h) => n + h.files.length, 0);
  const noChanges = harvests.every((h) => h.noChanges);

  const lines: string[] = [];
  if (noChanges) {
    lines.push(`no changes to merge (${unchanged.length} unchanged worktree(s))`);
  } else {
    const target =
      mode === "apply"
        ? `applied to ${repoRoot} (uncommitted)`
        : mode === "branch"
          ? `left on branch ${branches.join(", ")}`
          : `opened PR ${prUrls.join(", ")}`;
    lines.push(
      `merged ${merged.length} worktree(s): ${fileCount} file(s) +${additions} -${deletions} — ${target}`,
    );
    for (const h of harvests) {
      for (const f of h.files)
        lines.push(`  ${f.status} ${f.path} (+${f.additions} -${f.deletions})`);
    }
  }
  if (conflicts.length > 0) {
    for (const c of conflicts) {
      lines.push(
        `conflicts in ${c.files.join(", ")} (from ${c.stepId}) resolved by ${c.resolvedBy}`,
      );
    }
  }
  if (unchanged.length > 0 && !noChanges) lines.push(`unchanged: ${unchanged.join(", ")}`);
  if (missingWorktrees.length > 0) lines.push(`no worktree: ${missingWorktrees.join(", ")}`);
  if (cleaned.length > 0) {
    lines.push(`cleaned up ${cleaned.length} source worktree(s): ${cleaned.join(", ")}`);
  }

  return {
    result: {
      stepId: step.id,
      ok: true,
      output: lines.join("\n"),
      json: {
        mode,
        merged,
        unchanged,
        missingWorktrees,
        files: harvests.flatMap((h) => h.files),
        additions,
        deletions,
        conflicts,
        branches,
        prUrls,
        noChanges,
        cleaned,
      },
      durationMs: Date.now() - started,
      costUsd: conflictCostUsd > 0 ? conflictCostUsd : undefined,
      tokens: conflictTokens,
    },
  };
}

/** The built-in prompt for the conflict-resolution agent (LLM-driven merges). */
function conflictResolutionPrompt(
  sourceStepId: string,
  files: string[],
  extraGuidance?: string,
): string {
  return [
    "You are resolving git merge conflicts in the current working directory (a staging worktree; a merge is in progress).",
    `Merging the changes from workflow step '${sourceStepId}' left git conflict markers (<<<<<<< / ======= / >>>>>>>) in these files:`,
    ...files.map((f) => `- ${f}`),
    "",
    `Edit each conflicted file to a correct, coherent resolution that preserves the intent of BOTH sides wherever possible. Remove every conflict marker. Do not resolve by blindly picking one side unless the changes are genuinely incompatible. Do not run 'git commit' and do not abort the merge — just fix the files and stop.`,
    extraGuidance ? `\nAdditional guidance:\n${extraGuidance}` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n");
}

function splitItemsFromOutput(output: string | undefined): string[] {
  return output
    ? output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
}

function findFailedDependency(
  step: WorkflowStep,
  results: Map<string, StepResult>,
): string | undefined {
  const mergeSources =
    step.kind === "merge" ? new Set(step.from ?? step.dependsOn ?? []) : undefined;
  // Workspace-inherit and session-continue sources are implicit dependencies:
  // a step can neither start from the worktree nor resume the session of a
  // step that failed. (`continue:<ownId>` self-references are not deps.)
  const deps = [...(step.dependsOn ?? [])];
  for (const implicitDep of [workspaceSourceId(step), sessionSourceId(step)]) {
    if (implicitDep && implicitDep !== step.id && !deps.includes(implicitDep)) {
      deps.push(implicitDep);
    }
  }
  for (const dep of deps) {
    const result = results.get(dep);
    if (!result || result.ok) continue;
    // A merge step judges its sources leaf by leaf (executeMergeStep): a
    // fan-out source that is not-ok only because the budget stopped some
    // children before they ran still has completed worktrees to harvest.
    if (mergeSources?.has(dep) && isPartialFanOut(result)) continue;
    // A gate whose condition EXPLICITLY tests the dep's ok state has opted in
    // to inspecting failure ("loop until the tests pass" gates on a failing
    // `command` step's ok). Cascading would replace its evaluation with a
    // dependency-failed result, making "route on failure" unreachable whenever
    // the gate also declares the ordering dependency. Text-only conditions
    // (contains/matches/equals) assume the dep produced meaningful output and
    // keep the cascade: an errored agent mid-loop halts the loop rather than
    // burning the iteration budget re-running a persistent failure.
    if (step.kind === "gate" && step.condition.step === dep && step.condition.ok !== undefined) {
      continue;
    }
    return dep;
  }
  return undefined;
}

/**
 * A fan-out parent where every child either succeeded or never ran (budget
 * latch / skip) — no child actually failed — and at least one completed.
 */
function isPartialFanOut(result: StepResult): boolean {
  const leaves = result.childResults;
  if (!leaves?.length) return false;
  return (
    leaves.every((leaf) => leaf.ok || leaf.notRun || leaf.skipped) &&
    leaves.some((leaf) => leaf.ok && !leaf.notRun && !leaf.skipped)
  );
}

function dependencyFailedResult(stepId: string, dependencyId: string): StepResult {
  return {
    stepId,
    ok: false,
    output: `skipped: dependency '${dependencyId}' failed`,
    error: `dependency '${dependencyId}' failed`,
    durationMs: 0,
  };
}

/**
 * Why a step should be skipped (recorded as ok + `skipped: true`, not run),
 * or undefined to run it:
 *
 *  - its `when` condition evaluates false;
 *  - skip cascade: an explicit dependency (or its `forEach` source) was itself
 *    skipped. Consolidators are the exception — they treat skipped inputs as
 *    absent and merge the rest, so they only skip when EVERY dependency was
 *    skipped.
 *
 * Failed dependencies take precedence (checked by the caller before this) and
 * keep their existing not-ok semantics.
 */
function findSkipReason(step: WorkflowStep, ctx: GateEvalContext): string | undefined {
  const kind = workflowStepKind(step);
  // A merge step's sources are `from ?? dependsOn` (matching
  // executeMergeStep); like a consolidator it treats skipped sources as
  // absent and only skips when ALL of them were. When `from` is set, any
  // extra `dependsOn` entries are ordering-only and don't cascade skips.
  const dependsOn =
    step.kind === "merge" ? (step.from ?? step.dependsOn ?? []) : (step.dependsOn ?? []);
  const skippedDeps = dependsOn.filter((dep) => ctx.results.get(dep)?.skipped);
  if (kind === "consolidator" || kind === "merge") {
    if (dependsOn.length > 0 && skippedDeps.length === dependsOn.length) {
      return "all dependencies were skipped";
    }
  } else if (skippedDeps.length > 0) {
    return `dependency '${skippedDeps[0]}' was skipped`;
  }
  if ((step.kind === "worker" || step.kind === "processor" || !step.kind) && step.forEach) {
    const sourceStepId = parseForEachSource(step.forEach);
    if (sourceStepId && ctx.results.get(sourceStepId)?.skipped) {
      return `forEach source '${sourceStepId}' was skipped`;
    }
  }
  const wsSource = workspaceSourceId(step);
  if (wsSource && ctx.results.get(wsSource)?.skipped) {
    return `workspace source '${wsSource}' was skipped`;
  }
  const sessionSrc = sessionSourceId(step);
  if (sessionSrc && sessionSrc !== step.id && ctx.results.get(sessionSrc)?.skipped) {
    return `session source '${sessionSrc}' was skipped`;
  }
  if (step.when && !evaluateGate(step.when, ctx).passed) {
    return "when condition not met";
  }
  return undefined;
}

function skippedStepResult(stepId: string): StepResult {
  return {
    stepId,
    ok: true,
    skipped: true,
    // Empty output so downstream templates see a skipped step as absent.
    output: "",
    target: "skipped",
    durationMs: 0,
  };
}

/**
 * Sectioned merge of dependency outputs. Skipped dependencies are treated as
 * absent — their section is omitted entirely rather than rendered empty or
 * failed.
 */
function consolidateOutputs(
  ids: string[],
  outputs: Map<string, string>,
  results: Map<string, StepResult>,
  separator?: string,
): string {
  return ids
    .filter((id) => !results.get(id)?.skipped)
    .map((id) => `--- ${id} ---\n${outputs.get(id) ?? ""}`)
    .join(separator ?? "\n\n");
}

/** The subset of run state a gate/`when` condition evaluation needs. */
interface GateEvalContext {
  input: string;
  inputs?: Record<string, string | number | boolean>;
  outputs: Map<string, string>;
  results: Map<string, StepResult>;
  iteration: number;
}

/**
 * Execute a human-approval checkpoint: an `approval` step or a `gate` with
 * `condition.human`. Surfaces the reviewed step's output (and, when it ran in
 * an isolated worktree, its diff), emits `approval_pending`, awaits the injected
 * approval provider (racing the abort signal so a cancel unblocks it), emits
 * `approval_resolved`, and returns a gate-shaped outcome so the existing
 * `gate_evaluated` / reducer / history / loop machinery routes on it unchanged.
 *
 * The result carries `noCache` so a resumed run always re-asks — approvals are
 * never replayed from cache.
 */
async function executeApproval(
  step: ApprovalStep | GateStep,
  ctx: ExecuteContext,
  hooks: ExecuteHooks,
): Promise<ExecutionOutcome> {
  const started = Date.now();
  const isGate = step.kind === "gate";
  const target = step.target ?? "approved";
  // The step under review: an explicit `step` (approval) / `condition.step`
  // (gate), else the approval step's sole `dependsOn` entry.
  const reviewStepId = isGate
    ? step.condition.step
    : (step.step ?? (step.dependsOn?.length === 1 ? step.dependsOn[0] : undefined));
  // A gate's `onFalse` doubles as its reject disposition (default "continue" to
  // match plain gates); an approval step rejects with `onReject` (default "fail").
  const declaredOnReject: ApprovalRejectDisposition = isGate
    ? (step.onFalse ?? "continue")
    : (step.onReject ?? "fail");
  const message =
    !isGate && step.prompt
      ? renderPrompt(step.prompt, {
          input: ctx.input,
          inputs: ctx.inputs,
          outputs: ctx.outputs,
          results: ctx.results,
          iteration: ctx.iteration,
        })
      : undefined;

  const reviewed = reviewStepId ? ctx.results.get(reviewStepId) : undefined;
  const output =
    reviewed?.output !== undefined
      ? capApprovalText(reviewed.output, APPROVAL_OUTPUT_CAP)
      : undefined;
  const worktree = reviewed?.worktree;
  let diff: WorktreeDiff | undefined;
  if (reviewStepId && worktree) {
    try {
      const full = await worktreeDiff(worktreeSourceFromInfo(reviewStepId, worktree), {
        patch: true,
        signal: ctx.signal,
      });
      if (full.files.length > 0) {
        diff = {
          ...full,
          patch: full.patch ? capApprovalText(full.patch, APPROVAL_DIFF_CAP) : undefined,
        };
      }
    } catch {
      // A diff is best-effort context for the human — never fail the checkpoint
      // because git couldn't produce one.
    }
  }

  const request: ApprovalRequest = {
    stepId: step.id,
    phaseId: hooks.phaseId,
    iteration: ctx.iteration,
    reviewStepId,
    message,
    output,
    diff,
    worktree,
    onReject: declaredOnReject,
  };

  hooks.pushWorkflowEvent({
    kind: "approval_pending",
    phaseId: hooks.phaseId,
    stepId: step.id,
    reviewStepId,
    message,
    output,
    diff,
    worktree,
    onReject: declaredOnReject,
    iteration: ctx.iteration,
    ts: Date.now(),
  });

  const provider = ctx.deps.requestApproval;
  let decision: ApprovalDecision;
  if (provider) {
    try {
      decision = await requestApprovalWithAbort(provider, request, ctx.signal);
    } catch (err) {
      // A provider that rejects must not crash the run (runSingleStep never
      // throws): treat a provider error as a rejection so the checkpoint still
      // emits approval_resolved / step_done and any UI clears its pending state.
      decision = {
        approved: false,
        by: "auto:provider-error",
        note: `approval provider failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } else {
    decision = noProviderApprovalDecision(request);
  }

  hooks.pushWorkflowEvent({
    kind: "approval_resolved",
    phaseId: hooks.phaseId,
    stepId: step.id,
    approved: decision.approved,
    by: decision.by,
    note: decision.note,
    iteration: ctx.iteration,
    ts: Date.now(),
  });

  const passed = decision.approved;
  // A rejection may override the disposition (headless `--on-approval`); an
  // approval always continues (its onFalse is only a label then).
  const effectiveOnReject: "continue" | "fail" | "stop" = passed
    ? declaredOnReject
    : (decision.rejectDisposition ?? declaredOnReject);
  const ok = passed || effectiveOnReject === "continue";
  const label = passed ? target : "rejected";
  const error = ok ? undefined : (decision.note ?? "approval rejected");

  return {
    result: {
      stepId: step.id,
      ok,
      output: label,
      target: passed ? target : undefined,
      gate: { passed, onFalse: effectiveOnReject },
      error,
      durationMs: Date.now() - started,
      noCache: true,
    },
    gate: { passed, target: label, onFalse: effectiveOnReject },
    stop: !passed && (effectiveOnReject === "stop" || effectiveOnReject === "fail"),
  };
}

/** A canceled-mid-wait decision: reject without a disposition override. */
function canceledApprovalDecision(): ApprovalDecision {
  return { approved: false, by: "auto:canceled", note: "run canceled before a decision" };
}

/**
 * Await the provider, but resolve to a canceled decision if `signal` aborts
 * first — so a cancel/timeout during a pending approval unblocks the run
 * instead of hanging on a UI that will never answer. A well-behaved provider
 * also observes the same signal to tear down its own prompt.
 */
function requestApprovalWithAbort(
  provider: ApprovalProvider,
  request: ApprovalRequest,
  signal?: AbortSignal,
): Promise<ApprovalDecision> {
  if (!signal) return provider(request);
  if (signal.aborted) return Promise.resolve(canceledApprovalDecision());
  return new Promise<ApprovalDecision>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      resolve(canceledApprovalDecision());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    provider(request, signal).then(
      (decision) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(decision);
      },
      (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

// ── human input (`human` steps + `canAsk` clarifying questions) ─────────────

/** A canceled-mid-wait response: no value will arrive. */
function canceledHumanInputResponse(): HumanInputResponse {
  return { canceled: true, by: "auto:canceled", reason: "run canceled before an answer" };
}

/**
 * Await the human-input provider, but settle as canceled if `signal` aborts
 * first — so a cancel during a pending question unblocks the run instead of
 * hanging on a UI that will never answer. Mirrors
 * {@link requestApprovalWithAbort}.
 */
function requestHumanInputWithAbort(
  provider: HumanInputProvider,
  request: HumanInputRequest,
  signal?: AbortSignal,
): Promise<HumanInputResponse> {
  if (!signal) return provider(request);
  if (signal.aborted) return Promise.resolve(canceledHumanInputResponse());
  return new Promise<HumanInputResponse>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      resolve(canceledHumanInputResponse());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    provider(request, signal).then(
      (response) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(response);
      },
      (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

interface AskHumanSpec {
  stepId: string;
  /** Rendered instructions / question (uncapped; capped here for transport). */
  prompt: string;
  choices?: string[];
  outputSchema?: JsonSchema;
  origin: HumanInputOrigin;
}

type AskHumanOutcome =
  | { ok: true; output: string; json?: unknown; by?: string }
  | { ok: false; error: string };

/**
 * The shared ask loop behind `human` steps and `canAsk` clarifying questions:
 * emit `human_input_pending`, await the injected provider (racing the abort
 * signal), validate the answer against the step's contract, and re-ask (up to
 * {@link HUMAN_INPUT_MAX_ATTEMPTS}, with `retryError` explaining the
 * rejection) when it doesn't fit. Each re-ask supersedes the previous pending
 * event for the same step+iteration; a matching `human_input_resolved` is
 * emitted exactly once — when an answer is accepted, or when the ask ends
 * without one (canceled, or attempts exhausted).
 */
async function askHuman(
  ctx: ExecuteContext,
  hooks: ExecuteHooks,
  spec: AskHumanSpec,
): Promise<AskHumanOutcome> {
  const prompt = capHumanInputText(spec.prompt, HUMAN_INPUT_PROMPT_CAP);
  const resolvedBase = {
    kind: "human_input_resolved" as const,
    phaseId: hooks.phaseId,
    stepId: spec.stepId,
    origin: spec.origin,
    iteration: ctx.iteration,
  };
  let retryError: string | undefined;
  let lastBy: string | undefined;
  for (let attempt = 1; attempt <= HUMAN_INPUT_MAX_ATTEMPTS; attempt++) {
    const request: HumanInputRequest = {
      stepId: spec.stepId,
      phaseId: hooks.phaseId,
      iteration: ctx.iteration,
      attempt,
      prompt,
      choices: spec.choices,
      outputSchema: spec.outputSchema,
      origin: spec.origin,
      retryError,
    };
    hooks.pushWorkflowEvent({
      kind: "human_input_pending",
      phaseId: hooks.phaseId,
      stepId: spec.stepId,
      attempt,
      prompt,
      choices: spec.choices,
      outputSchema: spec.outputSchema,
      origin: spec.origin,
      retryError,
      iteration: ctx.iteration,
      ts: Date.now(),
    });

    const provider = ctx.deps.requestHumanInput;
    let response: HumanInputResponse;
    if (provider) {
      try {
        response = await requestHumanInputWithAbort(provider, request, ctx.signal);
      } catch (err) {
        // A provider that rejects must not crash the run: treat it as canceled
        // so the step still emits human_input_resolved and settles cleanly.
        response = {
          canceled: true,
          by: "auto:provider-error",
          reason: `human-input provider failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    } else {
      response = noProviderHumanInputResponse(request);
    }

    if (response.canceled) {
      hooks.pushWorkflowEvent({ ...resolvedBase, canceled: true, by: response.by, ts: Date.now() });
      return { ok: false, error: response.reason ?? "human input canceled" };
    }
    lastBy = response.by;
    const validation = validateHumanInputValue(response.value, {
      choices: spec.choices,
      outputSchema: spec.outputSchema,
    });
    if (validation.ok) {
      hooks.pushWorkflowEvent({
        ...resolvedBase,
        value: capHumanInputText(validation.output, HUMAN_INPUT_VALUE_CAP),
        by: response.by,
        ts: Date.now(),
      });
      return { ok: true, output: validation.output, json: validation.json, by: response.by };
    }
    retryError = validation.error;
  }
  hooks.pushWorkflowEvent({ ...resolvedBase, canceled: true, by: lastBy, ts: Date.now() });
  return {
    ok: false,
    error: `no acceptable answer after ${HUMAN_INPUT_MAX_ATTEMPTS} attempts: ${retryError}`,
  };
}

/**
 * Execute a `human` step: render the prompt (and choices), ask through the
 * injected provider, validate, and return the accepted value as the step's
 * result. Accepted answers ARE cached (unlike approval decisions) — they are
 * data, so a resumed run replays them instead of re-asking.
 */
async function executeHumanStep(
  step: HumanStep,
  ctx: ExecuteContext,
  hooks: ExecuteHooks,
): Promise<StepResult> {
  const started = Date.now();
  const templateContext = {
    input: ctx.input,
    inputs: ctx.inputs,
    outputs: ctx.outputs,
    results: ctx.results,
    iteration: ctx.iteration,
  };
  const prompt = renderPrompt(step.prompt, templateContext);
  let choices: string[] | undefined;
  if (step.choices) {
    choices = step.choices.map((choice) => renderPrompt(choice, templateContext).trim());
    if (choices.some((choice) => !choice)) {
      const message = `human step '${step.id}' has a choice that rendered empty`;
      return {
        stepId: step.id,
        ok: false,
        output: message,
        error: message,
        durationMs: Date.now() - started,
      };
    }
  }
  const ask = await askHuman(ctx, hooks, {
    stepId: step.id,
    prompt,
    choices,
    outputSchema: step.output,
    origin: "human-step",
  });
  if (!ask.ok) {
    return {
      stepId: step.id,
      ok: false,
      output: ask.error,
      error: ask.error,
      durationMs: Date.now() - started,
    };
  }
  return {
    stepId: step.id,
    ok: true,
    output: ask.output,
    json: ask.json,
    suppliedBy: ask.by,
    durationMs: Date.now() - started,
  };
}

/**
 * The protocol line appended to a `canAsk` step's prompt. Kept terse and
 * unambiguous: exactly one question, on a final marker line, only when
 * genuinely blocked — so the escape hatch can't turn a pipeline into a chat.
 */
export const AGENT_QUESTION_PROTOCOL =
  "\n\nIf — and only if — you are blocked on a single question you cannot resolve from the repository or the task itself, end your reply with one final line of the form:\nQUESTION: <your one question>\nOtherwise, complete the task without asking.";

/**
 * Extract a trailing clarifying question from an agent's final output: the
 * LAST line starting with `QUESTION:` plus everything after it (a question may
 * wrap). Returns undefined when the agent didn't ask.
 */
export function parseAgentQuestion(output: string): string | undefined {
  const marker = /^QUESTION:[ \t]*(\S[\s\S]*)$/m;
  const index = output.lastIndexOf("\nQUESTION:");
  const from = index >= 0 ? output.slice(index + 1) : output;
  const match = marker.exec(from);
  const question = match?.[1]?.trim();
  return question || undefined;
}

function evaluateGate(
  condition: GateCondition,
  ctx: GateEvalContext,
): { passed: boolean; message?: string } {
  const subject = condition.step ? ctx.results.get(condition.step) : undefined;
  // `path` narrows the inspected text to one field of the step's parsed
  // structured output; a missing field (or a step without parsed JSON)
  // evaluates as empty text, so text conditions fail rather than match prose.
  const text = condition.step
    ? condition.path !== undefined
      ? jsonFieldText(jsonPathGet(subject?.json, condition.path))
      : (subject?.output ?? ctx.outputs.get(condition.step) ?? "")
    : ctx.input;
  let passed = true;
  let message: string | undefined;

  if (condition.ok !== undefined) {
    passed = passed && Boolean(subject && subject.ok === condition.ok);
  }
  if (condition.contains !== undefined) {
    const needle = renderPrompt(condition.contains, {
      input: ctx.input,
      inputs: ctx.inputs,
      outputs: ctx.outputs,
      results: ctx.results,
      iteration: ctx.iteration,
    });
    passed = passed && text.includes(needle);
  }
  if (condition.equals !== undefined) {
    const expected = renderPrompt(condition.equals, {
      input: ctx.input,
      inputs: ctx.inputs,
      outputs: ctx.outputs,
      results: ctx.results,
      iteration: ctx.iteration,
    });
    passed = passed && text === expected;
  }
  if (condition.matches !== undefined) {
    try {
      const pattern = renderPrompt(condition.matches, {
        input: ctx.input,
        inputs: ctx.inputs,
        outputs: ctx.outputs,
        results: ctx.results,
        iteration: ctx.iteration,
      });
      passed = passed && new RegExp(pattern).test(text);
    } catch (err) {
      passed = false;
      message = `invalid gate regex: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (condition.not) passed = !passed;
  return { passed, message: message ?? (passed ? undefined : "gate condition did not pass") };
}

/**
 * Count dynamic child step ids already present in a resumed cache.
 *
 * This targets `forEach` fan-out expansion (children keyed with an `[n]`
 * suffix), which is the unbounded-generation risk the step budget guards
 * against. Namespaced sub-workflow children (`<parent>::<child>` ids) are
 * intentionally NOT counted here: a `workflow` step's expansion is bounded by
 * the child spec's own independent `MAX_STEPS` budget (enforced at the child's
 * own validate/run time), not by the parent's dynamic-step counter.
 */
function countCachedDynamicSteps(cache: Map<string, StepResult>): number {
  let n = 0;
  for (const stepId of cache.keys()) {
    if (/\[\d+\]$/.test(stepId)) n += 1;
  }
  return n;
}
