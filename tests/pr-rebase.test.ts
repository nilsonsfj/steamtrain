import { describe, expect, it } from "vitest";
import { parseConflictPaths, rebasePullRequestOntoBase } from "../src/workflow/pr-rebase";

const PR_VIEW = JSON.stringify({
  number: 448,
  state: "OPEN",
  mergedAt: null,
  headRefName: "nilsonsfj/happy-wozniak-8e1w3s",
  baseRefName: "main",
  isCrossRepository: false,
});

/**
 * A scripted git. `responses` maps the first two argv words to output; anything
 * unmatched returns "". Handlers that throw simulate a non-zero exit.
 */
function fakeGit(responses: Record<string, string | (() => string)> = {}) {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    const key = args.slice(0, 2).join(" ");
    const hit = responses[key] ?? responses[args[0] as string];
    if (typeof hit === "function") return hit();
    return hit ?? "";
  };
  return { run, calls };
}

const baseOpts = {
  prRef: "448",
  cwd: "/worktree",
  runGh: async () => PR_VIEW,
};

describe("parseConflictPaths", () => {
  it("trims and drops blank lines", () => {
    expect(parseConflictPaths("src/a.rs\n  src/b.rs \n\n")).toEqual(["src/a.rs", "src/b.rs"]);
    expect(parseConflictPaths("")).toEqual([]);
  });
});

describe("rebasePullRequestOntoBase", () => {
  it("is a no-op when the head already contains the base", async () => {
    const git = fakeGit({ "rev-list --count": "0", "rev-parse": "abc123" });
    const result = await rebasePullRequestOntoBase({ ...baseOpts, runGit: git.run });
    expect(result).toMatchObject({ ok: true, changed: false });
    expect(git.calls.some((c) => c[0] === "rebase")).toBe(false);
    expect(git.calls.some((c) => c[0] === "push")).toBe(false);
  });

  it("rebases and force-pushes with a lease pinned to the fetched sha", async () => {
    const git = fakeGit({ "rev-list --count": "3", "rev-parse": "abc123\n" });
    const result = await rebasePullRequestOntoBase({ ...baseOpts, runGit: git.run });
    expect(result).toMatchObject({ ok: true, changed: true });

    // Detach onto the exact sha we measured, not a branch name that could move.
    expect(git.calls).toContainEqual(["checkout", "--force", "--detach", "abc123"]);
    expect(git.calls).toContainEqual(["rebase", "origin/main"]);
    expect(git.calls).toContainEqual([
      "push",
      "--force-with-lease=refs/heads/nilsonsfj/happy-wozniak-8e1w3s:abc123",
      "origin",
      "HEAD:refs/heads/nilsonsfj/happy-wozniak-8e1w3s",
    ]);
  });

  it("aborts the rebase and reports the conflicting paths", async () => {
    const git = fakeGit({
      "rev-list --count": "3",
      "rev-parse": "abc123",
      rebase: () => {
        throw new Error("CONFLICT (content): Merge conflict in src/lower.rs");
      },
      "diff --name-only": "src/lower.rs\nsrc/lib.rs",
    });
    const result = await rebasePullRequestOntoBase({ ...baseOpts, runGit: git.run });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflicts).toEqual(["src/lower.rs", "src/lib.rs"]);
      expect(result.error).toMatch(/conflicts in: src\/lower\.rs, src\/lib\.rs/);
    }
    // The checkout must be left usable for the agent that runs next.
    expect(git.calls).toContainEqual(["rebase", "--abort"]);
    expect(git.calls.some((c) => c[0] === "push")).toBe(false);
  });

  it("refuses to run in a dirty checkout rather than clobbering it", async () => {
    const git = fakeGit({ "status --porcelain": " M src/lib.rs\n" });
    const result = await rebasePullRequestOntoBase({ ...baseOpts, runGit: git.run });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/uncommitted changes/i);
    expect(git.calls.some((c) => c[0] === "checkout")).toBe(false);
  });

  it("refuses fork PRs instead of force-pushing another repo's branch", async () => {
    const git = fakeGit();
    const result = await rebasePullRequestOntoBase({
      ...baseOpts,
      runGh: async () => JSON.stringify({ ...JSON.parse(PR_VIEW), isCrossRepository: true }),
      runGit: git.run,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/fork/i);
    expect(git.calls).toEqual([]);
  });

  it("treats an already-merged PR as nothing to do", async () => {
    const git = fakeGit();
    const result = await rebasePullRequestOntoBase({
      ...baseOpts,
      runGh: async () =>
        JSON.stringify({ ...JSON.parse(PR_VIEW), mergedAt: "2026-08-05T00:00:00Z" }),
      runGit: git.run,
    });
    expect(result).toMatchObject({ ok: true, changed: false });
    expect(git.calls).toEqual([]);
  });

  it("reports a lost --force-with-lease as retryable, not as a push error", async () => {
    const git = fakeGit({
      "rev-list --count": "2",
      "rev-parse": "abc123",
      push: () => {
        throw new Error("stale info: remote ref is at def456");
      },
    });
    const result = await rebasePullRequestOntoBase({ ...baseOpts, runGit: git.run });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/moved while it was being rebased/i);
  });

  it("does not push under push:false", async () => {
    const git = fakeGit({ "rev-list --count": "1", "rev-parse": "abc123" });
    const result = await rebasePullRequestOntoBase({
      ...baseOpts,
      runGit: git.run,
      push: false,
    });
    expect(result).toMatchObject({ ok: true, changed: true });
    expect(git.calls.some((c) => c[0] === "push")).toBe(false);
  });

  it("falls back to refs/pull/<n>/head when the head branch was deleted", async () => {
    const calls: string[][] = [];
    const run = async (args: string[]): Promise<string> => {
      calls.push(args);
      if (args[0] === "status") return "";
      if (args[0] === "fetch") {
        const refspec = args[3] ?? "";
        if (refspec.includes("refs/heads/nilsonsfj/happy-wozniak-8e1w3s")) {
          throw new Error("fatal: couldn't find remote ref nilsonsfj/happy-wozniak-8e1w3s");
        }
        // base fetch + pull-ref fallback succeed
        return "";
      }
      if (args[0] === "rev-parse") return "deadbeef\n";
      if (args[0] === "rev-list") return "2";
      return "";
    };
    const result = await rebasePullRequestOntoBase({ ...baseOpts, runGit: run });
    expect(result).toMatchObject({ ok: true, changed: true });
    expect(calls).toContainEqual([
      "fetch",
      "--no-tags",
      "origin",
      "+refs/pull/448/head:refs/remotes/origin/nilsonsfj/happy-wozniak-8e1w3s",
    ]);
    // Empty lease expect recreates the missing head branch.
    expect(calls).toContainEqual([
      "push",
      "--force-with-lease=refs/heads/nilsonsfj/happy-wozniak-8e1w3s:",
      "origin",
      "HEAD:refs/heads/nilsonsfj/happy-wozniak-8e1w3s",
    ]);
    if (result.ok) expect(result.detail).toMatch(/recreated/);
  });

  it("fails clearly when both the head branch and pull ref are gone", async () => {
    const run = async (args: string[]): Promise<string> => {
      if (args[0] === "status") return "";
      if (args[0] === "fetch") {
        const refspec = args[3] ?? "";
        if (refspec.includes("refs/heads/main")) return "";
        throw new Error("fatal: couldn't find remote ref");
      }
      return "";
    };
    const result = await rebasePullRequestOntoBase({ ...baseOpts, runGit: run });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/auto-deleted|missing/i);
  });
});
