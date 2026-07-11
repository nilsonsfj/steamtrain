import { describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunOptions } from "../src/agents";
import type { AgentEvent, AgentId } from "../src/types/events";
import {
  RunRecordBuilder,
  type StepResult,
  type WorkflowDeps,
  type WorkflowEvent,
  type WorkflowRunControl,
  type WorkflowSpec,
  createWorkflowRunControl,
  initialWorkflowState,
  runWorkflow,
  workflowReducer,
} from "../src/workflow";

interface RunRecord {
  id: AgentId;
  opts: AgentRunOptions;
}
interface FakeState {
  runs: RunRecord[];
}

/** Fake adapter: records the prompt it was given, then completes. */
function makeDeps(control?: WorkflowRunControl): { deps: WorkflowDeps; state: FakeState } {
  const state: FakeState = { runs: [] };
  const createAdapter = (id: AgentId): AgentAdapter => ({
    id,
    binary: "fake",
    defaultModel: "test",
    run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
      return (async function* () {
        state.runs.push({ id, opts });
        await Promise.resolve();
        yield { kind: "session_start", agent: "claude", ts: 0 } as AgentEvent;
        yield {
          kind: "result",
          agent: "claude",
          ts: 0,
          isError: false,
          text: `out:${opts.prompt}`,
        } as AgentEvent;
      })();
    },
  });
  return {
    deps: { createAdapter, maxConcurrency: 4, cwd: "/base", control },
    state,
  };
}

const chain: WorkflowSpec = {
  name: "chain",
  phases: [
    {
      id: "p1",
      title: "P1",
      steps: [{ id: "a", agent: "claude", model: "ma", prompt: "{{input}}" }],
    },
    {
      id: "p2",
      title: "P2",
      steps: [
        { id: "b", agent: "claude", model: "mb", dependsOn: ["a"], prompt: "b:{{steps.a.output}}" },
      ],
    },
  ],
};

/**
 * Drive a run whose consumer reacts to events (pause acks, step lifecycle) —
 * the pattern every steering test needs.
 */
async function drive(
  spec: WorkflowSpec,
  deps: WorkflowDeps,
  react: (event: WorkflowEvent, events: WorkflowEvent[]) => void,
  opts: { signal?: AbortSignal; cache?: Map<string, StepResult> } = {},
): Promise<WorkflowEvent[]> {
  const events: WorkflowEvent[] = [];
  for await (const event of runWorkflow(
    spec,
    { input: "hi", cache: opts.cache },
    deps,
    opts.signal,
  )) {
    events.push(event);
    react(event, events);
  }
  return events;
}

