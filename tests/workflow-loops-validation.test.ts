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
    // 200-step body × default(10) blows past MAX_STEPS (1000) when maxIterations
    // omitted — the runtime cap (default 10) is the budget assumption, not the
    // ceiling, so this still rejects after the H2 fix.
    const body = Array.from({ length: 200 }, (_, i) => workerPhase(`p${i}`));
    const s = spec([
      ...body,
      // condition references the last body step; omit maxIterations → bounded by
      // the configured/default cap (10), not the ceiling (100)
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

  it("accepts a moderate loop body with omitted maxIterations (defaults to 10, not the ceiling)", () => {
    // 20-step body × default(10) = 189 extra + 21 base = 210 ≪ 1000 → accepted.
    // Under the old ceiling-as-budget assumption (×100) this would have been
    // rejected (2100 > 1000), forcing authors to attach an explicit
    // maxIterations even for tiny loops.
    const body = Array.from({ length: 20 }, (_, i) => workerPhase(`p${i}`));
    const s = spec([
      ...body,
      {
        id: "check",
        title: "check",
        steps: [
          {
            id: "check-gate",
            kind: "gate" as const,
            dependsOn: ["p19-step"],
            condition: { step: "p19-step", ok: true },
            loopTo: "p0",
            onFalse: "fail" as const,
          },
        ],
      },
    ]);
    expect(validateWorkflow(s)).toEqual({ ok: true });
  });

  it("budgets omitted maxIterations against the configured loopMaxIterations", () => {
    // 100-step body: ×default(10) = 909 extra + 101 base = 1010 > 1000 (rejected)
    // but ×2 = 101 extra + 101 base = 202 ≤ 1000 (accepted when config=2).
    const body = Array.from({ length: 100 }, (_, i) => workerPhase(`p${i}`));
    const s = spec([
      ...body,
      {
        id: "check",
        title: "check",
        steps: [
          {
            id: "check-gate",
            kind: "gate" as const,
            dependsOn: ["p99-step"],
            condition: { step: "p99-step", ok: true },
            loopTo: "p0",
            onFalse: "fail" as const,
          },
        ],
      },
    ]);
    expect(validateWorkflow(s).ok).toBe(false); // default 10 → over budget
    expect(validateWorkflow(s, 2).ok).toBe(true); // config 2 → within budget
  });

  it("rejects loopTo referencing the gate's own phase (self-loop)", () => {
    // A gate that loops to its own phase creates a useless self-loop: no body
    // steps run between evaluations, so the gate re-evaluates with the same
    // result and burns the entire cap doing nothing.
    const s = spec([
      workerPhase("review"),
      {
        id: "check",
        title: "check",
        steps: [
          {
            id: "check-gate",
            kind: "gate" as const,
            dependsOn: ["review-step"],
            condition: { step: "review-step", ok: true },
            loopTo: "check", // self-loop: targets the gate's own phase
            maxIterations: 3,
            onFalse: "fail" as const,
          },
        ],
      },
    ]);
    const r = validateWorkflow(s);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("earlier phase");
  });
});
