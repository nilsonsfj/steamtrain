import { describe, expect, it, vi } from "vitest";
import {
  type PullRequestCheckSnapshot,
  evaluatePullRequestChecks,
  mergePullRequestWhenReady,
  normalizeCheckState,
  parsePullRequestRef,
  parseStatusCheckRollup,
  resolveSteamtrainCliInvocation,
  waitForPullRequestChecks,
} from "../src/workflow/github-checks";

function snap(
  over: Partial<PullRequestCheckSnapshot> & Pick<PullRequestCheckSnapshot, "checks">,
): PullRequestCheckSnapshot {
  return {
    number: 42,
    state: "open",
    headRefName: "claude/hopeful-shannon-1mrboz",
    headCommittedAt: new Date(1_000_000).toISOString(),
    ...over,
  };
}

describe("normalizeCheckState", () => {
  it("trims, uppercases, and maps hyphens to underscores", () => {
    expect(normalizeCheckState(" in-progress ")).toBe("IN_PROGRESS");
    expect(normalizeCheckState("timed_out")).toBe("TIMED_OUT");
    expect(normalizeCheckState("success")).toBe("SUCCESS");
  });

  it("maps unknown / empty values to UNKNOWN", () => {
    expect(normalizeCheckState(undefined)).toBe("UNKNOWN");
    expect(normalizeCheckState("")).toBe("UNKNOWN");
    expect(normalizeCheckState("not-a-real-state")).toBe("UNKNOWN");
  });
});

describe("parsePullRequestRef", () => {
  it("accepts numbers, URLs, and number\\nbranch fixture lines", () => {
    expect(parsePullRequestRef("417")).toBe("417");
    expect(parsePullRequestRef("#99")).toBe("99");
    expect(parsePullRequestRef("https://github.com/acme/r/pull/7")).toBe("7");
    expect(parsePullRequestRef("417\nclaude/hopeful-shannon-lx8lxp")).toBe("417");
    expect(parsePullRequestRef("feature/foo")).toBe("feature/foo");
  });
});

describe("parseStatusCheckRollup", () => {
  it("normalizes check-run and status-context shapes", () => {
    const entries = parseStatusCheckRollup([
      { name: "build", status: "IN_PROGRESS" },
      { name: "tests", conclusion: "SUCCESS", status: "COMPLETED" },
      { context: "codecov", state: "pending" },
      { name: "remote-review", conclusion: null, status: "QUEUED" },
    ]);
    expect(entries.map((e) => [e.name, e.state])).toEqual([
      ["build", "IN_PROGRESS"],
      ["tests", "SUCCESS"],
      ["codecov", "PENDING"],
      ["remote-review", "QUEUED"],
    ]);
  });

  it("normalizes nested checkSuite status and ignores non-object suites", () => {
    const entries = parseStatusCheckRollup([
      { name: "suite-check", checkSuite: { status: "IN_PROGRESS" } },
      { name: "bad-suite", checkSuite: "not-an-object", conclusion: "SUCCESS" },
    ]);
    expect(entries.map((e) => [e.name, e.state])).toEqual([
      ["suite-check", "IN_PROGRESS"],
      ["bad-suite", "SUCCESS"],
    ]);
  });
});

