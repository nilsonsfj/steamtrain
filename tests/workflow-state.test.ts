import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  flattenSteps,
  initialWorkflowState,
  workflowReducer,
  workflowStateFromRecord,
} from "../src/tui/workflow-state";
import type { AgentId } from "../src/types/events";
import type { RunRecord, StepResult, WorkflowEvent } from "../src/workflow";

const AGENT: AgentId = "claude";

function reduceAll(events: WorkflowEvent[]) {
  return events.reduce(
    (s, event) => workflowReducer(s, { type: "event", event }),
    initialWorkflowState,
  );
}

const resultA: StepResult = {
  stepId: "a",
  ok: true,
  output: "final A",
  durationMs: 1200,
  costUsd: 0.01,
};

describe("workflowReducer", () => {
  it("builds the phase/step tree from an event sequence and accumulates text", () => {
    const state = reduceAll([
      { kind: "workflow_start", name: "w", phaseCount: 1, stepCount: 1, ts: 0 },
      { kind: "phase_start", phaseId: "p1", title: "Phase 1", index: 0, stepCount: 1, ts: 0 },
      { kind: "step_start", phaseId: "p1", stepId: "a", agent: AGENT, model: "m", ts: 0 },
      {
        kind: "step_event",
        phaseId: "p1",
        stepId: "a",
        event: { kind: "text_delta", agent: AGENT, ts: 0, text: "hel" },
        ts: 0,
      },
      {
        kind: "step_event",
        phaseId: "p1",
        stepId: "a",
        event: { kind: "text_delta", agent: AGENT, ts: 0, text: "lo" },
        ts: 0,
      },
      {
        kind: "step_event",
        phaseId: "p1",
        stepId: "a",
        event: { kind: "text_delta", agent: AGENT, ts: 0, text: "X", thinking: true },
        ts: 0,
      },
      { kind: "step_done", phaseId: "p1", stepId: "a", result: resultA, cached: false, ts: 0 },
      { kind: "phase_done", phaseId: "p1", ok: true, ts: 0 },
      { kind: "workflow_done", ok: true, results: [resultA], ts: 0 },
    ]);

    expect(state.name).toBe("w");
    expect(state.started).toBe(true);
    expect(state.done).toBe(true);
    expect(state.ok).toBe(true);
    expect(state.results).toEqual([resultA]);

    const flat = flattenSteps(state);
    expect(flat).toHaveLength(1);
    const step = flat[0]?.step;
    expect(step?.blockKind).toBe("worker");
    expect(step?.status).toBe("done");
    expect(step?.text).toBe("hello"); // thinking delta excluded
    expect(step?.result).toEqual(resultA);
    expect(state.phases[0]?.done).toBe(true);
  });

  it("tracks tool activity and marks failed steps", () => {
    const state = reduceAll([
      { kind: "workflow_start", name: "w", phaseCount: 1, stepCount: 1, ts: 0 },
      { kind: "phase_start", phaseId: "p1", title: "P1", index: 0, stepCount: 1, ts: 0 },
      { kind: "step_start", phaseId: "p1", stepId: "a", agent: AGENT, model: "m", ts: 0 },
      {
        kind: "step_event",
        phaseId: "p1",
        stepId: "a",
        event: { kind: "tool_use", agent: AGENT, ts: 0, name: "Bash" },
        ts: 0,
      },
      {
        kind: "step_done",
        phaseId: "p1",
        stepId: "a",
        result: { stepId: "a", ok: false, output: "nope", error: "boom", durationMs: 5 },
        cached: false,
        ts: 0,
      },
      { kind: "workflow_done", ok: false, results: [], ts: 0 },
    ]);

    const step = flattenSteps(state)[0]?.step;
    expect(step?.activity).toBe("⚙ Bash");
    expect(step?.status).toBe("error");
    expect(state.ok).toBe(false);
  });

  it("tracks pure workflow block kinds and gate evaluations", () => {
    const result: StepResult = {
      stepId: "gate",
      ok: true,
      output: "ready",
      target: "ready",
      gate: { passed: true, onFalse: "continue" },
      durationMs: 1,
    };
    const state = reduceAll([
      { kind: "workflow_start", name: "w", phaseCount: 1, stepCount: 1, ts: 0 },
      { kind: "phase_start", phaseId: "p1", title: "P1", index: 0, stepCount: 1, ts: 0 },
      { kind: "step_start", phaseId: "p1", stepId: "gate", blockKind: "gate", ts: 0 },
      {
        kind: "gate_evaluated",
        phaseId: "p1",
        stepId: "gate",
        passed: true,
        target: "ready",
        onFalse: "continue",
        ts: 0,
      },
      { kind: "step_done", phaseId: "p1", stepId: "gate", result, cached: false, ts: 0 },
    ]);

    const step = flattenSteps(state)[0]?.step;
    expect(step?.blockKind).toBe("gate");
    expect(step?.agent).toBeUndefined();
    expect(step?.gate).toEqual({ passed: true, target: "ready", onFalse: "continue" });
    expect(step?.activity).toBe("gate passed → ready");
  });

  it("marks a step retrying and records attempts on step_retry", () => {
    const state = reduceAll([
      { kind: "workflow_start", name: "w", phaseCount: 1, stepCount: 1, ts: 0 },
      { kind: "phase_start", phaseId: "p1", title: "P1", index: 0, stepCount: 1, ts: 0 },
      { kind: "step_start", phaseId: "p1", stepId: "a", agent: AGENT, model: "m", ts: 0 },
      {
        kind: "step_retry",
        phaseId: "p1",
        stepId: "a",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1000,
        reason: "transient",
        ts: 0,
      },
    ]);
    const step = flattenSteps(state)[0]?.step;
    expect(step?.attempts).toBe(2);
    expect(step?.activity).toBe("↻ retrying 2/3 (1000ms)");
  });

  it("updates agent/model on step_retry failover and shows a failover activity", () => {
    const state = reduceAll([
      { kind: "workflow_start", name: "w", phaseCount: 1, stepCount: 1, ts: 0 },
      { kind: "phase_start", phaseId: "p1", title: "P1", index: 0, stepCount: 1, ts: 0 },
      {
        kind: "step_start",
        phaseId: "p1",
        stepId: "a",
        agent: AGENT,
        model: "claude-opus-4-8",
        ts: 0,
      },
      {
        kind: "step_retry",
        phaseId: "p1",
        stepId: "a",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 250,
        reason: "quota / billing exhausted · failing over to claude/claude-sonnet-5",
        failover: {
          fromAgent: AGENT,
          fromModel: "claude-opus-4-8",
          toAgent: AGENT,
          toModel: "claude-sonnet-5",
          failureKind: "quota",
        },
        ts: 0,
      },
    ]);
    const step = flattenSteps(state)[0]?.step;
    expect(step?.attempts).toBe(2);
    expect(step?.model).toBe("claude-sonnet-5");
    expect(step?.agent).toBe(AGENT);
    expect(step?.activity).toBe("↻ failover → claude/claude-sonnet-5 (2/3)");
  });

  it("tracks generated fan-out child steps", () => {
    const child: StepResult = {
      stepId: "work[0]",
      parentStepId: "work",
      item: { sourceStepId: "split", index: 0, value: "api" },
      ok: true,
      output: "done api",
      durationMs: 10,
    };
    const state = reduceAll([
      { kind: "workflow_start", name: "w", phaseCount: 1, stepCount: 1, ts: 0 },
      { kind: "phase_start", phaseId: "p1", title: "P1", index: 0, stepCount: 1, ts: 0 },
      {
        kind: "step_start",
        phaseId: "p1",
        stepId: "work",
        blockKind: "processor",
        agent: AGENT,
        model: "m",
        ts: 0,
      },
      {
        kind: "step_start",
        phaseId: "p1",
        stepId: "work[0]",
        blockKind: "processor",
        agent: AGENT,
        model: "m",
        parentStepId: "work",
        item: { sourceStepId: "split", index: 0, value: "api" },
        ts: 0,
      },
      { kind: "step_done", phaseId: "p1", stepId: "work[0]", result: child, cached: false, ts: 0 },
    ]);

    expect(state.phases[0]?.stepCount).toBe(2);
    const generated = flattenSteps(state).find((entry) => entry.step.stepId === "work[0]")?.step;
    expect(generated?.parentStepId).toBe("work");
    expect(generated?.item).toEqual({ sourceStepId: "split", index: 0, value: "api" });
    expect(generated?.status).toBe("done");
  });

  it("rebuilds a render-ready state from a saved run record", () => {
    const record: RunRecord = {
      version: 1,
      id: "r1",
      workflow: "demo",
      input: "go",
      cwd: tmpdir(),
      status: "done",
      ok: true,
      startedAt: 100,
      endedAt: 200,
      durationMs: 100,
      totals: {
        steps: 1,
        ok: 1,
        failed: 0,
        cached: 0,
        costUsd: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        durationMs: 5,
      },
      phases: [
        {
          phaseId: "p1",
          title: "One",
          index: 0,
          stepCount: 1,
          done: true,
          ok: true,
          steps: [
            {
              stepId: "a",
              blockKind: "worker",
              agent: AGENT,
              model: "m",
              status: "done",
              text: "hello",
              cached: false,
              result: { stepId: "a", ok: true, output: "hello", durationMs: 5 },
            },
          ],
        },
      ],
    };

    const state = workflowStateFromRecord(record);
    expect(state.done).toBe(true);
    expect(state.ok).toBe(true);
    expect(state.name).toBe("demo");
    expect(state.startedAt).toBe(100);
    const flat = flattenSteps(state);
    expect(flat).toHaveLength(1);
    expect(flat[0]?.step.text).toBe("hello");
    expect(flat[0]?.step.result?.output).toBe("hello");
  });

  it("populates results from step results in workflowStateFromRecord (M8)", () => {
    const result1: StepResult = { stepId: "a", ok: true, output: "done a", durationMs: 10 };
    const result2: StepResult = {
      stepId: "b",
      ok: false,
      output: "fail b",
      error: "boom",
      durationMs: 5,
    };
    const record: RunRecord = {
      version: 1,
      id: "r2",
      workflow: "test",
      input: "x",
      cwd: tmpdir(),
      status: "error",
      ok: false,
      startedAt: 100,
      endedAt: 200,
      durationMs: 100,
      totals: {
        steps: 2,
        ok: 1,
        failed: 1,
        cached: 0,
        costUsd: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        durationMs: 15,
      },
      phases: [
        {
          phaseId: "p1",
          title: "P1",
          index: 0,
          stepCount: 2,
          done: true,
          ok: false,
          steps: [
            {
              stepId: "a",
              blockKind: "worker",
              status: "done",
              text: "",
              cached: false,
              result: result1,
            },
            {
              stepId: "b",
              blockKind: "worker",
              status: "error",
              text: "",
              cached: false,
              result: result2,
            },
          ],
        },
      ],
    };
    const state = workflowStateFromRecord(record);
    expect(state.results).toHaveLength(2);
    expect(state.results).toContainEqual(result1);
    expect(state.results).toContainEqual(result2);
  });

  it("normalizes unknown step statuses to 'error' in workflowStateFromRecord (M7)", () => {
    const record = {
      version: 1,
      id: "r3",
      workflow: "test",
      input: "x",
      cwd: tmpdir(),
      status: "done",
      ok: true,
      startedAt: 100,
      endedAt: 200,
      durationMs: 100,
      totals: {
        steps: 1,
        ok: 1,
        failed: 0,
        cached: 0,
        costUsd: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        durationMs: 5,
      },
      phases: [
        {
          phaseId: "p1",
          title: "P1",
          index: 0,
          stepCount: 1,
          done: true,
          ok: true,
          steps: [
            { stepId: "a", blockKind: "worker", status: "corrupted", text: "", cached: false },
          ],
        },
      ],
    } as unknown as RunRecord;
    const state = workflowStateFromRecord(record);
    const step = flattenSteps(state)[0]?.step;
    expect(step?.status).toBe("error");
  });

  it("resets to the initial state", () => {
    const seeded = reduceAll([
      { kind: "workflow_start", name: "w", phaseCount: 0, stepCount: 0, ts: 0 },
    ]);
    expect(seeded.started).toBe(true);
    expect(workflowReducer(seeded, { type: "reset" })).toEqual(initialWorkflowState);
  });
});

