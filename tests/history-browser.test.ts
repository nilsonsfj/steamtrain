import { describe, expect, it } from "vitest";
import type { LiveRunMeta, RunRecordSummary } from "../src/workflow";
import { emptyTokens, newLiveRunMeta } from "../src/workflow";
import {
  buildHistoryBrowserEntries,
  formatRelativeTime,
  historyStatusLabel,
  matchesHistoryQuery,
  nextHistoryStatusFilter,
  normalizeHistoryRunId,
} from "../src/workflow/history-browser";

function live(id: string, overrides: Partial<LiveRunMeta> = {}): LiveRunMeta {
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
      costUsd: 0.12,
      tokens: emptyTokens(),
      durationMs: 10_000,
    },
    ...overrides,
  };
}

describe("normalizeHistoryRunId", () => {
  it("accepts only non-empty strings (never DOM events or other truthy junk)", () => {
    expect(normalizeHistoryRunId("abc-123")).toBe("abc-123");
    expect(normalizeHistoryRunId("")).toBeUndefined();
    expect(normalizeHistoryRunId(undefined)).toBeUndefined();
    expect(normalizeHistoryRunId(null)).toBeUndefined();
    expect(normalizeHistoryRunId({ type: "click" })).toBeUndefined();
    expect(normalizeHistoryRunId(true)).toBeUndefined();
    expect(normalizeHistoryRunId(1)).toBeUndefined();
  });
});

describe("matchesHistoryQuery", () => {
  it("matches across workflow, input, id, and status", () => {
    expect(matchesHistoryQuery("tour", { workflow: "Tour", input: "x" })).toBe(true);
    expect(matchesHistoryQuery("aboard", { workflow: "tour", input: "all aboard" })).toBe(true);
    expect(matchesHistoryQuery("abc", { id: "run-abc-9" })).toBe(true);
    expect(matchesHistoryQuery("fail", { status: "failed" })).toBe(true);
    expect(matchesHistoryQuery("zzz", { workflow: "tour", input: "hi" })).toBe(false);
    expect(matchesHistoryQuery("  ", { workflow: "tour" })).toBe(true);
  });
});

describe("buildHistoryBrowserEntries", () => {
  it("lists live runs above recorded runs", () => {
    const entries = buildHistoryBrowserEntries({
      runs: [recorded("r1")],
      liveRuns: [live("l1")],
    });
    expect(entries.map((e) => e.id)).toEqual(["l1", "r1"]);
    expect(entries[0]?.kind).toBe("live");
    expect(entries[1]?.kind).toBe("record");
  });

  it("filters by query and status chip", () => {
    const runs = [
      recorded("ok", { status: "done", ok: true }),
      recorded("bad", { status: "error", ok: false, workflow: "debug", input: "boom" }),
    ];
    const liveRuns = [live("live-1")];

    expect(
      buildHistoryBrowserEntries({ runs, liveRuns, statusFilter: "error" }).map((e) => e.id),
    ).toEqual(["bad"]);
    expect(
      buildHistoryBrowserEntries({ runs, liveRuns, statusFilter: "live" }).map((e) => e.id),
    ).toEqual(["live-1"]);
    expect(buildHistoryBrowserEntries({ runs, liveRuns, query: "boom" }).map((e) => e.id)).toEqual([
      "bad",
    ]);
    expect(
      buildHistoryBrowserEntries({ runs, liveRuns, query: "bug-hunt" }).map((e) => e.id),
    ).toEqual(["live-1"]);
  });
});

describe("nextHistoryStatusFilter / labels / relative time", () => {
  it("cycles the filter chip and labels statuses", () => {
    expect(nextHistoryStatusFilter("all")).toBe("live");
    expect(nextHistoryStatusFilter("budget-exceeded")).toBe("all");
    expect(historyStatusLabel("error")).toBe("failed");
    expect(historyStatusLabel("budget-exceeded")).toBe("budget");
    expect(historyStatusLabel("")).toBe("");
  });

  it("formats relative timestamps", () => {
    const now = 1_700_000_000_000;
    expect(formatRelativeTime(now - 12_000, now)).toBe("12s ago");
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatRelativeTime(now - 3 * 86_400_000, now)).toBe("3d ago");
    expect(formatRelativeTime(0, now)).toBe("unknown");
    expect(formatRelativeTime(Number.NaN, now)).toBe("unknown");
  });

  it("handles empty inputs and live-only filters", () => {
    expect(buildHistoryBrowserEntries({ runs: [], liveRuns: [] })).toEqual([]);
    expect(
      buildHistoryBrowserEntries({
        runs: [recorded("ok")],
        liveRuns: [],
        statusFilter: "live",
      }),
    ).toEqual([]);
    expect(matchesHistoryQuery(".", { workflow: "tour", input: "hi" })).toBe(false);
    expect(matchesHistoryQuery(".", { workflow: "a.b" })).toBe(true);
  });

  it("cycles every status filter chip", () => {
    let current: "all" | "live" | "done" | "error" | "canceled" | "budget-exceeded" = "all";
    const seen = new Set<string>();
    for (let i = 0; i < 6; i += 1) {
      seen.add(current);
      current = nextHistoryStatusFilter(current);
    }
    expect([...seen].sort()).toEqual(
      ["all", "budget-exceeded", "canceled", "done", "error", "live"].sort(),
    );
    expect(current).toBe("all");
  });
});
