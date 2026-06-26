import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOOP_MAX_ITERATIONS,
  LOOP_MAX_ITERATIONS_CEILING,
  type WorkflowSpec,
  validateWorkflow,
} from "../src/workflow/types";

/** A worker phase with one agent step. */
function workerPhase(id: string, prompt = "do {{input}}") {
  return {
    id,
    title: id,
    steps: [{ id: `${id}-step`, agent: "opencode", model: "opencode/x", prompt } as const],
  };
}

/** A gate phase that loops back to `loopTo` when `recheck-step` is not ok. */
function loopGatePhase(id: string, loopTo: string, conditionStep: string, maxIterations?: number) {
  return {
    id,
    title: id,
    steps: [
      {
        id: `${id}-gate`,
        kind: "gate" as const,
        dependsOn: [conditionStep],
        condition: { step: conditionStep, ok: true },
        loopTo,
        ...(maxIterations !== undefined ? { maxIterations } : {}),
        onFalse: "fail" as const,
      },
    ],
  };
}

function spec(phases: WorkflowSpec["phases"]): WorkflowSpec {
  return { name: "w", phases };
}

describe("loop constants", () => {
  it("defaults to 10, ceiling 100", () => {
    expect(DEFAULT_LOOP_MAX_ITERATIONS).toBe(10);
    expect(LOOP_MAX_ITERATIONS_CEILING).toBe(100);
  });
});

describe("validateWorkflow loop topology", () => {
  it("accepts a gate looping back to an earlier phase", () => {
    const s = spec([
      workerPhase("review"),
      workerPhase("fix"),
      loopGatePhase("check", "review", "fix-step", 5),
    ]);
    expect(validateWorkflow(s)).toEqual({ ok: true });
  });

  it("rejects loopTo referencing a later phase", () => {
    const s = spec([
      workerPhase("review"),
      loopGatePhase("check", "later", "review-step", 5),
      workerPhase("later"),
    ]);
    const r = validateWorkflow(s);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("loopTo");
  });

  it("rejects loopTo referencing an unknown phase", () => {
    const s = spec([workerPhase("review"), loopGatePhase("check", "nope", "review-step", 5)]);
    const r = validateWorkflow(s);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("nope");
  });

  it("rejects partially overlapping loop regions", () => {
    // region A: a..gateB ; region B: b..gateC  → partial overlap
    const s = spec([
      workerPhase("a"),
      workerPhase("b"),
      loopGatePhase("gateB", "a", "b-step", 3),
      loopGatePhase("gateC", "b", "gateB-gate", 3),
    ]);
    const r = validateWorkflow(s);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("overlap");
  });

  it("accepts properly nested loop regions", () => {
    // inner region: b..gateInner ; outer region: a..gateOuter fully contains inner
    const s = spec([
      workerPhase("a"),
      workerPhase("b"),
      loopGatePhase("gateInner", "b", "b-step", 2),
      loopGatePhase("gateOuter", "a", "gateInner-gate", 2),
    ]);
    expect(validateWorkflow(s)).toEqual({ ok: true });
  });

  it("rejects maxIterations above the ceiling via schema", () => {
    const s = spec([workerPhase("review"), loopGatePhase("check", "review", "review-step", 101)]);
    expect(validateWorkflow(s).ok).toBe(false);
  });

  it("rejects a loop whose worst-case expansion exceeds MAX_STEPS", () => {
    // 200-step body × ceiling(100) blows past MAX_STEPS (1000) when maxIterations omitted.
    const body = Array.from({ length: 200 }, (_, i) => workerPhase(`p${i}`));
    const s = spec([
      ...body,
      // condition references the last body step; omit maxIterations → bounded by ceiling
      {
        id: "check",
        title: "check",
        steps: [
          {
            id: "check-gate",
            kind: "gate" as const,
            dependsOn: ["p199-step"],
            condition: { step: "p199-step", ok: true },
            loopTo: "p0",
            onFalse: "fail" as const,
          },
        ],
      },
    ]);
    const r = validateWorkflow(s);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("max");
  });
});
