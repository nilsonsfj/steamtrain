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
  runWorkflow,
} from "../src/workflow";

/**
 * The `isIdle`/`notifyIdle` control primitive the mid-run detach relies on: it
 * latches true only once a paused run has drained every in-flight step and
 * parked, and clears the instant scheduling resumes — the exact moment it is
 * safe to abort the local engine and hand the run off to a background process.
 */

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A fake adapter whose step `ma` blocks on a gate the test controls. */
function makeGatedDeps(control: WorkflowRunControl): {
  deps: WorkflowDeps;
  state: { prompts: string[] };
  releaseA: () => void;
} {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = { prompts: [] as string[] };
  const createAdapter = (id: AgentId): AgentAdapter => ({
    id,
    binary: "fake",
    defaultModel: "test",
    run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
      return (async function* () {
        state.prompts.push(opts.prompt);
        if (opts.model === "ma") await gate;
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
    releaseA: () => release(),
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

/** Poll `control.isIdle()` until it matches `want`, or throw after `timeoutMs`. */
async function waitForIdle(
  control: WorkflowRunControl,
  want: boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (control.isIdle() === want) return;
    await delay(10);
  }
  throw new Error(`isIdle never became ${want}`);
}

describe("engine quiescence primitive (control.isIdle / notifyIdle)", () => {
  it("stays false while a paused run still has a step in flight, latches true once it drains", async () => {
    const control = createWorkflowRunControl();
    const { deps, state, releaseA } = makeGatedDeps(control);

    expect(control.isIdle()).toBe(false); // nothing running yet

    const events: WorkflowEvent[] = [];
    const done = (async () => {
      for await (const ev of runWorkflow(chain, { input: "hi" }, deps)) {
        events.push(ev);
        // Pause the moment step "a" is dispatched: it is now in flight.
        if (ev.kind === "step_start" && ev.stepId === "a") control.pause("test");
      }
    })();

    // "a" is in flight and the run is paused, but not drained — never idle.
    for (let i = 0; i < 30 && state.prompts.length === 0; i++) await delay(10);
    expect(state.prompts).toEqual(["hi"]);
    await delay(60);
    expect(control.isIdle()).toBe(false);

    // Let "a" finish; the engine drains it and parks paused with "b" pending.
    releaseA();
    await waitForIdle(control, true);
    // Phase 2 never started while parked.
    expect(state.prompts).toEqual(["hi"]);

    // Resuming clears idle and the run completes.
    control.resume("test");
    expect(control.isIdle()).toBe(false);
    await done;
    expect(state.prompts).toEqual(["hi", "b:out:hi"]);
    expect(events.at(-1)).toMatchObject({ kind: "workflow_done", ok: true });
  });

  it("latches idle at a loop workflow's paused phase boundary", async () => {
    const loopSpec: WorkflowSpec = {
      name: "loopy",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "a", agent: "claude", model: "mb", prompt: "{{input}}" }],
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
    const { deps } = makeGatedDeps(control);
    control.pause("test"); // pause before the first phase dispatches

    const events: WorkflowEvent[] = [];
    const done = (async () => {
      for await (const ev of runWorkflow(loopSpec, { input: "hi" }, deps)) events.push(ev);
    })();

    // The loop scheduler parks at the phase boundary and reports idle.
    await waitForIdle(control, true);
    control.resume("test");
    await done;
    expect(events.at(-1)).toMatchObject({ kind: "workflow_done", ok: true });
  });
});
