import { describe, expect, it } from "vitest";
import { type PlanSpec, rewriteStepRefs, validatePlanStructure } from "../src/web/plan-edit.js";

function tourLike(): PlanSpec {
  return {
    name: "tour",
    phases: [
      {
        id: "departure",
        steps: [{ id: "stations", kind: "command", cmd: "echo hi" }],
      },
      {
        id: "open",
        steps: [
          { id: "car-fanout", kind: "command", dependsOn: ["stations"], cmd: "a" },
          {
            id: "express-service",
            kind: "command",
            dependsOn: ["stations"],
            when: { step: "stations", equals: "express" },
            cmd: "b",
          },
        ],
      },
      {
        id: "loop",
        steps: [
          {
            id: "loop-signal",
            kind: "gate",
            dependsOn: ["lap"],
            condition: { step: "lap", equals: "go" },
            loopTo: "laps",
          },
        ],
      },
      {
        id: "fan",
        steps: [
          { id: "items", kind: "command", cmd: "list" },
          { id: "each", kind: "worker", forEach: "items", prompt: "do {{item}}" },
          { id: "merge-them", kind: "merge", from: ["each"], step: "each" },
        ],
      },
    ],
  };
}

describe("rewriteStepRefs", () => {
  it("rewrites dependsOn, when.step, condition.step, forEach, from, and merge.step", () => {
    const spec = tourLike();
    rewriteStepRefs(spec, "stations", "stations-renamed");
    rewriteStepRefs(spec, "items", "items-renamed");
    rewriteStepRefs(spec, "each", "each-renamed");
    rewriteStepRefs(spec, "lap", "lap-renamed");

    const steps = Object.fromEntries(
      (spec.phases || []).flatMap((p) => (p.steps || []).map((s) => [s.id, s])),
    );

    expect(steps["stations-renamed"]).toBeTruthy();
    expect(steps.stations).toBeUndefined();
    expect(steps["car-fanout"]!.dependsOn).toEqual(["stations-renamed"]);
    expect(steps["express-service"]!.dependsOn).toEqual(["stations-renamed"]);
    expect(steps["express-service"]!.when).toEqual({ step: "stations-renamed", equals: "express" });
    expect(steps["loop-signal"]!.condition).toEqual({ step: "lap-renamed", equals: "go" });
    expect(steps["loop-signal"]!.dependsOn).toEqual(["lap-renamed"]);
    expect(steps["each-renamed"]!.forEach).toBe("items-renamed");
    expect(steps["merge-them"]!.from).toEqual(["each-renamed"]);
    expect(steps["merge-them"]!.step).toBe("each-renamed");
  });

  it("does not rewrite a workflow-kind step's workflow name field", () => {
    const spec: PlanSpec = {
      phases: [
        {
          steps: [
            { id: "call", kind: "workflow", workflow: "stations" },
            { id: "stations", kind: "command", cmd: "x" },
          ],
        },
      ],
    };
    rewriteStepRefs(spec, "stations", "stations-renamed");
    expect(spec.phases![0]!.steps![0]!.workflow).toBe("stations");
    expect(spec.phases![0]!.steps![1]!.id).toBe("stations-renamed");
  });
});

describe("validatePlanStructure", () => {
  it("accepts a well-formed plan", () => {
    const spec: PlanSpec = {
      phases: [
        { steps: [{ id: "a", kind: "command", cmd: "x" }] },
        {
          steps: [
            {
              id: "b",
              kind: "command",
              cmd: "y",
              dependsOn: ["a"],
              when: { step: "a", equals: "1" },
            },
            { id: "c", kind: "worker", forEach: "a", prompt: "p" },
            { id: "d", kind: "merge", from: ["c"], step: "c" },
          ],
        },
      ],
    };
    expect(validatePlanStructure(spec)).toEqual({ ok: true, errors: [] });
  });

  it("flags unknown when.step / forEach / from / condition.step refs", () => {
    const spec: PlanSpec = {
      phases: [
        {
          steps: [
            {
              id: "a",
              kind: "command",
              cmd: "x",
              when: { step: "missing", equals: "1" },
              forEach: "gone",
              from: ["also-gone"],
              condition: { step: "nope" },
            },
          ],
        },
      ],
    };
    const { ok, errors } = validatePlanStructure(spec);
    expect(ok).toBe(false);
    expect(errors).toEqual(
      expect.arrayContaining([
        "a when condition references unknown step 'missing'",
        "a forEach references unknown step 'gone'",
        "a from references unknown step 'also-gone'",
        "a condition references unknown step 'nope'",
      ]),
    );
  });

  it("flags when.step that is not in an earlier phase", () => {
    const bad: PlanSpec = {
      phases: [
        {
          steps: [
            {
              id: "needs-future",
              kind: "command",
              cmd: "y",
              when: { step: "future", equals: "1" },
            },
          ],
        },
        { steps: [{ id: "future", kind: "command", cmd: "x" }] },
      ],
    };
    const { ok, errors } = validatePlanStructure(bad);
    expect(ok).toBe(false);
    expect(errors).toContain(
      "needs-future when condition references 'future', which is not in an earlier phase",
    );
  });

  it("flags duplicate and empty ids", () => {
    const spec: PlanSpec = {
      phases: [
        {
          steps: [
            { id: "a", kind: "command", cmd: "x" },
            { id: "a", kind: "command", cmd: "y" },
            { id: "  ", kind: "command", cmd: "z" },
          ],
        },
      ],
    };
    const { ok, errors } = validatePlanStructure(spec);
    expect(ok).toBe(false);
    expect(errors).toEqual(
      expect.arrayContaining(["duplicate step id 'a'", "a step has an empty id"]),
    );
  });
});
