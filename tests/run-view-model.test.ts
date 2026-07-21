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
  return {
    total: 0,
    doneOk: 0,
    failed: 0,
    running: 0,
    waiting: 0,
    pending: 0,
    cached: 0,
    ...over,
  };
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
      waiting: 0,
      pending: 2,
      cached: 1,
    });
  });
  it("tallies user-blocked steps as waiting rather than running", () => {
    const approval = step("running");
    approval.step.approval = { pending: true };
    const input = step("running");
    input.step.humanInput = { pending: true };

    expect(summarizeRun([approval, input, step("running")])).toEqual({
      total: 3,
      doneOk: 0,
      failed: 0,
      running: 1,
      waiting: 2,
      pending: 0,
      cached: 0,
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

  it("gives the largest categories the cells when the bar is narrower than the category count", () => {
    const segments = progressBarSegments(
      progressOf({ total: 10, doneOk: 5, failed: 1, running: 3, pending: 1 }),
      2,
    );
    expect(segments).toEqual([
      { kind: "done", cells: 1 },
      { kind: "running", cells: 1 },
    ]);
  });

  it("keeps every non-empty category visible across widths and distributions", () => {
    for (let width = 5; width <= 30; width += 1) {
      for (const p of [
        progressOf({ total: 100, doneOk: 96, failed: 1, running: 1, waiting: 1, pending: 1 }),
        progressOf({ total: 50, doneOk: 1, failed: 1, running: 1, waiting: 1, pending: 46 }),
        progressOf({ total: 10, doneOk: 2, failed: 2, running: 2, waiting: 2, pending: 2 }),
      ]) {
        const segments = progressBarSegments(p, width);
        expect(segments.reduce((n, segment) => n + segment.cells, 0)).toBe(width);
        for (const kind of ["done", "failed", "running", "waiting", "pending"] as const) {
          const count =
            kind === "done"
              ? p.doneOk
              : kind === "failed"
                ? p.failed
                : kind === "running"
                  ? p.running
                  : kind === "waiting"
                    ? p.waiting
                    : p.pending;
          if (count > 0) {
            expect(segments.find((segment) => segment.kind === kind)?.cells).toBeGreaterThan(0);
          }
        }
      }
    }
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
    // 30 - 2 border → inner 28; available 23 after fixed/detail.
    // Tree caps at floor(28 * 0.55) = 15; leftover returns to preview.
    expect(layout.listBudget).toBe(15);
    expect(layout.previewLines).toBe(8);
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
  it("allows the final compact fallback to yield the tree entirely", () => {
    const layout = planViewLayout({
      height: 6,
      fixedLines: 4,
      minimumListLines: 0,
      cardLines: 0,
      detailFixedLines: 0,
      desiredPreviewLines: 0,
    });
    expect(layout).toEqual({ listBudget: 0, previewLines: 0, cramped: false });
  });

  it("caps the tree on tall terminals so the detail panel keeps a usable share", () => {
    const layout = planViewLayout({
      height: 40,
      fixedLines: 2,
      cardLines: 0,
      detailFixedLines: 1,
      desiredPreviewLines: 1,
    });
    // Without a cap the tree would take ~35 rows; with the 55% cap it stays
    // bounded and surplus height returns to the detail preview.
    expect(layout.listBudget).toBeLessThanOrEqual(Math.floor(38 * 0.55));
    expect(layout.previewLines).toBeGreaterThan(1);
    expect(layout.listBudget + layout.previewLines).toBe(40 - 2 - 2 - 1);
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
  it("prefers active work over a user-blocked running step", () => {
    const waiting = step("running");
    waiting.step.approval = { pending: true };
    expect(pickFollowIndex([waiting, step("running")], 0)).toBe(1);
  });

  it("targets a user-blocked step when no active work is running", () => {
    const waiting = step("running");
    waiting.step.humanInput = { pending: true };
    expect(pickFollowIndex([step("done"), waiting, step("pending")], 0)).toBe(1);
  });

  it("returns the fallback for an empty list", () => {
    expect(pickFollowIndex([], 5)).toBe(5);
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
