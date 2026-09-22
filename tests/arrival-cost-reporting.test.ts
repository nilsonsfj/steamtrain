/**
 * "Unknown" is not "free". Antigravity and Kiro report no usage at all (and
 * Cursor/Amp no cost), so a run on them ends with $0 and no tokens — which the
 * receipt used to read as an agentless, "$0 · no agents" ride.
 */
import { describe, expect, it } from "vitest";
import {
  type StepResult,
  type WorkflowSpec,
  type WorkflowState,
  arrivalReceiptCards,
  buildArrivalReport,
  formatArrivalHeadline,
  workflowStateFromSpec,
} from "../src/workflow";

const spec: WorkflowSpec = {
  name: "review",
  phases: [
    {
      id: "p",
      title: "p",
      steps: [
        { id: "diff", kind: "command", cmd: "git diff" },
        { id: "review", agent: "antigravity", model: "gemini-3.6-flash-high", prompt: "x" },
      ],
    },
  ],
};

function finished(review: Partial<StepResult>): WorkflowState {
  const base = workflowStateFromSpec(spec);
  const [diff, agent] = base.phases[0]!.steps;
  return {
    ...base,
    done: true,
    ok: true,
    phases: [
      {
        ...base.phases[0]!,
        steps: [
          {
            ...diff!,
            status: "done" as const,
            result: { stepId: "diff", ok: true, output: "", durationMs: 10 },
          },
          {
            ...agent!,
            status: "done" as const,
            result: { stepId: "review", ok: true, output: "LGTM", durationMs: 900, ...review },
          },
        ],
      },
    ],
  };
}

describe("arrival receipt for agents that report no usage", () => {
  it("is not agentless when an agent step ran", () => {
    const receipt = buildArrivalReport(finished({}))!.receipt;
    expect(receipt.agentless).toBe(false);
    expect(receipt.costReported).toBe(false);
    expect(receipt.tokensReported).toBe(false);
  });

  it("says the cost is not reported instead of $0", () => {
    const receipt = buildArrivalReport(finished({}))!.receipt;
    expect(formatArrivalHeadline(receipt, "review")).not.toContain("$0");
    const cards = arrivalReceiptCards(receipt);
    expect(cards.find((c) => c.id === "cost")!.value).toBe("not reported");
    expect(cards.find((c) => c.id === "produced")!.value).toBe("tokens not reported");
  });

  it("still shows $0 when the agent reported a zero cost", () => {
    const receipt = buildArrivalReport(
      finished({ costUsd: 0, tokens: { input: 0, output: 0 } }),
    )!.receipt;
    expect(formatArrivalHeadline(receipt, "review")).toContain("$0");
    const cards = arrivalReceiptCards(receipt);
    expect(cards.find((c) => c.id === "cost")!.value).toBe("$0");
    expect(cards.find((c) => c.id === "produced")!.value).toBe("no tokens billed");
  });
});
