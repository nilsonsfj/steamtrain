import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { HistoryDetailBanner, WorkflowHistory } from "../src/tui/WorkflowHistory";
import type { LiveRunMeta, RunRecord, RunRecordSummary } from "../src/workflow";
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

function recorded(id: string, overrides: Partial<RunRecordSummary> = {}): RunRecordSummary {
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
    ...overrides,
  };
}

const baseProps = {
  selectedIndex: 0,
  loading: false,
  query: "",
  filtering: false,
  statusFilter: "all" as const,
  width: 120,
  height: 20,
};

describe("WorkflowHistory live-run section", () => {
  it("lists in-flight runs above recorded history with section headers", () => {
    const { lastFrame } = render(
      <WorkflowHistory
        {...baseProps}
        runs={[recorded("r1")]}
        liveRuns={[liveRun("live-1"), liveRun("live-2", { status: "queued", pid: process.pid })]}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("2 active");
    expect(frame).toContain("1 recorded");
    expect(frame).toContain("on the rails");
    expect(frame).toContain("arrived");
    expect(frame).toContain("bug-hunt");
    expect(frame).toContain("detached");
    expect(frame).toContain("queued");
    expect(frame).toContain("Enter attaches");
    expect(frame).toContain("tour");
  });

  it("shows a pending-approval badge on live runs", () => {
    const { lastFrame } = render(
      <WorkflowHistory
        {...baseProps}
        height={12}
        runs={[]}
        liveRuns={[liveRun("live-1", { pendingApprovals: [{ stepId: "gate", iteration: 1 }] })]}
      />,
    );
    expect(lastFrame()).toContain("approval: gate");
  });

  it("filters by query and shows an empty-match state", () => {
    const { lastFrame } = render(
      <WorkflowHistory
        {...baseProps}
        runs={[recorded("r1"), recorded("r2", { workflow: "debug", status: "error", ok: false })]}
        liveRuns={[liveRun("live-1")]}
        query="nope-nothing"
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("No runs match this filter");
    expect(frame).toContain("nope-nothing");
  });

  it("shows the filter cursor when filtering is active", () => {
    const { lastFrame } = render(
      <WorkflowHistory
        {...baseProps}
        runs={[recorded("r1")]}
        liveRuns={[]}
        query="tour"
        filtering
      />,
    );
    expect(lastFrame()).toContain("filter ›");
    expect(lastFrame()).toContain("tour");
  });
});

describe("HistoryDetailBanner", () => {
  function fullRecord(overrides: Partial<RunRecord> = {}): RunRecord {
    return {
      ...recorded("banner-1"),
      phases: [],
      ...overrides,
    };
  }

  it("renders status, relative time, totals, and input for a done run", () => {
    const { lastFrame } = render(<HistoryDetailBanner record={fullRecord()} width={100} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("tour");
    expect(frame).toContain("done");
    expect(frame).toContain("all aboard");
    expect(frame).toContain("re-run");
  });

  it("renders failed status and retry hint when steps failed", () => {
    const { lastFrame } = render(
      <HistoryDetailBanner
        width={100}
        record={fullRecord({
          status: "error",
          ok: false,
          workflow: "debug",
          input: "find the bug",
          totals: {
            steps: 3,
            ok: 2,
            failed: 1,
            cached: 0,
            costUsd: 0.1,
            tokens: emptyTokens(),
            durationMs: 10_000,
          },
        })}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("debug");
    expect(frame).toContain("failed");
    expect(frame).toContain("retry failed");
    expect(frame).toContain("find the bug");
  });
});
