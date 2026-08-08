/**
 * Failed is not skipped (design 5a).
 *
 * A run that broke on one step used to report every step downstream of it as
 * a failure too — "4 failed" for one broken command — because the receipt
 * counted a cascade victim (a step that never started) as a failure. These
 * pin the distinction: the counts split them, and `arrivalRootCause` names the
 * one step that actually broke plus everything its breaking blocked.
 */
import { describe, expect, it } from "vitest";
import {
  type WorkflowSpec,
  type WorkflowState,
  arrivalReceiptCards,
  arrivalRootCause,
  buildArrivalReport,
  formatArrivalReceipt,
  isCascadeVictim,
  workflowStateFromSpec,
} from "../src/workflow";

const spec: WorkflowSpec = {
  name: "rebase-all-prs",
  phases: [
    {
      id: "setup",
      title: "Fetch latest and detect default branch",
      steps: [
        { id: "fetch", kind: "command", cmd: "git fetch --all --prune" },
        {
          id: "default-branch",
          kind: "command",
          cmd: "git symbolic-ref refs/remotes/origin/HEAD --short",
        },
      ],
    },
    {
      id: "list-prs",
      title: "List open PRs",
      steps: [{ id: "prs", kind: "distributor", dependsOn: ["default-branch"], items: ["a"] }],
    },
    {
      id: "rebase",
      title: "Rebase each PR remotely",
      steps: [{ id: "rebase-prs", kind: "processor", dependsOn: ["prs"], prompt: "x" }],
    },
    {
      id: "summary",
      title: "Summarize results",
      steps: [{ id: "report", kind: "consolidator", dependsOn: ["rebase-prs"], prompt: "y" }],
    },
  ],
};

/** One broken command, three steps that never started because of it. */
function stoppedRun(): WorkflowState {
  const base = workflowStateFromSpec(spec);
  const blocked = (stepId: string, dep: string) => ({
    stepId,
    ok: false,
    dependencyFailed: dep,
    error: `dependency '${dep}' failed`,
    output: "",
    durationMs: 0,
  });
  return {
    ...base,
    done: true,
    ok: false,
    phases: [
      {
        ...base.phases[0]!,
        steps: [
          {
            ...base.phases[0]!.steps[0]!,
            status: "done" as const,
            result: { stepId: "fetch", ok: true, output: "Fetching origin", durationMs: 5100 },
          },
          {
            ...base.phases[0]!.steps[1]!,
            status: "error" as const,
            result: {
              stepId: "default-branch",
              ok: false,
              error: "command exited with code 1\nsecond line",
              output: "fatal: ref refs/remotes/origin/HEAD is not a symbolic ref",
              durationMs: 3200,
            },
          },
        ],
      },
      {
        ...base.phases[1]!,
        steps: [
          {
            ...base.phases[1]!.steps[0]!,
            status: "error" as const,
            result: blocked("prs", "default-branch"),
          },
        ],
      },
      {
        ...base.phases[2]!,
        steps: [
          {
            ...base.phases[2]!.steps[0]!,
            status: "error" as const,
            result: blocked("rebase-prs", "prs"),
          },
        ],
      },
      {
        ...base.phases[3]!,
        steps: [
          {
            ...base.phases[3]!.steps[0]!,
            status: "error" as const,
            result: blocked("report", "rebase-prs"),
          },
        ],
      },
    ],
  };
}

describe("arrival root cause", () => {
  it("counts one failure and three blocked steps, not four failures", () => {
    const receipt = buildArrivalReport(stoppedRun(), { elapsedMs: 5200 })!.receipt;
    expect(receipt.okCount).toBe(1);
    expect(receipt.failCount).toBe(1);
    expect(receipt.blockedCount).toBe(3);
    expect(receipt.skipCount).toBe(0);
  });

  it("says '1 failed · 3 skipped' rather than '4 failed'", () => {
    const receipt = buildArrivalReport(stoppedRun(), { elapsedMs: 5200 })!.receipt;
    expect(formatArrivalReceipt(receipt)).toContain("1 failed");
    expect(formatArrivalReceipt(receipt)).toContain("3 skipped");
    expect(formatArrivalReceipt(receipt)).not.toContain("4 failed");
    expect(arrivalReceiptCards(receipt)[0]!.value).toBe("1 ok · 1 failed · 3 skipped");
  });

  it("a run stopped by a cascade is never called agentless", () => {
    // $0 and 0 tokens with a cascade is a stopped run, not a free one.
    const receipt = buildArrivalReport(stoppedRun(), { elapsedMs: 5200 })!.receipt;
    expect(receipt.agentless).toBe(false);
  });

  it("names the step that broke, where it sits, and what it blocked", () => {
    const root = arrivalRootCause(stoppedRun());
    expect(root).not.toBeNull();
    expect(root!.stepId).toBe("default-branch");
    expect(root!.blockKind).toBe("command");
    expect(root!.phaseNumber).toBe(1);
    expect(root!.phaseTitle).toBe("Fetch latest and detect default branch");
    expect(root!.durationMs).toBe(3200);
    expect(root!.killed).toBe(false);
    // First line only: the rest belongs in the output pane.
    expect(root!.error).toBe("command exited with code 1");
    expect(root!.blocked).toEqual(["prs", "rebase-prs", "report"]);
  });

  it("has no root cause for a run that finished", () => {
    const state = { ...stoppedRun(), ok: true };
    expect(arrivalRootCause(state)).toBeNull();
  });

  it("recognises a cascade victim from the legacy message as well as the marker", () => {
    expect(isCascadeVictim({ dependencyFailed: "a" })).toBe(true);
    expect(isCascadeVictim({ error: "dependency 'a' failed: boom" })).toBe(true);
    expect(isCascadeVictim({ error: "command exited with code 1" })).toBe(false);
    expect(isCascadeVictim(undefined)).toBe(false);
  });

  it("nominates no root when every failure is a cascade victim", () => {
    // Nothing identifiable broke here (the root is missing from the record);
    // pointing at an arbitrary victim would be a guess dressed as a diagnosis.
    const state = stoppedRun();
    state.phases[0]!.steps[1]!.result = {
      stepId: "default-branch",
      ok: false,
      dependencyFailed: "fetch",
      error: "dependency 'fetch' failed",
      output: "",
      durationMs: 0,
    };
    expect(arrivalRootCause(state)).toBeNull();
  });
});
