import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults";
import type { HistoryPhase, HistoryStep, RunRecord } from "../src/workflow/history";
import { RUN_RECORD_VERSION } from "../src/workflow/history";
import { applyWorkflowStepOverrides } from "../src/workflow/overrides";
import { seedCacheFromRecord } from "../src/workflow/rerun";
import {
  applyRetryStepFilter,
  listRetryCandidateSteps,
  planRetryRetarget,
} from "../src/workflow/retry-retarget";
import type { WorkflowSpec } from "../src/workflow/types";

function histStep(over: Partial<HistoryStep> & { stepId: string }): HistoryStep {
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

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    version: RUN_RECORD_VERSION,
    id: "r1",
    workflow: "demo",
    input: "in",
    cwd: tmpdir(),
    status: "error",
    ok: false,
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    phases: [],
    totals: {
      steps: 0,
      ok: 0,
      failed: 0,
      cached: 0,
      costUsd: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      durationMs: 0,
    },
    ...over,
  };
}

const spec: WorkflowSpec = {
  name: "demo",
  description: "d",
  phases: [
    {
      id: "scan",
      title: "Scan",
      steps: [
        { id: "scan-a", kind: "worker", agent: "kiro", model: "auto", prompt: "a" },
        { id: "scan-b", kind: "worker", agent: "kiro", model: "auto", prompt: "b" },
      ],
    },
    {
      id: "check",
      title: "Check",
      steps: [
        {
          id: "cross-check",
          kind: "consolidator",
          agent: "kiro",
          model: "auto",
          prompt: "c",
          dependsOn: ["scan-a", "scan-b"],
        },
        {
          id: "gate1",
          kind: "gate",
          dependsOn: ["cross-check"],
          condition: { step: "cross-check", ok: true },
          target: "ok",
          onFalse: "fail",
        },
      ],
    },
  ],
};

const ready = (agents: string[]) => (agent: string) => agents.includes(agent);

function failedRecord(): RunRecord {
  return record({
    phases: [
      phase([
        histStep({ stepId: "scan-a", agent: "kiro", model: "auto" }),
        histStep({ stepId: "scan-b", agent: "kiro", model: "auto" }),
        histStep({
          stepId: "cross-check",
          agent: "kiro",
          model: "auto",
          status: "error",
          result: {
            stepId: "cross-check",
            ok: false,
            output: "quota",
            error: "quota",
            durationMs: 1,
          },
        }),
        histStep({
          stepId: "gate1",
          blockKind: "gate",
          status: "error",
          result: {
            stepId: "gate1",
            ok: false,
            output: "ok",
            error: "gate condition did not pass",
            durationMs: 0,
          },
        }),
      ]),
    ],
  });
}

describe("listRetryCandidateSteps", () => {
  it("lists non-done steps from the record", () => {
    const ids = listRetryCandidateSteps(failedRecord()).map((s) => s.stepId);
    expect(ids).toEqual(["cross-check", "gate1"]);
  });
});

describe("applyRetryStepFilter", () => {
  it("leaves the seed unchanged when stepIds is omitted", () => {
    const rec = failedRecord();
    const seed = seedCacheFromRecord(rec);
    const next = applyRetryStepFilter(rec, seed, undefined);
    expect([...next.keys()].sort()).toEqual(["scan-a", "scan-b"]);
  });

  it("seeds synthetic skips for non-selected non-done steps", () => {
    const rec = failedRecord();
    const seed = seedCacheFromRecord(rec);
    const next = applyRetryStepFilter(rec, seed, ["cross-check"]);
    expect(next.get("scan-a")?.ok).toBe(true);
    expect(next.get("cross-check")).toBeUndefined();
    expect(next.get("gate1")).toMatchObject({
      stepId: "gate1",
      ok: true,
      skipped: true,
      output: "",
    });
  });

  it("errors when a step id is unknown to the workflow and record", () => {
    const rec = failedRecord();
    expect(() => applyRetryStepFilter(rec, seedCacheFromRecord(rec), ["nope"], spec)).toThrow(
      /unknown step/i,
    );
  });
});

describe("planRetryRetarget", () => {
  it("retargets all failed agent-backed steps onto the requested agent", () => {
    const result = planRetryRetarget(spec, failedRecord(), DEFAULT_CONFIG, ready(["claude"]), {
      agent: "claude",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stepIds).toEqual(["cross-check"]);
    expect(Object.keys(result.overrides)).toEqual(["cross-check"]);
    const next = applyWorkflowStepOverrides(spec, result.overrides);
    const step = next.phases[1]!.steps[0] as { agent: string; model: string };
    expect(step.agent).toBe("claude");
    expect(step.model).toBeTruthy();
  });

  it("honors an explicit retarget model when the agent offers it", () => {
    const result = planRetryRetarget(spec, failedRecord(), DEFAULT_CONFIG, ready(["claude"]), {
      agent: "claude",
      model: "claude-sonnet-5",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.overrides["cross-check"]).toMatchObject({
      agent: "claude",
      model: "claude-sonnet-5",
    });
  });

  it("errors when the retarget model is not offered by the agent", () => {
    const result = planRetryRetarget(spec, failedRecord(), DEFAULT_CONFIG, ready(["claude"]), {
      agent: "claude",
      model: "totally-not-a-model",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/model/i);
  });

  it("narrows retarget to --step ids", () => {
    const bothFailed = record({
      phases: [
        phase([
          histStep({
            stepId: "scan-a",
            agent: "kiro",
            status: "error",
            result: { stepId: "scan-a", ok: false, output: "x", error: "x", durationMs: 1 },
          }),
          histStep({
            stepId: "scan-b",
            agent: "kiro",
            status: "error",
            result: { stepId: "scan-b", ok: false, output: "x", error: "x", durationMs: 1 },
          }),
        ]),
      ],
    });
    const result = planRetryRetarget(spec, bothFailed, DEFAULT_CONFIG, ready(["claude"]), {
      agent: "claude",
      stepIds: ["scan-b"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stepIds).toEqual(["scan-b"]);
  });

  it("errors when the target agent is not ready", () => {
    const result = planRetryRetarget(spec, failedRecord(), DEFAULT_CONFIG, ready([]), {
      agent: "claude",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not ready/i);
  });

  it("errors when no eligible agent-backed steps remain", () => {
    const onlyGate = record({
      phases: [
        phase([
          histStep({
            stepId: "gate1",
            blockKind: "gate",
            status: "error",
            result: { stepId: "gate1", ok: false, output: "x", error: "x", durationMs: 0 },
          }),
        ]),
      ],
    });
    const result = planRetryRetarget(spec, onlyGate, DEFAULT_CONFIG, ready(["claude"]), {
      agent: "claude",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/no agent-backed/i);
  });
});
