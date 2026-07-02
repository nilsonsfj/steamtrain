import { describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunOptions } from "../src/agents";
import type { AgentEvent, AgentId } from "../src/types/events";
import {
  type StepResult,
  type WorkflowDeps,
  type WorkflowEvent,
  type WorkflowSpec,
  runWorkflow,
} from "../src/workflow";

/**
 * DAG scheduling: loop-free workflows dispatch each step as soon as its
 * effective dependencies settle, instead of waiting for whole-phase barriers.
 * These tests use a "controllable" adapter whose per-model completion is
 * gated on explicit promises, so cross-phase overlap is asserted
 * deterministically rather than via sleeps.
 */

interface RunRecord {
  id: AgentId;
  opts: AgentRunOptions;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * An adapter whose runs block until the model's gate (if any) is released,
 * then emit a normal `out:<model>` result. `runs` records dispatch order.
 */
function makeControlledDeps(
  gates: Record<string, Promise<void>>,
  over: { maxConcurrency?: number } = {},
): { deps: WorkflowDeps; runs: RunRecord[] } {
  const runs: RunRecord[] = [];
  const createAdapter = (id: AgentId): AgentAdapter => ({
    id,
    binary: "fake",
    run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
      return (async function* () {
        runs.push({ id, opts });
        await gates[opts.model ?? ""];
        yield {
          kind: "result",
          agent: "claude",
          ts: 0,
          isError: false,
          text: `out:${opts.model}`,
        } satisfies AgentEvent;
      })();
    },
  });
  return {
    deps: { createAdapter, maxConcurrency: over.maxConcurrency ?? 4, cwd: "/base" },
    runs,
  };
}

async function collect(
  spec: WorkflowSpec,
  input: string,
  deps: WorkflowDeps,
  opts: { cache?: Map<string, StepResult>; onEvent?: (ev: WorkflowEvent) => void } = {},
): Promise<WorkflowEvent[]> {
  const events: WorkflowEvent[] = [];
  for await (const ev of runWorkflow(spec, { input, cache: opts.cache }, deps)) {
    events.push(ev);
    opts.onEvent?.(ev);
  }
  return events;
}

function indexOf(events: WorkflowEvent[], pred: (e: WorkflowEvent) => boolean): number {
  return events.findIndex(pred);
}

