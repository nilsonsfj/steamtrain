import { describe, expect, it } from "vitest";
import { type WorkflowSpec, validateWorkflow } from "../src/workflow/types";

const loopWorkflow: WorkflowSpec = {
  name: "review-loop",
  phases: [
    {
      id: "review",
      title: "review",
      steps: [{ id: "r", agent: "opencode", model: "m", prompt: "review {{input}}" }],
    },
    {
      id: "fix",
      title: "fix",
      steps: [{ id: "f", agent: "opencode", model: "m", prompt: "fix {{steps.r.output}}" }],
    },
    {
      id: "check",
      title: "check",
      steps: [
        {
          id: "g",
          kind: "gate",
          dependsOn: ["f"],
          condition: { step: "f", contains: "DONE" },
          loopTo: "review",
          maxIterations: 4,
          onFalse: "fail",
        },
      ],
    },
  ],
};

describe("web accepts loop workflows", () => {
  it("validates a loop spec the authoring layer would persist", () => {
    expect(validateWorkflow(loopWorkflow)).toEqual({ ok: true });
  });
});
