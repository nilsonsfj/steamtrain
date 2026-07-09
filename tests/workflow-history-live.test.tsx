import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { WorkflowHistory } from "../src/tui/WorkflowHistory";
import type { LiveRunMeta, RunRecordSummary } from "../src/workflow";
import { emptyTokens, newLiveRunMeta } from "../src/workflow";

function liveRun(id: string, overrides: Partial<LiveRunMeta> = {}): LiveRunMeta {
  return {
    ...newLiveRunMeta({
      id,
      workflow: "bug-hunt",
      input: "find the regression",
      cwd: "/tmp",
      source: "cli-detached",
      detached: true,
    }),
    status: "running",
    startedAt: Date.now(),
    ...overrides,
  };
}

function recorded(id: string): RunRecordSummary {
  return {
    version: 1,
    id,
    workflow: "tour",
    input: "all aboard",
    cwd: "/tmp",
    status: "done",
    ok: true,
    startedAt: Date.now() - 60_000,
    endedAt: Date.now() - 50_000,
    durationMs: 10_000,
    totals: {
      steps: 3,
      ok: 3,
      failed: 0,
      cached: 0,
      costUsd: 0,
      tokens: emptyTokens(),
      durationMs: 10_000,
    },
  };
}

describe("WorkflowHistory live-run section", () => {
  it("lists in-flight runs above recorded history", () => {
    const { lastFrame } = render(
      <WorkflowHistory
        runs={[recorded("r1")]}
        liveRuns={[liveRun("live-1"), liveRun("live-2", { status: "queued", pid: process.pid })]}
        selectedIndex={0}
        loading={false}
        width={120}
        height={20}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("2 active");
    expect(frame).toContain("1 recorded");
    expect(frame).toContain("bug-hunt");
    expect(frame).toContain("detached");
    expect(frame).toContain("queued");
    expect(frame).toContain("Enter attaches");
    expect(frame).toContain("tour");
  });

  it("shows a pending-approval badge on live runs", () => {
    const { lastFrame } = render(
      <WorkflowHistory
        runs={[]}
        liveRuns={[liveRun("live-1", { pendingApprovals: [{ stepId: "gate", iteration: 1 }] })]}
        selectedIndex={0}
        loading={false}
        width={120}
        height={12}
      />,
    );
    expect(lastFrame()).toContain("approval: gate");
  });

  it("renders plain history when no live runs exist", () => {
    const { lastFrame } = render(
      <WorkflowHistory
        runs={[recorded("r1")]}
        liveRuns={[]}
        selectedIndex={0}
        loading={false}
        width={120}
        height={12}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("active ·");
    expect(frame).toContain("tour");
  });
});