describe("DAG scheduling", () => {
  it("starts a later-phase step once its dependsOn finished, before an unrelated slow step", async () => {
    const slowGate = deferred();
    const { deps, runs } = makeControlledDeps({
      slow: slowGate.promise,
      fast: Promise.resolve(),
      after: Promise.resolve(),
    });
    const spec: WorkflowSpec = {
      name: "overlap",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            { id: "slow", agent: "claude", model: "slow", prompt: "x" },
            { id: "fast", agent: "claude", model: "fast", prompt: "x" },
          ],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            {
              id: "after",
              agent: "claude",
              model: "after",
              prompt: "use {{steps.fast.output}}",
              dependsOn: ["fast"],
            },
          ],
        },
      ],
    };

    // Release the slow step only after the phase-2 step has been dispatched —
    // under phase-barrier scheduling this would deadlock; under DAG
    // scheduling "after" starts as soon as "fast" is done.
    const events = await collect(spec, "hi", deps, {
      onEvent: (ev) => {
        if (ev.kind === "step_start" && ev.stepId === "after") slowGate.resolve();
      },
    });

    const afterStart = indexOf(events, (e) => e.kind === "step_start" && e.stepId === "after");
    const slowDone = indexOf(events, (e) => e.kind === "step_done" && e.stepId === "slow");
    expect(afterStart).toBeGreaterThan(-1);
    expect(slowDone).toBeGreaterThan(afterStart);
    expect(runs.find((r) => r.opts.model === "after")?.opts.prompt).toBe("use out:fast");
    expect(events.at(-1)).toMatchObject({ kind: "workflow_done", ok: true });
  });

  it("emits phase_start/phase_done per phase even when phases overlap", async () => {
    const slowGate = deferred();
    const { deps } = makeControlledDeps({
      slow: slowGate.promise,
      fast: Promise.resolve(),
      after: Promise.resolve(),
    });
    const spec: WorkflowSpec = {
      name: "phase-events",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            { id: "slow", agent: "claude", model: "slow", prompt: "x" },
            { id: "fast", agent: "claude", model: "fast", prompt: "x" },
          ],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            { id: "after", agent: "claude", model: "after", prompt: "x", dependsOn: ["fast"] },
          ],
        },
      ],
    };
    const events = await collect(spec, "hi", deps, {
      onEvent: (ev) => {
        if (ev.kind === "phase_done" && ev.phaseId === "p2") slowGate.resolve();
      },
    });

    // Both phases start and finish exactly once; p2 starts before p1 is done.
    const p1Start = indexOf(events, (e) => e.kind === "phase_start" && e.phaseId === "p1");
    const p2Start = indexOf(events, (e) => e.kind === "phase_start" && e.phaseId === "p2");
    const p1Done = indexOf(events, (e) => e.kind === "phase_done" && e.phaseId === "p1");
    const p2Done = indexOf(events, (e) => e.kind === "phase_done" && e.phaseId === "p2");
    expect(events.filter((e) => e.kind === "phase_start")).toHaveLength(2);
    expect(events.filter((e) => e.kind === "phase_done")).toHaveLength(2);
    expect(p1Start).toBeLessThan(p2Start);
    expect(p2Start).toBeLessThan(p1Done);
    expect(p2Done).toBeLessThan(p1Done);
    // Every step event still lands inside its own phase (after its phase_start).
    const afterStart = indexOf(events, (e) => e.kind === "step_start" && e.stepId === "after");
    expect(afterStart).toBeGreaterThan(p2Start);
  });

  it("waits for template-referenced steps that are not listed in dependsOn", async () => {
    const slowGate = deferred();
    const { deps, runs } = makeControlledDeps({
      slow: slowGate.promise,
      fast: Promise.resolve(),
      merge: Promise.resolve(),
    });
    // Release "slow" only once both phase-1 steps have been dispatched, so
    // "merge" (which lists only "fast" in dependsOn but references
    // {{steps.slow.output}}) could race ahead if template refs were ignored.
    const spec: WorkflowSpec = {
      name: "template-dep",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            { id: "slow", agent: "claude", model: "slow", prompt: "x" },
            { id: "fast", agent: "claude", model: "fast", prompt: "x" },
          ],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            {
              id: "merge",
              agent: "claude",
              model: "merge",
              prompt: "{{steps.fast.output}} + {{steps.slow.output}}",
              dependsOn: ["fast"],
            },
          ],
        },
      ],
    };
    const collected = collect(spec, "hi", deps);
    // Give the scheduler a tick to (incorrectly) dispatch "merge" early, then
    // release the slow step. This delay can't cause a false failure: a correct
    // engine always waits for "slow" and renders "out:fast + out:slow"
    // regardless of timing. The wait only widens the window in which a
    // hypothetical regression (ignoring template refs) would dispatch "merge"
    // early and get caught, so it can't be flaky in the failing direction.
    await new Promise((r) => setTimeout(r, 10));
    slowGate.resolve();
    await collected;

    expect(runs.find((r) => r.opts.model === "merge")?.opts.prompt).toBe("out:fast + out:slow");
  });

  it("halts steps in later phases behind a failed stop gate even when their dependsOn is met", async () => {
    const { deps, runs } = makeControlledDeps({ later: Promise.resolve() });
    const spec: WorkflowSpec = {
      name: "stop-control-dep",
      phases: [
        {
          id: "split",
          title: "Split",
          steps: [{ id: "split", kind: "distributor", items: ["nope"] }],
        },
        {
          id: "gate",
          title: "Gate",
          steps: [
            {
              id: "gate",
              kind: "gate",
              dependsOn: ["split"],
              condition: { step: "split", contains: "yes" },
              onFalse: "stop",
            },
          ],
        },
        {
          id: "later",
          title: "Later",
          // Depends only on "split" (already done) — the stop gate must still
          // hold it back via the implicit control dependency.
          steps: [
            { id: "later", agent: "claude", model: "later", prompt: "x", dependsOn: ["split"] },
          ],
        },
      ],
    };
    const events = await collect(spec, "x", deps);

    expect(runs).toHaveLength(0);
    expect(events.some((e) => e.kind === "step_start" && e.stepId === "later")).toBe(false);
    expect(events.some((e) => e.kind === "phase_start" && e.phaseId === "later")).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: "workflow_done", ok: true });
  });

  it("lets steps in the gate's own phase finish when a fail gate trips", async () => {
    const sibling = deferred();
    const { deps, runs } = makeControlledDeps({ sibling: sibling.promise });
    const spec: WorkflowSpec = {
      name: "fail-same-phase",
      phases: [
        {
          id: "split",
          title: "Split",
          steps: [{ id: "split", kind: "distributor", items: ["nope"] }],
        },
        {
          id: "gate",
          title: "Gate",
          steps: [
            {
              id: "gate",
              kind: "gate",
              dependsOn: ["split"],
              condition: { step: "split", contains: "yes" },
              onFalse: "fail",
            },
            { id: "sibling", agent: "claude", model: "sibling", prompt: "x", dependsOn: ["split"] },
          ],
        },
        {
          id: "later",
          title: "Later",
          steps: [{ id: "later", agent: "claude", model: "later", prompt: "x" }],
        },
      ],
    };
    const events = await collect(spec, "x", deps, {
      onEvent: (ev) => {
        if (ev.kind === "gate_evaluated" && ev.stepId === "gate") sibling.resolve();
      },
    });

    // The same-phase sibling ran to completion; the later phase never started.
    expect(runs.map((r) => r.opts.model)).toEqual(["sibling"]);
    const siblingDone = events.find((e) => e.kind === "step_done" && e.stepId === "sibling");
    expect(siblingDone && siblingDone.kind === "step_done" && siblingDone.result.ok).toBe(true);
    expect(events.some((e) => e.kind === "step_start" && e.stepId === "later")).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: "workflow_done", ok: false });
  });
});