describe("workflowReducer live visibility metadata", () => {
  const worktree = {
    originalCwd: "/repo",
    cwd: "/tmp/worktrees/a-1",
    root: "/tmp/worktrees/a-1",
    branch: "steamtrain/run/a-1",
    baseCommit: "abc123",
  };

  it("stamps startedAt from step_start and endedAt from step_done", () => {
    const state = reduceAll([
      { kind: "workflow_start", name: "w", phaseCount: 1, stepCount: 1, ts: 100 },
      { kind: "phase_start", phaseId: "p1", title: "P1", index: 0, stepCount: 1, ts: 100 },
      { kind: "step_start", phaseId: "p1", stepId: "a", agent: AGENT, model: "m", ts: 150 },
      { kind: "step_done", phaseId: "p1", stepId: "a", result: resultA, cached: false, ts: 1350 },
    ]);
    const step = flattenSteps(state)[0]?.step;
    expect(step?.startedAt).toBe(150);
    expect(step?.endedAt).toBe(1350);
  });

  it("folds step_workspace into live cwd + worktree", () => {
    const state = reduceAll([
      { kind: "workflow_start", name: "w", phaseCount: 1, stepCount: 1, ts: 0 },
      { kind: "phase_start", phaseId: "p1", title: "P1", index: 0, stepCount: 1, ts: 0 },
      { kind: "step_start", phaseId: "p1", stepId: "a", agent: AGENT, model: "m", ts: 0 },
      {
        kind: "step_workspace",
        phaseId: "p1",
        stepId: "a",
        cwd: worktree.cwd,
        worktree,
        ts: 5,
      },
    ]);
    const step = flattenSteps(state)[0]?.step;
    expect(step?.status).toBe("running");
    expect(step?.cwd).toBe(worktree.cwd);
    expect(step?.worktree).toEqual(worktree);
  });

  it("keeps the worktree from the final result when no live event arrived", () => {
    const state = reduceAll([
      { kind: "workflow_start", name: "w", phaseCount: 1, stepCount: 1, ts: 0 },
      { kind: "phase_start", phaseId: "p1", title: "P1", index: 0, stepCount: 1, ts: 0 },
      { kind: "step_start", phaseId: "p1", stepId: "a", agent: AGENT, model: "m", ts: 0 },
      {
        kind: "step_done",
        phaseId: "p1",
        stepId: "a",
        result: { ...resultA, worktree },
        cached: false,
        ts: 9,
      },
    ]);
    const step = flattenSteps(state)[0]?.step;
    expect(step?.worktree).toEqual(worktree);
  });

  it("a plain-cwd step_workspace (no git repo) only updates the cwd", () => {
    const state = reduceAll([
      { kind: "workflow_start", name: "w", phaseCount: 1, stepCount: 1, ts: 0 },
      { kind: "phase_start", phaseId: "p1", title: "P1", index: 0, stepCount: 1, ts: 0 },
      { kind: "step_start", phaseId: "p1", stepId: "a", agent: AGENT, model: "m", ts: 0 },
      { kind: "step_workspace", phaseId: "p1", stepId: "a", cwd: "/repo/src", ts: 5 },
    ]);
    const step = flattenSteps(state)[0]?.step;
    expect(step?.cwd).toBe("/repo/src");
    expect(step?.worktree).toBeUndefined();
  });
});