describe("mid-run steering: pause / edit / resume", () => {
  it("acknowledges a pre-requested pause, applies an edit, and resumes (DAG)", async () => {
    const control = createWorkflowRunControl();
    const { deps, state } = makeDeps(control);
    control.pause("human:test");

    const events = await drive(chain, deps, (event) => {
      if (event.kind === "run_paused") {
        expect(event.by).toBe("human:test");
        const result = control.editStep("a", { prompt: "EDITED {{input}}" }, "human:test");
        expect(result).toEqual({ ok: true });
        control.resume("human:test");
      }
    });

    // The intervention trail is in the stream, in order.
    const kinds = events.map((e) => e.kind);
    const pausedAt = kinds.indexOf("run_paused");
    const editedAt = kinds.indexOf("step_edited");
    const resumedAt = kinds.indexOf("run_resumed");
    expect(pausedAt).toBeGreaterThanOrEqual(0);
    expect(editedAt).toBeGreaterThan(pausedAt);
    expect(resumedAt).toBeGreaterThan(editedAt);

    // The edited prompt is what actually ran, and the result is flagged.
    expect(state.runs[0]?.opts.prompt).toBe("EDITED hi");
    const aDone = events.find((e) => e.kind === "step_done" && e.stepId === "a");
    expect(aDone && aDone.kind === "step_done" ? aDone.result.edited : undefined).toBe(true);
    // Downstream consumed the edited step's output as usual.
    expect(state.runs[1]?.opts.prompt).toBe("b:out:EDITED hi");
    expect(events.at(-1)).toMatchObject({ kind: "workflow_done", ok: true });
  });

  it("rejects edits when the run is not paused, and for started/unknown steps", async () => {
    const control = createWorkflowRunControl();
    const { deps } = makeDeps(control);

    // Before the run starts nothing is attached.
    expect(control.editStep("a", { prompt: "x" })).toMatchObject({ ok: false });

    let sawChecks = false;
    await drive(chain, deps, (event) => {
      if (event.kind === "step_start" && event.stepId === "a" && !sawChecks) {
        sawChecks = true;
        // Not paused.
        const unpaused = control.editStep("b", { prompt: "x" });
        expect(unpaused).toMatchObject({ ok: false });
        expect(unpaused.ok === false && unpaused.error).toMatch(/pause the run/);
        control.pause();
        // Already started.
        const started = control.editStep("a", { prompt: "x" });
        expect(started.ok === false && started.error).toMatch(/already started/);
        // Unknown step.
        const unknown = control.editStep("nope", { prompt: "x" });
        expect(unknown.ok === false && unknown.error).toMatch(/unknown step/);
        // Field not on the kind.
        const wrongField = control.editStep("b", { cmd: "ls" });
        expect(wrongField.ok === false && wrongField.error).toMatch(/no command/);
        // Empty patch.
        expect(control.editStep("b", {})).toMatchObject({ ok: false });
        control.resume();
      }
    });
    expect(sawChecks).toBe(true);
  });

  it("re-runs an edited step whose result was cached (stale replay dropped)", async () => {
    const control = createWorkflowRunControl();
    const { deps, state } = makeDeps(control);
    const cache = new Map<string, StepResult>();
    cache.set("a", { stepId: "a", ok: true, output: "cached-a", durationMs: 1 });
    control.pause();

    const events = await drive(
      chain,
      deps,
      (event) => {
        if (event.kind === "run_paused") {
          expect(control.editStep("a", { prompt: "FRESH {{input}}" })).toEqual({ ok: true });
          control.resume();
        }
      },
      { cache },
    );

    expect(state.runs.map((r) => r.opts.prompt)).toContain("FRESH hi");
    const aDone = events.find((e) => e.kind === "step_done" && e.stepId === "a");
    expect(aDone && aDone.kind === "step_done" ? aDone.cached : undefined).toBe(false);
  });

  it("invalidates cached transitive dependents of an edited step (resumed run)", async () => {
    const control = createWorkflowRunControl();
    const { deps, state } = makeDeps(control);
    // A resumed run: both a and its dependent b replay from the seeded cache.
    const cache = new Map<string, StepResult>();
    cache.set("a", { stepId: "a", ok: true, output: "old-a", durationMs: 1 });
    cache.set("b", { stepId: "b", ok: true, output: "b:old-a", durationMs: 1 });
    control.pause();

    const events = await drive(
      chain,
      deps,
      (event) => {
        if (event.kind === "run_paused") {
          expect(control.editStep("a", { prompt: "FRESH {{input}}" })).toEqual({ ok: true });
          control.resume();
        }
      },
      { cache },
    );

    // BOTH steps re-ran: b's cached result was computed from the pre-edit a,
    // so replaying it would have silently kept the stale output.
    expect(state.runs.map((r) => r.opts.prompt)).toEqual(["FRESH hi", "b:out:FRESH hi"]);
    const bDone = events.find((e) => e.kind === "step_done" && e.stepId === "b");
    expect(bDone && bDone.kind === "step_done" ? bDone.cached : undefined).toBe(false);
  });

  it("merges repeated edits to the same step (later fields win)", async () => {
    const control = createWorkflowRunControl();
    const { deps, state } = makeDeps(control);
    control.pause();
    await drive(chain, deps, (event) => {
      if (event.kind === "run_paused") {
        expect(control.editStep("a", { prompt: "FIRST", model: "m-1" })).toEqual({ ok: true });
        expect(control.editStep("a", { prompt: "SECOND" })).toEqual({ ok: true });
        expect(control.stepEdit("a")).toEqual({ prompt: "SECOND", model: "m-1" });
        control.resume();
      }
    });
    expect(state.runs[0]?.opts.prompt).toBe("SECOND");
    expect(state.runs[0]?.opts.model).toBe("m-1");
  });

  it("drains several parallel in-flight steps before parking paused", async () => {
    const parallel: WorkflowSpec = {
      name: "parallel",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            { id: "a", agent: "claude", model: "ma", prompt: "a:{{input}}" },
            { id: "b", agent: "claude", model: "mb", prompt: "b:{{input}}" },
          ],
        },
        {
          id: "p2",
          title: "P2",
          steps: [{ id: "c", agent: "claude", model: "mc", prompt: "c:{{input}}" }],
        },
      ],
    };
    const control = createWorkflowRunControl();
    const { deps, state } = makeDeps(control);
    let resumed = false;

    await drive(parallel, deps, (event) => {
      // Pause once both phase-1 steps are dispatched (in flight together).
      if (event.kind === "step_start" && event.stepId === "b") control.pause();
      if (event.kind === "run_paused") {
        // Both in-flight steps completed; nothing from phase 2 started.
        expect(state.runs.filter((r) => r.opts.prompt.startsWith("c:"))).toHaveLength(0);
        resumed = true;
        control.resume();
      }
    });
    expect(resumed).toBe(true);
    expect(state.runs).toHaveLength(3);
  });

  it("pauses in-flight-safe: a launched step finishes, nothing new starts until resume", async () => {
    const control = createWorkflowRunControl();
    const { deps, state } = makeDeps(control);

    await drive(chain, deps, (event) => {
      if (event.kind === "step_start" && event.stepId === "a") control.pause();
      if (event.kind === "run_paused") {
        // `a` was in flight (or finished); `b` must not have started yet.
        expect(state.runs.some((r) => r.opts.prompt.startsWith("b:"))).toBe(false);
        control.resume();
      }
    });
    expect(state.runs).toHaveLength(2);
  });

  it("a cancel unblocks a parked (paused) run instead of hanging", async () => {
    const control = createWorkflowRunControl();
    const { deps, state } = makeDeps(control);
    const ac = new AbortController();
    control.pause();

    const events = await drive(
      chain,
      deps,
      (event) => {
        if (event.kind === "run_paused") ac.abort();
      },
      { signal: ac.signal },
    );

    expect(state.runs).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ kind: "workflow_done", ok: false });
  });

  it("pauses at the phase boundary in loop (phased) workflows", async () => {
    const loopSpec: WorkflowSpec = {
      name: "loopy",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "a", agent: "claude", model: "ma", prompt: "{{input}}" }],
        },
        {
          id: "check",
          title: "Check",
          steps: [
            {
              id: "g",
              kind: "gate",
              dependsOn: ["a"],
              condition: { step: "a", contains: "out" },
              loopTo: "p1",
              maxIterations: 2,
            },
          ],
        },
      ],
    };
    const control = createWorkflowRunControl();
    const { deps, state } = makeDeps(control);
    control.pause();

    const events = await drive(loopSpec, deps, (event) => {
      if (event.kind === "run_paused") {
        expect(state.runs).toHaveLength(0); // acked before phase 1 dispatched
        expect(control.editStep("a", { prompt: "LOOP-EDIT" })).toEqual({ ok: true });
        control.resume();
      }
    });

    expect(state.runs[0]?.opts.prompt).toBe("LOOP-EDIT");
    expect(events.at(-1)).toMatchObject({ kind: "workflow_done", ok: true });
  });

  it("folds interventions into the run record and the live reducer state", async () => {
    const control = createWorkflowRunControl();
    const { deps } = makeDeps(control);
    control.pause("human:test");
    const events = await drive(chain, deps, (event) => {
      if (event.kind === "run_paused") {
        control.editStep("a", { prompt: "EDITED" }, "human:test");
        control.resume("human:test");
      }
    });

    const builder = new RunRecordBuilder({ id: "r1", workflow: "chain", input: "hi", cwd: "/" });
    let state = initialWorkflowState;
    let sawPaused = false;
    for (const event of events) {
      builder.handle(event);
      state = workflowReducer(state, { type: "event", event });
      if (state.paused) sawPaused = true;
    }
    const record = builder.build({ status: "done" });
    expect(record.interventions).toEqual([
      expect.objectContaining({ kind: "paused", by: "human:test" }),
      expect.objectContaining({
        kind: "step-edited",
        stepId: "a",
        patch: { prompt: "EDITED" },
        by: "human:test",
      }),
      expect.objectContaining({ kind: "resumed", by: "human:test" }),
    ]);
    const aStep = record.phases.flatMap((p) => p.steps).find((s) => s.stepId === "a");
    expect(aStep?.edited).toBe(true);

    expect(sawPaused).toBe(true);
    expect(state.paused).toBe(false);
    expect(state.editedSteps).toEqual({ a: { prompt: "EDITED" } });
    const liveA = state.phases.flatMap((p) => p.steps).find((s) => s.stepId === "a");
    expect(liveA?.edited).toBe(true);
  });

  it("model/effort edits apply to agent steps", async () => {
    const control = createWorkflowRunControl();
    const { deps, state } = makeDeps(control);
    control.pause();
    await drive(chain, deps, (event) => {
      if (event.kind === "run_paused") {
        expect(control.editStep("a", { model: "m-new", effort: "high" })).toEqual({ ok: true });
        control.resume();
      }
    });
    expect(state.runs[0]?.opts.model).toBe("m-new");
    expect(state.runs[0]?.opts.effort).toBe("high");
  });
});
