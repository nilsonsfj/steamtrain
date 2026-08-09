import { type Mock, describe, expect, it, vi } from "vitest";
import {
  type PullRequestCheckSnapshot,
  buildMergeArgs,
  evaluatePullRequestChecks,
  isBranchCheckedOut,
  mergePullRequestWhenReady,
  normalizeCheckState,
  parsePullRequestRef,
  parseRepoFromPullUrl,
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
    baseRepo: "github.com/acme/steamtrain",
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

  it("falls back past an EMPTY conclusion to the live status", () => {
    // `gh pr view` emits conclusion:"" for a run still in flight. Coalescing on
    // presence rather than emptiness rendered those as UNKNOWN, so the babysit
    // waiter logged 'review (UNKNOWN)' for minutes on end.
    const entries = parseStatusCheckRollup([
      { name: "review", conclusion: "", status: "IN_PROGRESS", workflowName: "opencode-review" },
      { name: "lint", conclusion: "   ", state: "", checkSuite: { status: "QUEUED" } },
    ]);
    expect(entries.map((e) => [e.name, e.state])).toEqual([
      ["review", "IN_PROGRESS"],
      ["lint", "QUEUED"],
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

describe("parseRepoFromPullUrl", () => {
  it("pulls owner/repo out of PR URLs, including enterprise hosts", () => {
    expect(parseRepoFromPullUrl("https://github.com/nilsonsfj/steamtrain/pull/145")).toBe(
      "github.com/nilsonsfj/steamtrain",
    );
    // The host must survive: `gh --repo` defaults to github.com without it, so
    // a GitHub Enterprise land would silently target the wrong host.
    expect(parseRepoFromPullUrl("https://git.corp.example.com/org/repo/pull/7/files")).toBe(
      "git.corp.example.com/org/repo",
    );
  });

  it("returns undefined for anything that is not a PR URL", () => {
    expect(parseRepoFromPullUrl(undefined)).toBeUndefined();
    expect(parseRepoFromPullUrl("")).toBeUndefined();
    expect(parseRepoFromPullUrl("https://github.com/owner/repo")).toBeUndefined();
    expect(parseRepoFromPullUrl("https://github.com/owner/repo/issues/7")).toBeUndefined();
    expect(parseRepoFromPullUrl(42)).toBeUndefined();
  });
});

describe("buildMergeArgs", () => {
  const pr = (over: Partial<PullRequestCheckSnapshot> = {}): PullRequestCheckSnapshot =>
    snap({ checks: [], ...over });

  it("passes --repo so gh skips its local-branch deletion", () => {
    // The whole fix in one assertion: gh sets
    // `CanDeleteLocalBranch = !cmd.Flags().Changed("repo")`, so --repo is what
    // keeps `--delete-branch` from touching (and choking on) a worktree-held
    // local branch. Dropping --repo silently reintroduces the original bug.
    expect(buildMergeArgs(pr(), "squash", true)).toEqual({
      args: [
        "pr",
        "merge",
        "42",
        "--squash",
        "--repo",
        "github.com/acme/steamtrain",
        "--delete-branch",
      ],
      warnings: [],
    });
  });

  it("honors the merge strategy", () => {
    expect(buildMergeArgs(pr(), "rebase", true).args).toContain("--rebase");
    expect(buildMergeArgs(pr(), "merge", true).args).toContain("--merge");
  });

  it("omits --repo and --delete-branch when the branch is being kept", () => {
    expect(buildMergeArgs(pr(), "squash", false)).toEqual({
      args: ["pr", "merge", "42", "--squash"],
      warnings: [],
    });
  });

  it("skips cleanup with a warning rather than risking a bare --delete-branch", () => {
    const built = buildMergeArgs(pr({ baseRepo: undefined }), "squash", true);
    expect(built.args).toEqual(["pr", "merge", "42", "--squash"]);
    expect(built.args).not.toContain("--delete-branch");
    expect(built.warnings[0]).toMatch(/left the head branch of PR #42 in place/i);
  });
});

describe("isBranchCheckedOut", () => {
  const porcelain = [
    "worktree /repo",
    "HEAD 0a80df2",
    "branch refs/heads/main",
    "",
    "worktree /tmp/steamtrain-worktrees/prepare-1",
    "HEAD f7a3e50",
    "branch refs/heads/nilsonsfj/exciting-hamilton-ozxx5r",
    "",
    "worktree /tmp/steamtrain-worktrees/detached-1",
    "HEAD abc1234",
    "detached",
    "",
  ].join("\n");

  it("matches only a full ref, not a prefix or substring", () => {
    expect(isBranchCheckedOut(porcelain, "nilsonsfj/exciting-hamilton-ozxx5r")).toBe(true);
    expect(isBranchCheckedOut(porcelain, "main")).toBe(true);
    expect(isBranchCheckedOut(porcelain, "nilsonsfj/exciting-hamilton")).toBe(false);
    expect(isBranchCheckedOut(porcelain, "ain")).toBe(false);
    expect(isBranchCheckedOut("", "main")).toBe(false);
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

  /**
   * Return recorded snapshots in order, repeating the last once exhausted.
   * A `vi.fn` so tests can pin the exact number of fetches — otherwise an
   * extra, unintended re-fetch would silently re-evaluate stale data and the
   * test would still pass.
   */
  function sequence(
    snaps: PullRequestCheckSnapshot[],
  ): Mock<() => Promise<PullRequestCheckSnapshot>> {
    let i = 0;
    return vi.fn(async () => snaps[Math.min(i++, snaps.length - 1)]!);
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
    // No worktree holds the head branch unless a test says so.
    runGit: async () => "",
  };

  it("lands a green, up-to-date PR in one merge and reports it serialized", async () => {
    const calls: string[][] = [];
    const fetchSnapshot = sequence([green(), green()]);
    const result = await mergePullRequestWhenReady({
      ...base,
      fetchSnapshot,
      runGh: async (args) => {
        calls.push(args);
        return "";
      },
    });
    expect(result).toMatchObject({ ok: true, merged: true, serialized: true });
    // One gh call does the whole land. `--repo` is load bearing: it turns off
    // gh's local-branch deletion, leaving only the remote delete.
    expect(calls).toEqual([
      ["pr", "merge", "42", "--squash", "--repo", "github.com/acme/steamtrain", "--delete-branch"],
    ]);
    expect(result).not.toHaveProperty("warnings");
    // Exactly two reads: the pre-lock wait, then the re-check under the lock.
    // Pinning this catches an accidental extra round-trip per land.
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it("omits both branch flags under --keep-branch", async () => {
    const calls: string[][] = [];
    const result = await mergePullRequestWhenReady({
      ...base,
      deleteBranch: false,
      fetchSnapshot: sequence([green()]),
      runGh: async (args) => {
        calls.push(args);
        return "";
      },
      runGit: async () => {
        throw new Error("git must not run when the branch is being kept");
      },
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([["pr", "merge", "42", "--squash"]]);
  });

  it("merges without cleanup, and says so, when the repo cannot be resolved", async () => {
    // Only reachable if `gh pr view` stops returning a parseable URL. Merging
    // with a bare `--delete-branch` would walk straight into the worktree
    // failure this all exists to avoid, so we land and leave the branch.
    const calls: string[][] = [];
    const result = await mergePullRequestWhenReady({
      ...base,
      fetchSnapshot: sequence([green({ baseRepo: undefined })]),
      runGh: async (args) => {
        calls.push(args);
        return "";
      },
    });
    expect(result).toMatchObject({ ok: true, merged: true });
    expect(calls).toEqual([["pr", "merge", "42", "--squash"]]);
    if (result.ok) {
      expect(result.warnings?.[0]).toMatch(/left the head branch of PR #42 in place/i);
      expect(result.detail).toMatch(/could not resolve owner\/repo/i);
    }
  });

  it("leaves the local branch alone when a worktree still has it checked out", async () => {
    // The exact babysit shape: the `prepare` step's worktree holds the PR head,
    // so `git branch -D` would fail — and used to fail the whole land step.
    const gitCalls: string[][] = [];
    const result = await mergePullRequestWhenReady({
      ...base,
      fetchSnapshot: sequence([green()]),
      runGh: async () => "",
      runGit: async (args) => {
        gitCalls.push(args);
        if (args[0] === "worktree") {
          return [
            "worktree /tmp/steamtrain-worktrees/prepare-1",
            "HEAD f7a3e502d457944382965bf10099754b1515b609",
            "branch refs/heads/claude/hopeful-shannon-1mrboz",
            "",
          ].join("\n");
        }
        throw new Error("cannot delete branch used by worktree");
      },
    });
    expect(result).toMatchObject({ ok: true, merged: true });
    expect(gitCalls).toEqual([["worktree", "list", "--porcelain"]]);
  });

  it("deletes the local branch when no worktree holds it", async () => {
    const gitCalls: string[][] = [];
    const result = await mergePullRequestWhenReady({
      ...base,
      fetchSnapshot: sequence([green()]),
      runGh: async () => "",
      runGit: async (args) => {
        gitCalls.push(args);
        return args[0] === "worktree" ? "worktree /repo\nbranch refs/heads/main\n" : "";
      },
    });
    expect(result.ok).toBe(true);
    expect(gitCalls).toEqual([
      ["worktree", "list", "--porcelain"],
      ["branch", "-D", "claude/hopeful-shannon-1mrboz"],
    ]);
  });

  it("reports success when gh exits non-zero but the merge actually landed", async () => {
    const fetchSnapshot = sequence([green(), green(), green({ state: "merged" })]);
    const result = await mergePullRequestWhenReady({
      ...base,
      fetchSnapshot,
      runGh: async (args) => {
        if (args[1] === "merge") {
          throw new Error(
            "gh pr merge 42 --squash failed: failed to delete local branch " +
              "claude/hopeful-shannon-1mrboz: cannot delete branch used by worktree",
          );
        }
        return "";
      },
    });
    expect(result).toMatchObject({ ok: true, merged: true, prNumber: 42 });
    if (result.ok) expect(result.detail).toMatch(/after the merge landed/i);
  });

  it("still fails when gh errors and the PR did not merge", async () => {
    const result = await mergePullRequestWhenReady({
      ...base,
      fetchSnapshot: sequence([green()]),
      runGh: async (args) => {
        if (args[1] === "merge") throw new Error("GraphQL: Something went very wrong");
        return "";
      },
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/merge failed after green checks/i);
  });

  it("retries a transient 'not mergeable' rejection (GitHub recomputing mergeability)", async () => {
    // Regression guard for isRetriableMergeError: GitHub transiently reports a
    // just-moved base as not mergeable. If that error text stops being treated
    // as retriable, parallel babysit lands start failing again.
    let merges = 0;
    const result = await mergePullRequestWhenReady({
      ...base,
      fetchSnapshot: sequence([green()]),
      runGh: async (args) => {
        if (args[1] === "merge") {
          merges += 1;
          if (merges === 1) throw new Error("Pull request is not mergeable");
        }
        return "";
      },
    });
    expect(result).toMatchObject({ ok: true, merged: true });
    expect(merges).toBe(2);
  });

  it("does not retry a 'not mergeable' that names a conflict — that state is permanent", async () => {
    // The mirror of the test above. "Not mergeable" alone is GitHub still
    // recomputing; "not mergeable because it has a merge conflict" never
    // resolves itself, and retrying it burns the attempt budget before the
    // conflict gets reported.
    let merges = 0;
    const result = await mergePullRequestWhenReady({
      ...base,
      fetchSnapshot: sequence([green()]),
      runGh: async (args) => {
        if (args[1] === "merge") {
          merges += 1;
          throw new Error("Pull request is not mergeable because it has a merge conflict");
        }
        return "";
      },
    });
    expect(result.ok).toBe(false);
    expect(merges).toBe(1);
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

  it("auto-rebases a PR the sibling land made conflicting, then merges it", async () => {
    // The exact babysit-all-prs failure: this PR was rebased and green, a
    // sibling landed under the same lock, and GitHub flipped it CONFLICTING.
    const calls: string[][] = [];
    const rebasePr = vi.fn(async () => ({
      ok: true as const,
      changed: true,
      detail: "rebased PR #42 onto main",
      prNumber: 42,
    }));
    const result = await mergePullRequestWhenReady({
      ...base,
      autoRebase: true,
      rebasePr,
      fetchSnapshot: sequence([
        green(), // firstWait
        green({ mergeable: "CONFLICTING" }), // land loop: sibling moved the base
        green(), // re-wait after the rebase force-push
        green(), // land loop, second pass
      ]),
      runGh: async (args) => {
        calls.push(args);
        return "";
      },
    });
    expect(rebasePr).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, merged: true });
    expect(calls.filter((c) => c[1] === "merge")).toHaveLength(1);
  });

  it("reports the rebase failure verbatim when the conflict is a real one", async () => {
    const rebasePr = vi.fn(async () => ({
      ok: false as const,
      error: "PR #42 cannot be rebased onto main automatically — conflicts in: src/lower.rs",
      conflicts: ["src/lower.rs"],
      prNumber: 42,
    }));
    const result = await mergePullRequestWhenReady({
      ...base,
      autoRebase: true,
      rebasePr,
      fetchSnapshot: sequence([green(), green({ mergeable: "CONFLICTING" })]),
      runGh: async () => "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/conflicts in: src\/lower\.rs/);
  });

  it("does not rebase twice when the PR is still conflicting afterwards", async () => {
    const rebasePr = vi.fn(async () => ({
      ok: true as const,
      changed: true,
      detail: "rebased",
      prNumber: 42,
    }));
    const result = await mergePullRequestWhenReady({
      ...base,
      autoRebase: true,
      rebasePr,
      // Conflicting forever: a second rebase would just churn CI.
      fetchSnapshot: sequence([green(), green({ mergeable: "CONFLICTING" })]),
      runGh: async () => "",
    });
    expect(rebasePr).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    // Having rebased onto the base, "the base moved" is no longer the honest
    // explanation — the report has to name the conflict as the real one.
    if (!result.ok) expect(result.error).toMatch(/still conflicts.*after being rebased/i);
  });

  it("re-reads instead of failing when the rebase was a no-op (stale mergeability)", async () => {
    // git found nothing to replay, which cannot coexist with a real conflict:
    // GitHub's CONFLICTING is stale, so settle and re-read rather than report.
    const rebasePr = vi.fn(async () => ({
      ok: true as const,
      changed: false,
      detail: "PR #42 already contains main — no rebase needed",
      prNumber: 42,
    }));
    const result = await mergePullRequestWhenReady({
      ...base,
      autoRebase: true,
      rebasePr,
      fetchSnapshot: sequence([
        green(), // firstWait
        green({ mergeable: "CONFLICTING" }), // stale
        green(), // re-read: GitHub caught up
        green(),
      ]),
      runGh: async () => "",
    });
    expect(rebasePr).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, merged: true });
  });

  it("leaves the old fail-fast behavior in place without --auto-rebase", async () => {
    const rebasePr = vi.fn();
    const result = await mergePullRequestWhenReady({
      ...base,
      rebasePr,
      fetchSnapshot: sequence([green(), green({ mergeable: "CONFLICTING" })]),
      runGh: async () => "",
    });
    expect(rebasePr).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
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
    expect(
      resolveSteamtrainCliInvocation(["bun", "/repo/src/index.tsx"], "/usr/bin/bun", {}),
    ).toBe("/usr/bin/bun /repo/src/index.tsx");
    expect(
      resolveSteamtrainCliInvocation(["node", "/usr/local/bin/steamtrain"], "/usr/bin/node", {}),
    ).toBe("/usr/local/bin/steamtrain");
  });

  it("re-applies ELECTRON_RUN_AS_NODE via env(1) under the desktop app", () => {
    // The desktop app's execPath is the Electron binary, which only behaves as
    // Node with this variable set — and command steps have it stripped from
    // their environment. A bare `VAR=1 cmd` prefix does NOT work inside
    // `$STEAMTRAIN_CLI` (shell treats the expanded assignment as a command
    // name); `env VAR=1 cmd` does.
    expect(
      resolveSteamtrainCliInvocation(
        ["electron", "/Applications/steamtrain.app/Contents/Resources/dist/index.js"],
        "/Applications/steamtrain.app/Contents/MacOS/steamtrain",
        { ELECTRON_RUN_AS_NODE: "1" },
      ),
    ).toBe(
      "env ELECTRON_RUN_AS_NODE=1 /Applications/steamtrain.app/Contents/MacOS/steamtrain " +
        "/Applications/steamtrain.app/Contents/Resources/dist/index.js",
    );
  });

  it("quotes an Electron path containing spaces", () => {
    expect(
      resolveSteamtrainCliInvocation(
        ["electron", "/Apps/My Steam Train.app/Contents/Resources/dist/index.js"],
        "/Apps/My Steam Train.app/Contents/MacOS/steamtrain",
        { ELECTRON_RUN_AS_NODE: "1" },
      ),
    ).toBe(
      "env ELECTRON_RUN_AS_NODE=1 '/Apps/My Steam Train.app/Contents/MacOS/steamtrain' " +
        "'/Apps/My Steam Train.app/Contents/Resources/dist/index.js'",
    );
  });

  it("leaves a normal install's invocation unprefixed", () => {
    expect(resolveSteamtrainCliInvocation(["bun", "/repo/src/index.tsx"], "/usr/bin/bun", {})).toBe(
      "/usr/bin/bun /repo/src/index.tsx",
    );
  });

  it("survives unquoted $STEAMTRAIN_CLI expansion under /bin/sh", async () => {
    // Regression for babysit under the desktop app: a bare `VAR=1 cmd` prefix
    // inside the env var becomes the command name after expansion.
    const { runShellCommand } = await import("../src/workflow/command");
    const cli = resolveSteamtrainCliInvocation(
      ["electron", "/tmp/steamtrain-entry.js"],
      "/tmp/steamtrain-bin",
      { ELECTRON_RUN_AS_NODE: "1" },
    );
    // Substitute a real binary so we don't need the Electron path to exist —
    // `env` + word-splitting is what we're proving.
    const fakeCli = cli
      .replace("/tmp/steamtrain-bin", "/bin/echo")
      .replace("/tmp/steamtrain-entry.js", "ok-from-cli");
    const result = await runShellCommand(`$STEAMTRAIN_CLI hello`, {
      cwd: process.cwd(),
      env: { STEAMTRAIN_CLI: fakeCli, PATH: "/bin:/usr/bin" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("ok-from-cli");
    expect(result.output).toContain("hello");
    expect(result.output).not.toMatch(/command not found/);
  });
});