/**
 * Live spend. The engine forwards every agent event as `step_event`, so the
 * reducer is where a running step's usage becomes state a UI can read — see
 * StepUsageState. Two shapes arrive: `usage` increments (Claude Code's
 * per-message reports) and interim `result` events restating a running total
 * (opencode's per-sub-step finishes).
 */
describe("workflowReducer live usage", () => {
  function running(events: WorkflowEvent[]) {
    return flattenSteps(
      reduceAll([
        { kind: "workflow_start", name: "w", phaseCount: 1, stepCount: 1, ts: 0 },
        { kind: "phase_start", phaseId: "p1", title: "P1", index: 0, stepCount: 1, ts: 0 },
        { kind: "step_start", phaseId: "p1", stepId: "a", agent: AGENT, model: "m", ts: 0 },
        ...events,
      ]),
    )[0]?.step;
  }

  function usage(tokens: Record<string, number>, costUsd?: number): WorkflowEvent {
    return {
      kind: "step_event",
      phaseId: "p1",
      stepId: "a",
      event: { kind: "usage", agent: AGENT, ts: 0, tokens, costUsd },
      ts: 0,
    };
  }

  it("has no usage at all until the agent reports some", () => {
    // Not zero: nobody should read "$0.0000" off a step that simply has not
    // said anything yet.
    expect(running([])?.usage).toBeUndefined();
  });

  it("accumulates usage increments", () => {
    const step = running([
      usage({ input: 100, output: 10 }),
      usage({ output: 25, cacheRead: 900 }),
    ]);
    expect(step?.usage?.tokens).toMatchObject({ input: 100, output: 35, cacheRead: 900 });
  });

  it("sums the cost of increments that carry one", () => {
    const step = running([usage({ output: 1 }, 0.002), usage({ output: 1 }, 0.003)]);
    expect(step?.usage?.costUsd).toBeCloseTo(0.005, 6);
  });

  it("lets an interim result restate the total instead of adding to it", () => {
    const step = running([
      usage({ input: 100, output: 10 }),
      {
        kind: "step_event",
        phaseId: "p1",
        stepId: "a",
        // opencode's step_finish: a running total, not a delta.
        event: {
          kind: "result",
          agent: AGENT,
          ts: 0,
          isError: false,
          costUsd: 0.004,
          tokens: { input: 100, output: 40 },
        },
        ts: 0,
      },
    ]);
    expect(step?.usage?.tokens).toMatchObject({ input: 100, output: 40 });
    expect(step?.usage?.costUsd).toBe(0.004);
  });

  it("keeps the accumulated tokens when a result restates only the cost", () => {
    const step = running([
      usage({ input: 100, output: 10 }),
      {
        kind: "step_event",
        phaseId: "p1",
        stepId: "a",
        event: { kind: "result", agent: AGENT, ts: 0, isError: false, costUsd: 0.004 },
        ts: 0,
      },
    ]);
    expect(step?.usage?.tokens).toMatchObject({ input: 100, output: 10 });
    expect(step?.usage?.costUsd).toBe(0.004);
  });

  it("ignores a result that carries no usage at all", () => {
    const step = running([
      usage({ input: 100 }),
      {
        kind: "step_event",
        phaseId: "p1",
        stepId: "a",
        event: { kind: "result", agent: AGENT, ts: 0, isError: false, text: "done" },
        ts: 0,
      },
    ]);
    expect(step?.usage?.tokens).toMatchObject({ input: 100 });
  });

  it("leaves the finished result as the billed record beside it", () => {
    const step = running([
      usage({ input: 100, output: 10 }),
      {
        kind: "step_done",
        phaseId: "p1",
        stepId: "a",
        result: { ...resultA, tokens: { input: 100, output: 12 } },
        cached: false,
        ts: 9,
      },
    ]);
    // The live total stays as it was; every UI prefers `result` once it exists,
    // so the two never get added together.
    expect(step?.result?.tokens).toMatchObject({ output: 12 });
    expect(step?.usage?.tokens).toMatchObject({ output: 10 });
  });
});
