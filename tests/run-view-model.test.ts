import { describe, expect, it } from "vitest";
import {
  type RunProgress,
  pickFollowIndex,
  planViewLayout,
  progressBarSegments,
  runStatus,
  summarizeRun,
} from "../src/tui/run-view-model";
import type { StepState, WorkflowState } from "../src/tui/workflow-state";

function step(status: StepState["status"], cached = false): { step: StepState } {
  return {
    step: {
      stepId: `s-${status}-${Math.random().toString(36).slice(2, 6)}`,
      blockKind: "worker",
      status,
      text: "",
      cached,
    },
  };
}

function progressOf(over: Partial<RunProgress>): RunProgress {
  return { total: 0, doneOk: 0, failed: 0, running: 0, pending: 0, cached: 0, ...over };
}

describe("summarizeRun", () => {
  it("tallies each status and cached steps", () => {
    const flat = [
      step("done"),
      step("done", true),
      step("error"),
      step("running"),
      step("pending"),
      step("pending"),
    ];
    expect(summarizeRun(flat)).toEqual({
      total: 6,
      doneOk: 2,
      failed: 1,
      running: 1,
      pending: 2,
      cached: 1,
    });
  });
});

describe("progressBarSegments", () => {
  it("allocates exactly the requested width", () => {
    const segments = progressBarSegments(
      progressOf({ total: 7, doneOk: 4, failed: 1, running: 1, pending: 1 }),
      24,
    );
    const cells = segments.reduce((n, segment) => n + segment.cells, 0);
    expect(cells).toBe(24);
  });

  it("never rounds a non-empty category away", () => {
    // 1 failure among 100 steps must stay visible in a 10-cell bar.
    const segments = progressBarSegments(progressOf({ total: 100, doneOk: 99, failed: 1 }), 10);
    expect(segments.find((segment) => segment.kind === "failed")?.cells).toBe(1);
    expect(segments.reduce((n, segment) => n + segment.cells, 0)).toBe(10);
  });

  it("renders an all-pending bar for an empty run", () => {
    expect(progressBarSegments(progressOf({}), 12)).toEqual([{ kind: "pending", cells: 12 }]);
  });

  it("returns nothing for a zero-width bar", () => {
    expect(progressBarSegments(progressOf({ total: 3, doneOk: 3 }), 0)).toEqual([]);
  });
});

describe("planViewLayout", () => {
  it("gives the tree the remaining height after fixed sections", () => {
    const layout = planViewLayout({
      height: 30,
      fixedLines: 3,
      cardLines: 0,
      detailFixedLines: 2,
      desiredPreviewLines: 6,
    });
    // 30 - 2 border - 3 fixed - 2 detail = 23 available; 6 preview → 17 rows.
    expect(layout.previewLines).toBe(6);
    expect(layout.listBudget).toBe(17);
    expect(layout.cramped).toBe(false);
  });

  it("shrinks the detail preview before the tree", () => {
    const layout = planViewLayout({
      height: 14,
      fixedLines: 2,
      cardLines: 6,
      detailFixedLines: 2,
      desiredPreviewLines: 6,
    });
    // 14 - 2 - 2 - 6 - 2 = 2 available: preview collapses, tree keeps them.
    expect(layout.previewLines).toBe(0);
    expect(layout.listBudget).toBe(2);
  });

  it("never reports a zero-row tree, even when cramped", () => {
    const layout = planViewLayout({
      height: 8,
      fixedLines: 4,
      cardLines: 4,
      detailFixedLines: 2,
      desiredPreviewLines: 6,
    });
    expect(layout.listBudget).toBeGreaterThanOrEqual(1);
    expect(layout.cramped).toBe(true);
  });
});

describe("pickFollowIndex", () => {
  it("targets the first running step", () => {
    const flat = [step("done"), step("running"), step("running"), step("pending")];
    expect(pickFollowIndex(flat, 0)).toBe(1);
  });

  it("falls back to the newest non-pending step when nothing runs", () => {
    const flat = [step("done"), step("error"), step("pending")];
    expect(pickFollowIndex(flat, 0)).toBe(1);
  });

  it("keeps the current selection when every step is pending", () => {
    const flat = [step("pending"), step("pending")];
    expect(pickFollowIndex(flat, 1)).toBe(1);
  });
});

describe("runStatus", () => {
  const base: WorkflowState = {
    phases: [],
    results: [],
    started: true,
    done: false,
    ok: true,
  };

  it("ranks terminal and attention states above running", () => {
    expect(runStatus({ ...base, done: true, ok: true }, 0)).toEqual({
      word: "done",
      color: "green",
    });
    expect(runStatus({ ...base, done: true, ok: false }, 0)).toEqual({
      word: "failed",
      color: "red",
    });
    expect(
      runStatus(
        {
          ...base,
          budget: { scope: "workflow", limitUsd: 1, spentUsd: 2 },
        },
        0,
      ).word,
    ).toBe("budget-exceeded");
    expect(
      runStatus(
        {
          ...base,
          pendingInputs: [
            {
              phaseId: "p",
              stepId: "s",
              iteration: 1,
              attempt: 1,
              prompt: "?",
              origin: "human-step",
            },
          ],
        },
        0,
      ),
    ).toEqual({ word: "waiting on you", color: "yellow" });
  });

  it("distinguishes pausing (in-flight steps draining) from paused", () => {
    expect(runStatus({ ...base, paused: true }, 2).word).toBe("pausing");
    expect(runStatus({ ...base, paused: true }, 0).word).toBe("paused");
    expect(runStatus(base, 1)).toEqual({ word: "running", color: "cyan" });
  });
});
