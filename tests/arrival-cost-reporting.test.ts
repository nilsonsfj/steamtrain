/**
 * "Unknown" is not "free". Antigravity and Kiro report no usage at all (and
 * Cursor/Amp no cost), so a run on them ends with $0 and no tokens — which the
 * receipt used to read as an agentless, "$0 · no agents" ride.
 */
import { describe, expect, it } from "vitest";
import {
  type RunRecord,
  type StepResult,
  type WorkflowSpec,
  type WorkflowState,
  arrivalReceiptCards,
  buildArrivalReport,
  formatArrivalHeadline,
  workflowStateFromRecord,
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

  it("does not count reasoning twice (it is a subset of output)", () => {
    // opencode-shaped: reasoning folded into output and also kept on its own.
    const receipt = buildArrivalReport(
      finished({ costUsd: 0.01, tokens: { input: 100, output: 50, reasoning: 20, cacheRead: 30 } }),
    )!.receipt;
    expect(receipt.tokens).toBe(180);
  });

  it("does not bill a cached replay to this run", () => {
    const state = finished({ costUsd: 0.5, tokens: { input: 1000, output: 10 } });
    state.phases[0]!.steps[1]!.cached = true;
    const receipt = buildArrivalReport(state)!.receipt;
    expect(receipt.costUsd).toBe(0);
    expect(receipt.tokens).toBe(0);
    expect(receipt.costReported).toBe(true);
    expect(arrivalReceiptCards(receipt).find((c) => c.id === "cost")!.value).toBe("$0");
  });

  it("does not bill a cached replay when reopened from history", () => {
    // History detail rebuilds state from the saved record, whose steps keep
    // the original result; the receipt must still read $0 for the replay.
    const record: RunRecord = {
      version: 1,
      id: "r1",
      workflow: "review",
      input: "",
      cwd: "/repo",
      status: "done",
      ok: true,
      startedAt: 100,
      endedAt: 1100,
      durationMs: 1000,
      totals: {
        steps: 1,
        ok: 1,
        failed: 0,
        cached: 1,
        costUsd: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        durationMs: 900,
      },
      phases: [
        {
          phaseId: "p",
          title: "p",
          index: 0,
          stepCount: 1,
          done: true,
          ok: true,
          steps: [
            {
              stepId: "review",
              blockKind: "worker",
              agent: "claude",
              status: "done",
              text: "LGTM",
              cached: true,
              result: {
                stepId: "review",
                ok: true,
                output: "LGTM",
                durationMs: 900,
                costUsd: 0.5,
                tokens: { input: 1000, output: 10 },
              },
            },
          ],
        },
      ],
    };
    const receipt = buildArrivalReport(workflowStateFromRecord(record))!.receipt;
    expect(receipt.costUsd).toBe(0);
    expect(receipt.tokens).toBe(0);
    expect(receipt.costReported).toBe(true);
    // The saved step still shows what it once cost.
    expect(record.phases[0]!.steps[0]!.result!.costUsd).toBe(0.5);
  });
});
