import { resolve as resolvePath } from "node:path";
import { resolveAgentInstance } from "../agents";
import type { AgentAdapter } from "../agents";
import type { SteamtrainConfig } from "../config/types";
import type { AgentEvent, AgentInstanceId, AgentProviderId, TokenUsage } from "../types/events";
import { addTokens } from "./cost";
import type { WorkflowEvent } from "./events";
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
  DEFAULT_LOOP_MAX_ITERATIONS,
  type GateCondition,
  MAX_CONCURRENCY,
  MAX_STEPS,
  type StepResult,
  type WorkerStep,
  type WorkflowItem,
  type WorkflowPhase,
  type WorkflowSpec,
  type WorkflowStep,
  isAgentBackedStep,
  parseForEachSource,
  validateWorkflow,
  workflowStepKind,
} from "./types";
import type { AgentWorkspaceLease, AgentWorkspaceManager } from "./worktree";

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
  /** Default per-loop iteration cap; a gate's own `maxIterations` overrides it. */
  loopMaxIterations?: number;
}

export interface WorkflowRunContext {
  /** The user's prompt; available to steps as `{{input}}` / `{{args}}`. */
  input: string;
  /**
   * In-session cache of completed step results. Successful steps are stored
   * here; on a re-run they replay without spawning, which is how a cancelled
   * run resumes. Pass the same Map across runs to enable resume.
   */
  cache?: Map<string, StepResult>;
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
  limit: number;
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
  for (const [id, res] of cache) {
    outputs.set(id, res.output);
    results.set(id, res);
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
    limit,
    budget,
    reserveDynamicSteps,
    spent: { costUsd: costOfCachedResults(cache) },
    budgetState: { exceeded: false },
  };

  const workflowOk = specHasLoopGates(spec)
    ? yield* runPhasedScheduler(env)
    : yield* runDagScheduler(env);

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
  let workflowOk = true;

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

    if (signal?.aborted) {
      workflowOk = false;
      break;
    }

    // Loop-back decision: did this phase contain an unmet loop gate? A jump
    // means this pass is superseded by a re-run, so its failure (e.g. the
    // gate's own "not yet converged" result) must NOT poison workflowOk.
    const contended = findContendedLoopGate(phase, results, loopState, effectiveLoopMax);
    if (contended) {
      // The predicate found the gate; this is the only place its iteration
      // counter advances, keeping the decision (findContendedLoopGate) and the
      // mutation (increment + jump) as separate steps.
      const state = loopState.get(contended.gateId)!;
      state.iteration += 1;
      const loopToIndex = contended.loopToIndex;
      // invalidate cache + results for the region so the body re-runs
      invalidateRegion(spec, loopToIndex, pi, cache, results);
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
      pi = loopToIndex;
      continue;
    }

