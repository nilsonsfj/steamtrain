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

  it("ignores CANCELLED checks from superseded workflow runs", () => {
    const evaluation = evaluatePullRequestChecks(
      snap({
        checks: [
          { name: "ci", state: "SUCCESS" },
          { name: "ci", state: "CANCELLED" },
          { name: "lint", state: "CANCELLED" },
        ],
      }),
    );
    expect(evaluation).toMatchObject({ ready: true, ok: true });
  });

  it("reports already-merged PRs as ready", () => {
    expect(evaluatePullRequestChecks(snap({ state: "merged", checks: [] }))).toMatchObject({
      ready: true,
      ok: true,
    });
  });

  it("refuses an empty-check PR that is still CONFLICTING after the grace window", () => {
    // Regression: babysit land treated "no checks after grace" as ready and
    // then `gh pr merge` failed with "not mergeable". Conflicts must fail
    // closed before we attempt to land.
    const evaluation = evaluatePullRequestChecks(
      snap({
        checks: [],
        mergeable: "CONFLICTING",
        headCommittedAt: new Date(1_000_000).toISOString(),
      }),
      { nowMs: 1_000_000 + 120_000, emptyGraceMs: 90_000 },
    );
    expect(evaluation).toMatchObject({ ready: true, ok: false });
    expect(evaluation.detail).toMatch(/conflict/i);
  });

  it("stays pending while mergeable is UNKNOWN even when checks are green", () => {
    const evaluation = evaluatePullRequestChecks(
      snap({
        checks: [{ name: "ci", state: "SUCCESS" }],
        mergeable: "UNKNOWN",
      }),
    );
    expect(evaluation).toMatchObject({ ready: false, reason: "pending" });
    expect(evaluation.detail).toMatch(/UNKNOWN/i);
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

describe("mergePullRequestWhenReady — race-resilient landing", () => {
  const green = (over: Partial<PullRequestCheckSnapshot> = {}): PullRequestCheckSnapshot =>
    snap({
      checks: [{ name: "ci", state: "SUCCESS" }],
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      ...over,
    });

  /** Return recorded snapshots in order, repeating the last once exhausted. */
  function sequence(snaps: PullRequestCheckSnapshot[]): () => Promise<PullRequestCheckSnapshot> {
    let i = 0;
    return async () => snaps[Math.min(i++, snaps.length - 1)]!;
  }

  /** A pass-through lock: always "held", so we exercise the land loop directly. */
  const passThroughLock = async <T>(
    _cwd: string,
    fn: (locked: boolean) => Promise<T>,
  ): Promise<{ value: T; locked: boolean }> => ({ value: await fn(true), locked: true });

  const base = {
    cwd: "/repo",
    prRef: "42",
    timeoutMs: 1_000_000,
    pollIntervalMs: 1,
    nowMs: () => 5_000_000, // constant clock: grace long past, deadline never hit
    sleep: async () => {},
    landLock: passThroughLock,
  };

  it("lands a green, up-to-date PR in one merge and reports it serialized", async () => {
    const calls: string[][] = [];
    const result = await mergePullRequestWhenReady({
      ...base,
      fetchSnapshot: sequence([green(), green()]),
      runGh: async (args) => {
        calls.push(args);
        return "";
      },
    });
    expect(result).toMatchObject({ ok: true, merged: true, serialized: true });
    expect(calls).toEqual([["pr", "merge", "42", "--squash", "--delete-branch"]]);
  });

  it("retries the merge when the base branch was modified out from under it", async () => {
    let attempt = 0;
    const merges: string[][] = [];
    const result = await mergePullRequestWhenReady({
      ...base,
      fetchSnapshot: sequence([green()]),
      runGh: async (args) => {
        if (args[1] === "merge") {
          merges.push(args);
          attempt += 1;
          if (attempt === 1) {
            throw new Error(
              "gh pr merge failed: Base branch was modified. Review and try the merge again.",
            );
          }
        }
        return "";
      },
    });
    expect(result.ok).toBe(true);
    expect(merges).toHaveLength(2); // one failed, one succeeded
  });

  it("fails with an actionable message (no merge attempt) when the base advanced into a conflict", async () => {
    const calls: string[][] = [];
    const result = await mergePullRequestWhenReady({
      ...base,
      // firstWait sees green; under the lock the PR has flipped CONFLICTING.
      fetchSnapshot: sequence([green(), green({ mergeable: "CONFLICTING" })]),
      runGh: async (args) => {
        calls.push(args);
        return "";
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/conflicts with the base branch.*advanced/i);
    expect(calls.some((c) => c[1] === "merge")).toBe(false);
  });

  it("updates a behind branch, waits for the fresh checks, then merges", async () => {
    const calls: string[][] = [];
    const result = await mergePullRequestWhenReady({
      ...base,
      fetchSnapshot: sequence([
        green({ mergeStateStatus: "BEHIND" }), // firstWait
        green({ mergeStateStatus: "BEHIND" }), // land loop: needs update
        green(), // re-wait after update-branch
        green(), // land loop: now CLEAN → merge
      ]),
      runGh: async (args) => {
        calls.push([args[0]!, args[1]!]);
        return "";
      },
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      ["pr", "update-branch"],
      ["pr", "merge"],
    ]);
  });

  it("gives up with a 'did not converge' error once maxMergeAttempts is exhausted", async () => {
    let merges = 0;
    const result = await mergePullRequestWhenReady({
      ...base,
      maxMergeAttempts: 2,
      fetchSnapshot: sequence([green()]),
      runGh: async (args) => {
        if (args[1] === "merge") {
          merges += 1;
          throw new Error("Base branch was modified. Review and try the merge again.");
        }
        return "";
      },
    });
    expect(result.ok).toBe(false);
    // The LAST attempt reports the underlying merge failure rather than
    // silently looping — either surfacing is acceptable, but it must name the
    // transient cause so the babysit summary is actionable.
    if (!result.ok) expect(result.error).toMatch(/base branch was modified|did not converge/i);
    expect(merges).toBe(2);
  });

  it("fails with an actionable message when a behind branch cannot be auto-updated", async () => {
    const result = await mergePullRequestWhenReady({
      ...base,
      fetchSnapshot: sequence([
        green({ mergeStateStatus: "BEHIND" }),
        green({ mergeStateStatus: "BEHIND" }),
      ]),
      runGh: async (args) => {
        if (args[1] === "update-branch") {
          throw new Error("failed to update branch: merge conflict between base and head");
        }
        return "";
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatch(/behind.*cannot be auto-updated|manual resolution/i);
  });

  it("still lands (serialized: false) when the land lock could not be acquired", async () => {
    const result = await mergePullRequestWhenReady({
      ...base,
      // Best-effort lock that never acquires — the land must still happen.
      landLock: async (_cwd, fn) => ({ value: await fn(false), locked: false }),
      fetchSnapshot: sequence([green(), green()]),
      runGh: async () => "",
    });
    expect(result).toMatchObject({ ok: true, merged: true, serialized: false });
  });

  it("reports an already-merged PR when a sibling landed it first", async () => {
    const calls: string[][] = [];
    const result = await mergePullRequestWhenReady({
      ...base,
      fetchSnapshot: sequence([green(), green({ state: "merged" })]),
      runGh: async (args) => {
        calls.push(args);
        return "";
      },
    });
    expect(result).toMatchObject({ ok: true, alreadyMerged: true, merged: false });
    expect(calls.some((c) => c[1] === "merge")).toBe(false);
  });

  it("does not retry a hard rejection (e.g. review required) and surfaces it", async () => {
    let merges = 0;
    const result = await mergePullRequestWhenReady({
      ...base,
      fetchSnapshot: sequence([green()]),
      runGh: async (args) => {
        if (args[1] === "merge") {
          merges += 1;
          throw new Error(
            "gh pr merge failed: At least 1 approving review is required by reviewers.",
          );
        }
        return "";
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/review is required/i);
    expect(merges).toBe(1);
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
