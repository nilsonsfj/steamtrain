import { resolve as resolvePath } from "node:path";
import type { AgentAdapter } from "../agents";
import type { AgentId } from "../types/events";
import type { WorkflowEvent } from "./events";
import { createChannel, runPool } from "./pool";
import { renderPrompt } from "./template";
import {
  MAX_CONCURRENCY,
  type StepResult,
  type WorkflowSpec,
  type WorkflowStep,
  validateWorkflow,
} from "./types";

/**
 * Everything the engine needs from the outside world. `createAdapter` is
 * injected (not imported) so tests can supply a fake adapter and the engine
 * never spawns a real CLI in a unit test.
 */
export interface WorkflowDeps {
  createAdapter: (id: AgentId, binary?: string) => AgentAdapter;
  binaries?: Partial<Record<AgentId, string>>;
  timeoutMs?: number;
  maxConcurrency: number;
  /** Base cwd; a step's relative `cwd` resolves against this. */
  cwd: string;
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
  const valid = validateWorkflow(spec);
  if (!valid.ok) throw new Error(`invalid workflow '${spec.name}': ${valid.error}`);

  const cache = ctx.cache ?? new Map<string, StepResult>();
  const outputs = new Map<string, string>();
  for (const [id, res] of cache) outputs.set(id, res.output);

  const limit = Math.min(Math.max(1, deps.maxConcurrency), MAX_CONCURRENCY);
  const totalSteps = spec.phases.reduce((n, p) => n + p.steps.length, 0);
  yield {
    kind: "workflow_start",
    name: spec.name,
    phaseCount: spec.phases.length,
    stepCount: totalSteps,
    ts: Date.now(),
  };

  const allResults: StepResult[] = [];
  let workflowOk = true;

  for (let pi = 0; pi < spec.phases.length; pi++) {
    const phase = spec.phases[pi];
    if (!phase) continue;

    yield {
      kind: "phase_start",
      phaseId: phase.id,
      title: phase.title,
      index: pi,
      stepCount: phase.steps.length,
      ts: Date.now(),
    };

    const channel = createChannel<WorkflowEvent>();
    let phaseOk = true;

    const runStep = async (step: WorkflowStep): Promise<void> => {
      channel.push({
        kind: "step_start",
        phaseId: phase.id,
        stepId: step.id,
        agent: step.agent,
        model: step.model,
        cwd: step.cwd,
        ts: Date.now(),
      });

      // Cache hit → replay without spawning (resume).
      const cached = cache.get(step.id);
      if (cached) {
        outputs.set(step.id, cached.output);
        allResults.push(cached);
        if (!cached.ok) phaseOk = false;
        channel.push({
          kind: "step_done",
          phaseId: phase.id,
          stepId: step.id,
          result: cached,
          cached: true,
          ts: Date.now(),
        });
        return;
      }

      const adapter = deps.createAdapter(step.agent, deps.binaries?.[step.agent]);
      const prompt = renderPrompt(step.prompt, { input: ctx.input, outputs });
      const stepCwd = step.cwd ? resolvePath(deps.cwd, step.cwd) : deps.cwd;
      const started = Date.now();

      let finalText = "";
      let streamedText = "";
      let costUsd: number | undefined;
      let errored = false;
      let errorMessage: string | undefined;

      try {
        for await (const event of adapter.run({
          prompt,
          model: step.model,
          cwd: stepCwd,
          env: step.env,
          extraArgs: step.extraArgs,
          timeoutMs: deps.timeoutMs,
          signal,
        })) {
          channel.push({
            kind: "step_event",
            phaseId: phase.id,
            stepId: step.id,
            event,
            ts: Date.now(),
          });
          if (event.kind === "text_delta") {
            if (!event.thinking) streamedText += event.text;
          } else if (event.kind === "result") {
            if (event.text) finalText = event.text;
            if (typeof event.costUsd === "number") costUsd = event.costUsd;
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
        errorMessage ??= err instanceof Error ? err.message : String(err);
      }

      // A cancelled step is never cached, so resume re-runs it.
      const cancelled = Boolean(signal?.aborted);
      const ok = !errored && !cancelled;
      const output = ok
        ? finalText || streamedText
        : errorMessage || finalText || streamedText || (cancelled ? "cancelled" : "");

      const result: StepResult = {
        stepId: step.id,
        ok,
        output,
        error: ok ? undefined : (errorMessage ?? (cancelled ? "cancelled" : "failed")),
        durationMs: Date.now() - started,
        costUsd,
      };

      outputs.set(step.id, result.output);
      if (ok) cache.set(step.id, result);
      allResults.push(result);
      if (!ok) phaseOk = false;

      channel.push({
        kind: "step_done",
        phaseId: phase.id,
        stepId: step.id,
        result,
        cached: false,
        ts: Date.now(),
      });
    };

    // runStep never throws (it captures its own errors), so runPool never
    // rejects; the channel closes once every step in the phase settles.
    const poolDone = runPool(phase.steps, limit, runStep, signal).finally(() => channel.close());

    for await (const ev of channel) yield ev;
    await poolDone;

    if (!phaseOk) workflowOk = false;
    yield { kind: "phase_done", phaseId: phase.id, ok: phaseOk, ts: Date.now() };

    if (signal?.aborted) break;
  }

  yield {
    kind: "workflow_done",
    ok: workflowOk && !signal?.aborted,
    results: allResults,
    ts: Date.now(),
  };
}
