import { describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunOptions } from "../src/agents";
import type { AgentEvent, AgentId } from "../src/types/events";
import {
  type StepResult,
  type WorkflowDeps,
  type WorkflowEvent,
  type WorkflowRunControl,
  type WorkflowSpec,
  createWorkflowRunControl,
  markKilledResult,
  runWorkflow,
} from "../src/workflow";

/**
 * Killing ONE step (design 02.4). The distinction that matters throughout: a
 * kill fails its step and the run keeps scheduling, where a cancel takes the
 * whole run down. Every test here is about keeping those two apart.
 */

interface Started {
  stepId: string;
  /** Resolves once this step's agent has been aborted. */
  aborted: Promise<void>;
}

/**
 * Fake adapter whose steps hang until their own signal aborts — the state a
 * kill exists for. `finishes` names the steps that instead complete promptly.
 */
function makeDeps(
  control: WorkflowRunControl,
  finishes: Set<string> = new Set(),
): { deps: WorkflowDeps; started: Map<string, Started> } {
  const started = new Map<string, Started>();
  const createAdapter = (id: AgentId): AgentAdapter => ({
    id,
    binary: "fake",
    defaultModel: "test",
    run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
      return (async function* () {
        // The adapter never learns the step id, so these specs use the step id
        // as its prompt — that is how a step is recognised here.
        const stepId = opts.prompt;
        let markAborted = (): void => {};
        started.set(stepId, {
          stepId,
          aborted: new Promise<void>((resolve) => {
            markAborted = resolve;
          }),
        });
        yield { kind: "session_start", agent: "claude", ts: 0 } as AgentEvent;
        if (!finishes.has(stepId)) {
          await new Promise<void>((resolve) => {
            if (opts.signal?.aborted) return resolve();
            opts.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          markAborted();
          return;
        }
        yield {
          kind: "result",
          agent: "claude",
          ts: 0,
          isError: false,
          text: `out:${stepId}`,
        } as AgentEvent;
      })();
    },
  });
  return { deps: { createAdapter, maxConcurrency: 4, cwd: "/base", control }, started };
}

/** Two steps in one phase, so a kill on one can be seen not to touch the other. */
const pair: WorkflowSpec = {
  name: "pair",
  phases: [
    {
      id: "p1",
      title: "P1",
      steps: [
        { id: "slow", agent: "claude", model: "m", prompt: "slow" },
        { id: "quick", agent: "claude", model: "m", prompt: "quick" },
      ],
    },
    {
      id: "p2",
      title: "P2",
      steps: [{ id: "after", agent: "claude", model: "m", prompt: "after" }],
    },
  ],
};

async function collect(
  spec: WorkflowSpec,
  deps: WorkflowDeps,
  react: (event: WorkflowEvent) => void,
): Promise<WorkflowEvent[]> {
  const events: WorkflowEvent[] = [];
  for await (const event of runWorkflow(spec, { input: "hi" }, deps)) {
    events.push(event);
    react(event);
  }
  return events;
}

describe("kill step", () => {
  it("fails the killed step and lets the rest of the run finish", async () => {
    const control = createWorkflowRunControl();
    const { deps } = makeDeps(control, new Set(["quick", "after"]));

    const events = await collect(pair, deps, (event) => {
      if (event.kind === "step_start" && event.stepId === "slow") {
        expect(control.killStep("slow", "human:web")).toEqual({ ok: true });
      }
    });

    const killed = events.find((e) => e.kind === "step_killed");
    expect(killed).toMatchObject({ kind: "step_killed", stepId: "slow", by: "human:web" });

    const slowDone = events.find((e) => e.kind === "step_done" && e.stepId === "slow");
    const slowResult = slowDone?.kind === "step_done" ? slowDone.result : undefined;
    expect(slowResult?.ok).toBe(false);
    expect(slowResult?.killed).toBe(true);
    expect(slowResult?.error).toBe("killed by human:web");

    // The point of the feature: everything else ran.
    const quick = events.find((e) => e.kind === "step_done" && e.stepId === "quick");
    expect(quick?.kind === "step_done" ? quick.result.ok : undefined).toBe(true);
    const after = events.find((e) => e.kind === "step_done" && e.stepId === "after");
    expect(after?.kind === "step_done" ? after.result.ok : undefined).toBe(true);
    // A failed step still fails the run's verdict — killing is not forgiving.
    expect(events.at(-1)).toMatchObject({ kind: "workflow_done", ok: false });
  });

  it("keeps the reason a step was already failing for, and adds who killed it", async () => {
    // A kill can land on a step that was going down anyway. The adapter's own
    // error is the more useful half — it says why — so it must survive.
    const control = createWorkflowRunControl();
    const createAdapter = (id: AgentId): AgentAdapter => ({
      id,
      binary: "fake",
      defaultModel: "test",
      run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
        return (async function* () {
          if (opts.prompt !== "slow") {
            yield {
              kind: "result",
              agent: "claude",
              ts: 0,
              isError: false,
              text: "ok",
            } as AgentEvent;
            return;
          }
          // Report a genuine failure, then park until the kill's abort lands.
          yield {
            kind: "result",
            agent: "claude",
            ts: 0,
            isError: true,
            text: "provider returned 500",
          } as AgentEvent;
          await new Promise<void>((resolve) => {
            if (opts.signal?.aborted) return resolve();
            opts.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        })();
      },
    });
    const deps: WorkflowDeps = { createAdapter, maxConcurrency: 4, cwd: "/base", control };

    const events = await collect(pair, deps, (event) => {
      if (event.kind === "step_start" && event.stepId === "slow")
        control.killStep("slow", "human:web");
    });

    const done = events.find((e) => e.kind === "step_done" && e.stepId === "slow");
    const result = done?.kind === "step_done" ? done.result : undefined;
    expect(result?.killed).toBe(true);
    expect(result?.error).toBe("provider returned 500 (killed by human:web)");
  });

  it("aborts only the killed step's agent, never the run's other work", async () => {
    const control = createWorkflowRunControl();
    const { deps, started } = makeDeps(control, new Set(["quick", "after"]));

    await collect(pair, deps, (event) => {
      if (event.kind === "step_start" && event.stepId === "slow") control.killStep("slow");
    });

    // The killed step's adapter observed an abort; the run itself was never
    // cancelled, so its other steps ran to completion above.
    await expect(started.get("slow")?.aborted).resolves.toBeUndefined();
  });

  it("refuses a step that is not running, and says which case it is", async () => {
    const control = createWorkflowRunControl();
    const { deps } = makeDeps(control, new Set(["quick", "after"]));

    let beforeStart: unknown;
    let afterDone: unknown;
    await collect(pair, deps, (event) => {
      if (event.kind === "step_start" && event.stepId === "slow") {
        // "quick" may or may not have started yet, but "after" certainly has not.
        beforeStart = control.killStep("after");
        control.killStep("slow");
      }
      if (event.kind === "phase_done" && event.phaseId === "p1") {
        afterDone = control.killStep("slow");
      }
    });

    expect(beforeStart).toEqual({ ok: false, error: "step 'after' is not running" });
    expect(afterDone).toEqual({ ok: false, error: "step 'slow' is not running any more" });
  });

  /**
   * A step is killable for exactly as long as it is executing, so a kill can
   * be accepted in the window between the work finishing and the engine
   * unregistering it. What the mark does in that window is not reachable from
   * the event stream (the abort would land mid-execution), so the decision
   * itself is exercised here.
   */
  describe("marking a result when the kill lands late", () => {
    const result = (over: Partial<StepResult>): StepResult => ({
      stepId: "s",
      ok: false,
      output: "",
      durationMs: 1,
      ...over,
    });

    it("leaves a step that finished first alone", () => {
      // Failing it would discard finished work and cascade the loss downstream
      // over a margin of microseconds.
      const done = markKilledResult(result({ ok: true, output: "the work" }), "human:web");
      expect(done).toMatchObject({ ok: true, output: "the work" });
      expect(done.killed).toBeUndefined();
      expect(done.error).toBeUndefined();
    });

    it("replaces a bare cancellation, which says nothing a kill does not", () => {
      expect(markKilledResult(result({ error: "cancelled" }), "human:web")).toMatchObject({
        killed: true,
        error: "killed by human:web",
      });
      expect(markKilledResult(result({}), undefined)).toMatchObject({
        killed: true,
        error: "killed",
      });
    });

    it("keeps a real cause and appends the attribution", () => {
      expect(
        markKilledResult(result({ error: "provider returned 500" }), "human:cli"),
      ).toMatchObject({ killed: true, error: "provider returned 500 (killed by human:cli)" });
    });
  });

  it("refuses before the run starts and after it finishes", async () => {
    const control = createWorkflowRunControl();
    const { deps } = makeDeps(control, new Set(["slow", "quick", "after"]));

    expect(control.killStep("slow")).toEqual({ ok: false, error: "the run has not started yet" });
    await collect(pair, deps, () => {});
    expect(control.killStep("slow")).toEqual({ ok: false, error: "run has already finished" });
  });
});
