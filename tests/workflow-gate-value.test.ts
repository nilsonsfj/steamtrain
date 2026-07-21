import { describe, expect, it } from "vitest";
import {
  type StepResult,
  type WorkflowDeps,
  type WorkflowEvent,
  type WorkflowSpec,
  runWorkflow,
  validateWorkflow,
} from "../src/workflow";

/**
 * Building block 4: `GateCondition.value` — a templated text expression
 * evaluated by the existing contains/matches/equals predicates instead of a
 * step output or the run input. Works on gates and per-step `when`.
 */

function deps(): WorkflowDeps {
  return {
    createAdapter: () => {
      throw new Error("this workflow must not create agent adapters");
    },
    maxConcurrency: 4,
    cwd: process.cwd(),
  };
}

async function runToEvents(
  spec: WorkflowSpec,
  inputs?: Record<string, string>,
): Promise<WorkflowEvent[]> {
  const events: WorkflowEvent[] = [];
  for await (const ev of runWorkflow(spec, { input: "task", inputs }, deps())) events.push(ev);
  return events;
}

function doneResults(events: WorkflowEvent[]): Map<string, StepResult> {
  const map = new Map<string, StepResult>();
  for (const ev of events) if (ev.kind === "step_done") map.set(ev.stepId, ev.result);
  return map;
}

describe("GateCondition.value", () => {
  it("routes a gate on {{inputs.*}} via equals", async () => {
    const spec: WorkflowSpec = {
      name: "value-gate",
      inputs: { issueTiming: { default: "end" } },
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "route",
              kind: "gate",
              condition: { value: "{{inputs.issueTiming}}", equals: "live" },
              onFalse: "continue",
            },
          ],
        },
      ],
    };
    const eventsLive = await runToEvents(spec, { issueTiming: "live" });
    const liveGate = doneResults(eventsLive).get("route");
    expect(liveGate?.gate?.passed).toBe(true);

    const eventsEnd = await runToEvents(spec, { issueTiming: "end" });
    const endGate = doneResults(eventsEnd).get("route");
    expect(endGate?.gate?.passed).toBe(false);
  });

  it("gates a per-step when condition on a templated value", async () => {
    const spec: WorkflowSpec = {
      name: "value-when",
      inputs: { mode: { default: "report" } },
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "step",
              kind: "command",
              cmd: "echo hi",
              when: { value: "{{inputs.mode}}", equals: "github" },
            },
          ],
        },
      ],
    };
    const events = await runToEvents(spec, { mode: "report" });
    const result = doneResults(events).get("step");
    expect(result?.skipped).toBe(true);
  });

  it("supports contains against a value template", async () => {
    const spec: WorkflowSpec = {
      name: "value-contains",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "route",
              kind: "gate",
              condition: { value: "{{input}}", contains: "task" },
              onFalse: "continue",
            },
          ],
        },
      ],
    };
    const events = await runToEvents(spec);
    expect(doneResults(events).get("route")?.gate?.passed).toBe(true);
  });
});

describe("GateCondition.value validation", () => {
  const gateSpec = (condition: object): WorkflowSpec => ({
    name: "value-validate",
    phases: [
      { id: "p1", title: "P1", steps: [{ id: "g", kind: "gate", condition, onFalse: "continue" }] },
    ],
  });

  it("rejects value combined with step", () => {
    const result = validateWorkflow(gateSpec({ value: "x", step: "other", equals: "x" }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("value cannot be combined with step");
  });

  it("rejects value combined with ok", () => {
    const result = validateWorkflow(gateSpec({ value: "x", ok: true }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("value cannot be combined with ok");
  });

  it("rejects value combined with path", () => {
    const result = validateWorkflow(gateSpec({ value: "x", path: "verdict", equals: "x" }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("value cannot be combined with path");
  });

  it("rejects value combined with human", () => {
    const result = validateWorkflow(gateSpec({ value: "x", human: true }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("cannot be combined with ok/path/value/contains/matches/equals");
  });

  it("still requires a predicate alongside value", () => {
    const result = validateWorkflow(gateSpec({ value: "x" }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain(
      "gate condition requires human, ok, contains, matches, or equals",
    );
  });

  it("accepts a valid value condition", () => {
    const result = validateWorkflow(gateSpec({ value: "{{inputs.x}}", equals: "y" }));
    expect(result.ok).toBe(true);
  });
});
