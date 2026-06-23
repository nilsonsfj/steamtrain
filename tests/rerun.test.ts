import { describe, expect, it } from "vitest";
import { hashWorkflowSpec } from "../src/workflow/cache-store";
import type { HistoryPhase, HistoryStep, RunRecord } from "../src/workflow/history";
import { RUN_RECORD_VERSION } from "../src/workflow/history";
import {
  type RerunPlan,
  isRerunError,
  planRerun,
  seedCacheFromRecord,
} from "../src/workflow/rerun";
import type { WorkflowSpec } from "../src/workflow/types";

function step(over: Partial<HistoryStep> & { stepId: string }): HistoryStep {
  return {
    blockKind: "worker",
    status: "done",
    text: "",
    cached: false,
    result: { stepId: over.stepId, ok: true, output: "out", durationMs: 1 },
    ...over,
  };
}

function phase(steps: HistoryStep[]): HistoryPhase {
  return {
    phaseId: "p1",
    title: "P1",
    index: 0,
    stepCount: steps.length,
    steps,
    done: true,
    ok: true,
  };
}

function record(over: Partial<RunRecord>): RunRecord {
  return {
    version: RUN_RECORD_VERSION,
    id: "r1",
    workflow: "demo",
    input: "in",
    cwd: "/tmp",
    status: "error",
    ok: false,
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    phases: [],
    totals: { steps: 0, ok: 0, failed: 0, cached: 0, costUsd: 0, durationMs: 0 },
    ...over,
  };
}

const spec: WorkflowSpec = {
  name: "demo",
  description: "d",
  phases: [
    {
      id: "p1",
      title: "P1",
      steps: [{ id: "a", kind: "worker", agent: "claude", model: "sonnet", prompt: "x" }],
    },
  ],
};

describe("seedCacheFromRecord", () => {
  it("includes done steps (parents and fan-out children), excludes others", () => {
    const rec = record({
      phases: [
        phase([
          step({ stepId: "a" }), // done
          step({
            stepId: "b",
            status: "error",
            result: { stepId: "b", ok: false, output: "boom", durationMs: 1 },
          }),
          step({ stepId: "c", status: "pending", result: undefined }),
          step({ stepId: "fan" }), // done parent
          step({ stepId: "fan[0]", parentStepId: "fan" }), // done child
          step({
            stepId: "fan[1]",
            parentStepId: "fan",
            status: "error",
            result: { stepId: "fan[1]", ok: false, output: "x", durationMs: 1 },
          }),
        ]),
      ],
    });
    const seed = seedCacheFromRecord(rec);
    expect([...seed.keys()].sort()).toEqual(["a", "fan", "fan[0]"]);
  });

  it("skips done steps that have no stored result", () => {
    const rec = record({ phases: [phase([step({ stepId: "a", result: undefined })])] });
    expect(seedCacheFromRecord(rec).size).toBe(0);
  });
});

describe("planRerun", () => {
  it("errors when the workflow no longer exists", () => {
    const plan = planRerun(record({}), "rerun", undefined);
    expect(isRerunError(plan)).toBe(true);
    if (isRerunError(plan)) expect(plan.error).toContain("demo");
  });

  it("rerun mode produces an empty seed and no downgrade", () => {
    const plan = planRerun(
      record({ specHash: hashWorkflowSpec(spec) }),
      "rerun",
      spec,
    ) as RerunPlan;
    expect(isRerunError(plan)).toBe(false);
    expect(plan.seedCache.size).toBe(0);
    expect(plan.downgraded).toBeUndefined();
    expect(plan.workflow).toBe("demo");
    expect(plan.input).toBe("in");
  });

  it("retry-failed seeds from the record when specHash matches", () => {
    const rec = record({
      specHash: hashWorkflowSpec(spec),
      phases: [phase([step({ stepId: "a" })])],
    });
    const plan = planRerun(rec, "retry-failed", spec) as RerunPlan;
    expect(plan.seedCache.has("a")).toBe(true);
    expect(plan.downgraded).toBeUndefined();
  });

  it("retry-failed downgrades to a full re-run when specHash is absent", () => {
    const rec = record({ phases: [phase([step({ stepId: "a" })])] });
    const plan = planRerun(rec, "retry-failed", spec) as RerunPlan;
    expect(plan.seedCache.size).toBe(0);
    expect(plan.downgraded).toBe("no-spec-hash");
  });

  it("retry-failed downgrades when the spec changed", () => {
    const rec = record({ specHash: "stale", phases: [phase([step({ stepId: "a" })])] });
    const plan = planRerun(rec, "retry-failed", spec) as RerunPlan;
    expect(plan.seedCache.size).toBe(0);
    expect(plan.downgraded).toBe("spec-changed");
  });

  it("retry-failed downgrades when the input differs from the record", () => {
    const rec = record({
      specHash: hashWorkflowSpec(spec),
      input: "in",
      phases: [phase([step({ stepId: "a" })])],
    });
    const plan = planRerun(rec, "retry-failed", spec, { input: "something else" }) as RerunPlan;
    expect(plan.seedCache.size).toBe(0);
    expect(plan.downgraded).toBe("input-changed");
    expect(plan.input).toBe("something else");
  });

  it("retry-failed downgrades when the cwd differs from the record", () => {
    const rec = record({
      specHash: hashWorkflowSpec(spec),
      cwd: "/tmp",
      phases: [phase([step({ stepId: "a" })])],
    });
    const plan = planRerun(rec, "retry-failed", spec, { cwd: "/elsewhere" }) as RerunPlan;
    expect(plan.seedCache.size).toBe(0);
    expect(plan.downgraded).toBe("cwd-changed");
  });

  it("retry-failed still seeds when input and cwd match", () => {
    const rec = record({
      specHash: hashWorkflowSpec(spec),
      input: "in",
      cwd: "/tmp",
      phases: [phase([step({ stepId: "a" })])],
    });
    const plan = planRerun(rec, "retry-failed", spec, { input: "in", cwd: "/tmp" }) as RerunPlan;
    expect(plan.seedCache.has("a")).toBe(true);
    expect(plan.downgraded).toBeUndefined();
  });

  it("re-run carries an input override into the plan", () => {
    const rec = record({ specHash: hashWorkflowSpec(spec) });
    const plan = planRerun(rec, "rerun", spec, { input: "fresh input" }) as RerunPlan;
    expect(plan.input).toBe("fresh input");
    expect(plan.seedCache.size).toBe(0);
  });
});