    if (!phaseOk) workflowOk = false;
    if (stopAfterPhase) break;
    pi++;
  }

  return workflowOk;
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

  const driver = (async () => {
    const inFlight = new Map<string, Promise<void>>();
    while (true) {
      // A reached cost budget stops scheduling NEW steps; in-flight steps run to
      // completion, and any still-pending steps stay pending (recorded as
      // not-run), so raising the cap and resuming replays the cache and picks up
      // exactly where the budget stopped it.
      const budgetEvent = maybeWorkflowBudgetEvent(env);
      if (budgetEvent) channel.push(budgetEvent);
      if (!signal?.aborted && !env.budgetState.exceeded) {
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
      if (inFlight.size === 0) break;
      await Promise.race(inFlight.values());
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

/** Matches `{{steps.<id>.<field>}}` template references; group 1 is the id. */
const TEMPLATE_STEP_REF =
  /\{\{\s*steps\.(.+?)\.(?:output|items|ok|error|target|iteration|json(?:[.[][^{}]*)?)\s*\}\}/g;

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
      if (step.kind === "gate" && (step.onFalse === "fail" || step.onFalse === "stop")) {
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
        // A `work[3]` fan-out child reference depends on its `work` parent.
        const id = phaseIndexOf.has(ref) ? ref : ref.replace(/\[\d+\]$/, "");
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
      // Condition predicates aren't templates themselves, but they're rendered
      // as such (their {{steps.*}} refs resolve), so they contribute deps too.
      const renderableTexts: (string | undefined)[] = [];
      for (const condition of conditions) {
        if (!condition) continue;
        addEarlier(condition.step);
        renderableTexts.push(condition.contains, condition.equals, condition.matches);
      }
      if ((step.kind === "worker" || step.kind === "processor" || !step.kind) && step.forEach) {
        addEarlier(parseForEachSource(step.forEach));
      }
      if ("prompt" in step) renderableTexts.push(step.prompt);
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
  step: WorkflowStep,
  phase: WorkflowPhase,
  iteration: number,
  env: RunEnv,
  push: (event: WorkflowEvent) => void,
): Promise<StepFlags> {
  const { spec, ctx, deps, signal, cache, outputs, results, allResults } = env;
  const agentBacked = isAgentBackedStep(step) ? step : undefined;
  push({
    kind: "step_start",
    phaseId: phase.id,
    stepId: step.id,
    blockKind: workflowStepKind(step),
    agent: agentBacked?.agent,
    model: agentBacked?.model,
    effort: agentBacked?.effort,
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

  // Cache hit → replay without spawning (resume).
  const cached = cache.get(step.id);
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
        model: agentBacked?.model,
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
  const skipReason = findSkipReason(step, { input: ctx.input, outputs, results, iteration });
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
      outputs,
      results,
      cache,
      reserveDynamicSteps: env.reserveDynamicSteps,
      deps,
      signal,
      workflowName: spec.name,
      retryDefault: spec.retry,
      stepTimeoutDefault: spec.stepTimeoutSec,
      iteration,
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
  for (const child of execution.childResults ?? []) {
    child.iteration = iteration;
    outputs.set(child.stepId, child.output);
    results.set(child.stepId, child);
    allResults.push(child);
    // Fan-out children hold the real cost; the parent's is their sum, so count
    // children here and skip the parent below to avoid double-counting.
    env.spent.costUsd += child.costUsd ?? 0;
  }
  outputs.set(step.id, result.output);
  results.set(step.id, result);
  if (result.ok) cache.set(step.id, result);
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
  outputs: Map<string, string>;
  results: Map<string, StepResult>;
  cache: Map<string, StepResult>;
  reserveDynamicSteps: (count: number) => boolean;
  deps: WorkflowDeps;
  signal?: AbortSignal;
  workflowName: string;
  /** Workflow-level auto-retry default; per-step `retry` overrides it. */
  retryDefault?: RetryPolicy;
  /** Workflow-level per-step timeout default in seconds; per-step `stepTimeoutSec` overrides it. */
  stepTimeoutDefault?: number;
  /** Loop iteration this step is executing under (1-based). */
  iteration: number;
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

  if (kind === "gate" && step.kind === "gate") {
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
): Promise<{ result: StepResult; retryable: boolean }> {
  const started = Date.now();
  let finalText = "";
  let streamedText = "";
  let costUsd: number | undefined;
  let tokens: TokenUsage | undefined;
  let errored = false;
  let errorMessage: string | undefined;
  let sawResult = false;
  let sawToolUse = false;

  try {
    for await (const event of adapterRun(step, ctx, stepCwd, prompt)) {
      hooks.pushAgentEvent(stepId, event);
      if (event.kind === "text_delta") {
        if (!event.thinking) streamedText += event.text;
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
  });
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
    outputs: ctx.outputs,
    results: ctx.results,
    item,
    iteration: ctx.iteration,
  });
  const outputSchema = step.output;
  const prompt = outputSchema ? withStructuredOutputInstructions(rendered, outputSchema) : rendered;
  const stepCwd = step.cwd ? resolvePath(ctx.deps.cwd, step.cwd) : ctx.deps.cwd;
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
  const fix = await runAgentAttempt(
    step,
    ctx,
    hooks,
    stepId,
    item,
    structuredOutputFixPrompt(outputSchema, result.output, parsed.error),
    workspaceCwd,
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

function attachWorktreeInfo(
  result: StepResult,
  workspace: AgentWorkspaceLease,
  originalCwd: string,
): StepResult {
  if (!workspace.root || !workspace.branch) return result;
  const worktree: AgentWorktreeInfo = {
    originalCwd,
    cwd: workspace.cwd,
    root: workspace.root,
    branch: workspace.branch,
    linkedIgnoredPaths: workspace.linkedIgnoredPaths,
  };
  return { ...result, worktree };
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
    signal: ctx.signal,
  });
}

async function executeForEachStep(
  step: WorkerStep & AgentBackedWorkflowStep,
  ctx: ExecuteContext,
  hooks: ExecuteHooks,
): Promise<ExecutionOutcome> {
  const started = Date.now();
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
    step.maxCostUsd !== undefined && stepSpent.costUsd >= step.maxCostUsd;
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
            limitUsd: step.maxCostUsd as number,
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
      hooks.pushWorkflowEvent({
        kind: "step_start",
        phaseId: hooks.phaseId,
        stepId,
        blockKind: workflowStepKind(step),
        agent: step.agent,
        model: step.model,
        effort: step.effort,
        cwd: step.cwd,
        dependsOn: step.dependsOn,
        parentStepId: step.id,
        item,
        iteration: ctx.iteration,
        ts: Date.now(),
      });

      const cached = ctx.cache.get(stepId);
      const result = cached
        ? { ...cached, stepId, parentStepId: step.id, item, iteration: ctx.iteration }
        : {
            ...(await executeAgentStep(step, ctx, hooks, stepId, item)),
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
      ? `step cost budget $${(step.maxCostUsd as number).toFixed(4)} reached after $${stepSpent.costUsd.toFixed(4)}`
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
    },
    childResults,
  };
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
  for (const dep of step.dependsOn ?? []) {
    const result = results.get(dep);
    if (result && !result.ok) return dep;
  }
  return undefined;
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
  const dependsOn = step.dependsOn ?? [];
  const skippedDeps = dependsOn.filter((dep) => ctx.results.get(dep)?.skipped);
  if (workflowStepKind(step) === "consolidator") {
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
  outputs: Map<string, string>;
  results: Map<string, StepResult>;
  iteration: number;
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
      outputs: ctx.outputs,
      results: ctx.results,
      iteration: ctx.iteration,
    });
    passed = passed && text.includes(needle);
  }
  if (condition.equals !== undefined) {
    const expected = renderPrompt(condition.equals, {
      input: ctx.input,
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

/** Count dynamic child step ids already present in a resumed cache. */
function countCachedDynamicSteps(cache: Map<string, StepResult>): number {
  let n = 0;
  for (const stepId of cache.keys()) {
    if (/\[\d+\]$/.test(stepId)) n += 1;
  }
  return n;
}
