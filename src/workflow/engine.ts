import { resolve as resolvePath } from "node:path";
import { resolveAgentInstance } from "../agents";
import type { AgentAdapter } from "../agents";
import type { SteamtrainConfig } from "../config/types";
import type { AgentEvent, AgentId, AgentProviderId } from "../types/events";
import type { WorkflowEvent } from "./events";
import { createChannel, runPool } from "./pool";
import { type RetryPolicy, backoffDelayMs, resolveRetryPolicy } from "./retry";
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
 * Execute a workflow as a single ordered stream of {@link WorkflowEvent}s.
 * Phases run sequentially; the steps within a phase run in parallel, bounded by
 * `deps.maxConcurrency`. Cached steps replay immediately. Aborting `signal`
 * cancels in-flight steps (their processes are killed) and ends the run.
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
  let generatedSteps = countCachedDynamicSteps(cache);
  const reserveDynamicSteps = (count: number): boolean => {
    if (generatedSteps + count > MAX_STEPS - totalSteps) return false;
    generatedSteps += count;
    return true;
  };
  yield {
    kind: "workflow_start",
    name: spec.name,
    phaseCount: spec.phases.length,
    stepCount: totalSteps,
    ts: Date.now(),
  };

  const allResults: StepResult[] = [];
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
    // `generatedSteps` is otherwise a monotonic accumulator that only ever
    // grows, but `invalidateRegion` drops forEach children (ids like `step[n]`)
    // from the cache on a loop jump. Without this re-sync, each pass over a
    // forEach body re-reserves its N children and the budget accumulates N per
    // pass — so a forEach inside a loop falsely hits the MAX_STEPS cap after
    // enough iterations despite the live footprint never exceeding N. During
    // forward progress the cache only grows, so this is a no-op then; it only
    // releases budget that invalidation just freed.
    generatedSteps = countCachedDynamicSteps(cache);
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

    const runStep = async (step: WorkflowStep): Promise<void> => {
      const agentBacked = isAgentBackedStep(step) ? step : undefined;
      channel.push({
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
        const skipped = skippedStepResult(step.id, failedDependency);
        skipped.iteration = iteration;
        outputs.set(step.id, skipped.output);
        results.set(step.id, skipped);
        allResults.push(skipped);
        phaseOk = false;
        if (step.kind === "gate" && (step.onFalse === "fail" || step.onFalse === "stop")) {
          stopAfterPhase = true;
        }
        channel.push({
          kind: "step_done",
          phaseId: phase.id,
          stepId: step.id,
          result: skipped,
          cached: false,
          iteration,
          ts: Date.now(),
        });
        return;
      }

      // Cache hit → replay without spawning (resume).
      const cached = cache.get(step.id);
      if (cached) {
        for (const child of cached.childResults ?? []) {
          outputs.set(child.stepId, child.output);
          results.set(child.stepId, child);
          allResults.push(child);
          channel.push({
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
          channel.push({
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
        if (!cached.ok) {
          // onFalse: "stop" is a graceful halt — same logic as the live path
          const isGracefulStop = cached.gate?.onFalse === "stop";
          if (!isGracefulStop) phaseOk = false;
        }
        if (cached.gate) {
          channel.push({
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
            if (onFalse === "fail" || onFalse === "stop") stopAfterPhase = true;
          }
        }
        channel.push({
          kind: "step_done",
          phaseId: phase.id,
          stepId: step.id,
          result: cached,
          cached: true,
          iteration,
          ts: Date.now(),
        });
        return;
      }

      const execution = await executeStep(
        step,
        {
          input: ctx.input,
          outputs,
          results,
          cache,
          reserveDynamicSteps,
          deps,
          signal,
          workflowName: spec.name,
          retryDefault: spec.retry,
          stepTimeoutDefault: spec.stepTimeoutSec,
          iteration,
        },
        {
          pushAgentEvent: (stepId, event) => {
            channel.push({
              kind: "step_event",
              phaseId: phase.id,
              stepId,
              event,
              iteration,
              ts: Date.now(),
            });
          },
          pushWorkflowEvent: (event) => channel.push(event),
          phaseId: phase.id,
        },
      );

      if (execution.gate) {
        channel.push({
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
      }
      outputs.set(step.id, result.output);
      results.set(step.id, result);
      if (result.ok) cache.set(step.id, result);
      allResults.push(result);
      if (!result.ok) {
        // onFalse: "stop" is a graceful halt — the step is not ok (gate
        // condition failed) but the workflow stays ok per the documented
        // contract. onFalse: "fail" should make the workflow fail.
        const isGracefulStop = execution.gate?.onFalse === "stop";
        if (!isGracefulStop) phaseOk = false;
      }
      if (execution.stop) stopAfterPhase = true;

      channel.push({
        kind: "step_done",
        phaseId: phase.id,
        stepId: step.id,
        result,
        cached: false,
        iteration,
        ts: Date.now(),
      });
    };

    // runStep never throws (it captures its own errors), so runPool never
    // rejects; the channel closes once every step in the phase settles.
    const poolDone = runPool(phase.steps, limit, runStep, signal).finally(() => channel.close());

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

  // `allResults` accumulates one entry per step per loop iteration (a body
  // step that ran 3 passes has 3 entries, plus 3 intermediate "not yet
  // converged" gate results). Downstream consumers — the CLI/web run summary,
  // cost roll-ups — would otherwise double-count every intermediate pass. Keep
  // only the latest result per step id (the final state of each step); earlier
  // iterations were superseded by re-runs.
  const finalResults = new Map<string, StepResult>();
  for (const r of allResults) finalResults.set(r.stepId, r);

  yield {
    kind: "workflow_done",
    ok: workflowOk && !signal?.aborted,
    results: [...finalResults.values()],
    ts: Date.now(),
  };
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
      return {
        result: {
          ...result,
          items: result.ok ? splitItemsFromOutput(result.output) : undefined,
        },
      };
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
      : consolidateOutputs(step.dependsOn ?? [], ctx.outputs, step.separator);
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
  const prompt = renderPrompt(step.prompt, {
    input: ctx.input,
    outputs: ctx.outputs,
    results: ctx.results,
    item,
    iteration: ctx.iteration,
  });
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
    while (true) {
      attempt += 1;
      const { result, retryable } = await runAgentAttempt(
        step,
        ctx,
        hooks,
        stepId,
        item,
        prompt,
        workspace.cwd,
      );
      const isLastAttempt = attempt >= policy.maxAttempts;
      if (result.ok || !retryable || isLastAttempt || ctx.signal?.aborted) {
        const finalResult = attachWorktreeInfo(result, workspace, stepCwd);
        // After a retry, report true wall-clock for the whole step (all attempts
        // plus the backoff waits between them), not just the last attempt.
        return attempt > 1
          ? { ...finalResult, attempts: attempt, durationMs: Date.now() - firstStarted }
          : finalResult;
      }
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
  } finally {
    await workspace.dispose();
  }
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
  await runPool(
    values.map((value, index) => ({
      value,
      item: { sourceStepId, index, value },
      stepId: `${step.id}[${index}]`,
    })),
    limit,
    async ({ value: _value, item, stepId }) => {
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

  return {
    result: {
      stepId: step.id,
      ok,
      output,
      items: values,
      childResults,
      error: ok ? undefined : "one or more fan-out items failed",
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

function skippedStepResult(stepId: string, dependencyId: string): StepResult {
  return {
    stepId,
    ok: false,
    output: `skipped: dependency '${dependencyId}' failed`,
    error: `dependency '${dependencyId}' failed`,
    durationMs: 0,
  };
}

function consolidateOutputs(
  ids: string[],
  outputs: Map<string, string>,
  separator?: string,
): string {
  return ids.map((id) => `--- ${id} ---\n${outputs.get(id) ?? ""}`).join(separator ?? "\n\n");
}

function evaluateGate(
  condition: GateCondition,
  ctx: ExecuteContext,
): { passed: boolean; message?: string } {
  const subject = condition.step ? ctx.results.get(condition.step) : undefined;
  const text = condition.step
    ? (subject?.output ?? ctx.outputs.get(condition.step) ?? "")
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