describe("evaluatePullRequestChecks", () => {
  it("treats an empty rollup right after a push as not ready", () => {
    const evaluation = evaluatePullRequestChecks(
      snap({ checks: [], headCommittedAt: new Date(1_000_000).toISOString() }),
      { nowMs: 1_000_000 + 5_000, emptyGraceMs: 90_000 },
    );
    expect(evaluation).toMatchObject({ ready: false, reason: "awaiting_registration" });
  });

  it("treats an empty rollup after the grace window as ready", () => {
    const evaluation = evaluatePullRequestChecks(
      snap({ checks: [], headCommittedAt: new Date(1_000_000).toISOString() }),
      { nowMs: 1_000_000 + 120_000, emptyGraceMs: 90_000 },
    );
    expect(evaluation).toMatchObject({ ready: true, ok: true });
  });

  it("stays pending while any check (including non-required) is in flight", () => {
    const evaluation = evaluatePullRequestChecks(
      snap({
        checks: [
          { name: "ci", state: "SUCCESS" },
          { name: "external-review", state: "QUEUED" },
        ],
      }),
    );
    expect(evaluation).toMatchObject({ ready: false, reason: "pending" });
    expect(evaluation.detail).toContain("external-review");
  });

  it("is green only when every check is success-like", () => {
    const evaluation = evaluatePullRequestChecks(
      snap({
        checks: [
          { name: "ci", state: "SUCCESS" },
          { name: "external-review", state: "NEUTRAL" },
          { name: "lint", state: "SKIPPED" },
        ],
      }),
    );
    expect(evaluation).toMatchObject({ ready: true, ok: true });
  });

  it("fails closed on red checks without waiting further", () => {
    const evaluation = evaluatePullRequestChecks(
      snap({
        checks: [
          { name: "ci", state: "SUCCESS" },
          { name: "external-review", state: "FAILURE" },
        ],
      }),
    );
    expect(evaluation).toMatchObject({ ready: true, ok: false });
    if (evaluation.ready && !evaluation.ok) {
      expect(evaluation.failed.map((f) => f.name)).toEqual(["external-review"]);
    }
  });

  it("reports already-merged PRs as ready", () => {
    expect(evaluatePullRequestChecks(snap({ state: "merged", checks: [] }))).toMatchObject({
      ready: true,
      ok: true,
    });
  });
});

describe("waitForPullRequestChecks", () => {
  it("polls until pending checks become green", async () => {
    const snapshots: PullRequestCheckSnapshot[] = [
      snap({
        checks: [
          { name: "ci", state: "SUCCESS" },
          { name: "review-bot", state: "QUEUED" },
        ],
      }),
      snap({
        checks: [
          { name: "ci", state: "SUCCESS" },
          { name: "review-bot", state: "SUCCESS" },
        ],
      }),
    ];
    const fetchSnapshot = vi.fn(async () => snapshots.shift()!);
    const sleep = vi.fn(async () => {});
    const result = await waitForPullRequestChecks({
      cwd: "/tmp",
      prRef: "42",
      pollIntervalMs: 1,
      timeoutMs: 5_000,
      fetchSnapshot,
      sleep,
      nowMs: () => 1_000_000 + 200_000,
    });
    expect(result.ok).toBe(true);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("does not declare victory on an empty rollup inside the grace window", async () => {
    let now = 1_000_000;
    const fetchSnapshot = vi.fn(async () =>
      snap({
        checks: [],
        headCommittedAt: new Date(1_000_000).toISOString(),
      }),
    );
    const sleep = vi.fn(async () => {
      now += 50_000;
    });
    // First poll: empty + inside grace → keep waiting.
    // Second poll: still empty but past grace → ready.
    const result = await waitForPullRequestChecks({
      cwd: "/tmp",
      prRef: "42",
      pollIntervalMs: 1,
      timeoutMs: 200_000,
      emptyGraceMs: 90_000,
      fetchSnapshot,
      sleep,
      nowMs: () => now,
    });
    expect(result.ok).toBe(true);
    expect(fetchSnapshot.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("mergePullRequestWhenReady", () => {
  it("refuses to merge while checks are still pending", async () => {
    let now = 1_000_000 + 200_000;
    const result = await mergePullRequestWhenReady({
      cwd: "/tmp",
      prRef: "42",
      timeoutMs: 1_000,
      pollIntervalMs: 1,
      fetchSnapshot: async () =>
        snap({
          checks: [{ name: "review-bot", state: "IN_PROGRESS" }],
        }),
      sleep: async () => {
        now += 2_000;
      },
      nowMs: () => now,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/timed out|still running|review-bot/i);
  });
});

describe("resolveSteamtrainCliInvocation", () => {
  it("rebuilds a bun/node entrypoint invocation for command steps", () => {
    expect(resolveSteamtrainCliInvocation(["bun", "/repo/src/index.tsx"], "/usr/bin/bun")).toBe(
      "/usr/bin/bun /repo/src/index.tsx",
    );
    expect(
      resolveSteamtrainCliInvocation(["node", "/usr/local/bin/steamtrain"], "/usr/bin/node"),
    ).toBe("/usr/local/bin/steamtrain");
  });
});
