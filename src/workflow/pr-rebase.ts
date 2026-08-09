import { parsePullRequestRef } from "./github-checks";
import { runCommand } from "./merge";

/**
 * Deterministic "rebase this PR head onto its base and push" for babysit.
 *
 * Why this is not left to the agent: in a `babysit-all-prs` fan-out the base
 * branch moves under every sibling that lands, so each PR needs re-basing at a
 * point the agent has already finished. Worse, agents that were told to rebase
 * routinely did the work in the WRONG checkout (they `cd` out of their isolated
 * worktree, or `git worktree add` a second one against the shared repo) and
 * never pushed — the PR stayed CONFLICTING and the land step failed with
 * "merge conflicts with the base branch" on work that was, in fact, done.
 *
 * This module does the mechanical part with git plumbing and no judgment:
 * fetch, rebase onto `origin/<base>`, push with `--force-with-lease` pinned to
 * the exact ref we fetched. Anything requiring judgment (a real content
 * conflict) is reported with the conflicting paths and left for the agent.
 */

export interface RebasePullRequestOptions {
  /** PR number, URL, head branch, or a "number\nbranch" line. */
  prRef: string;
  /** Working directory — must be a clean checkout of the target repo. */
  cwd: string;
  signal?: AbortSignal;
  /** Injectable `gh` runner (args after the implicit `gh`). */
  runGh?: (args: string[], cwd: string, signal?: AbortSignal) => Promise<string>;
  /** Injectable `git` runner (args after the implicit `git`). */
  runGit?: (args: string[], cwd: string, signal?: AbortSignal) => Promise<string>;
  /** Push the rebased head (default true). False makes this a dry check. */
  push?: boolean;
  /** Remote holding the PR head (default "origin"). */
  remote?: string;
}

export type RebasePullRequestResult =
  | {
      ok: true;
      /** True when the head actually moved and was pushed. */
      changed: boolean;
      detail: string;
      prNumber?: number;
    }
  | {
      ok: false;
      error: string;
      /** Paths git left unmerged, when the failure was a content conflict. */
      conflicts?: string[];
      prNumber?: number;
    };

interface PrRefs {
  number: number;
  state: "open" | "closed" | "merged";
  headRefName: string;
  baseRefName: string;
  crossRepository: boolean;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `gh pr view` reduced to the refs a rebase needs. */
async function readPrRefs(
  gh: (args: string[]) => Promise<string>,
  selector: string,
): Promise<PrRefs> {
  const raw = await gh([
    "pr",
    "view",
    selector,
    "--json",
    "number,state,mergedAt,headRefName,baseRefName,isCrossRepository",
  ]);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`gh pr view returned invalid JSON for '${selector}'`);
  }
  const number = typeof parsed.number === "number" ? parsed.number : Number(selector);
  if (!Number.isFinite(number)) {
    throw new Error(`could not resolve PR number from '${selector}'`);
  }
  const headRefName = typeof parsed.headRefName === "string" ? parsed.headRefName : "";
  const baseRefName = typeof parsed.baseRefName === "string" ? parsed.baseRefName : "";
  if (!headRefName || !baseRefName) {
    throw new Error(`PR #${number} is missing its head/base branch names`);
  }
  const stateRaw = String(parsed.state ?? "").toUpperCase();
  return {
    number,
    state: parsed.mergedAt ? "merged" : stateRaw === "OPEN" ? "open" : "closed",
    headRefName,
    baseRefName,
    crossRepository: parsed.isCrossRepository === true,
  };
}

/** Paths git left unmerged, parsed from `git diff --name-only --diff-filter=U`. */
export function parseConflictPaths(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Rebase a PR's head onto its base and force-push it.
 *
 * Returns `changed: false` (still `ok`) when there was nothing to do — the head
 * already contains the base tip, or the PR is merged/closed. A content conflict
 * is NOT an error of this function's making: the rebase is aborted so the
 * checkout is left usable, and the conflicting paths come back for the agent.
 */
export async function rebasePullRequestOntoBase(
  opts: RebasePullRequestOptions,
): Promise<RebasePullRequestResult> {
  const remote = opts.remote ?? "origin";
  const gh = (args: string[]): Promise<string> =>
    (opts.runGh ?? ((a, cwd, signal) => runCommand("gh", a, cwd, signal)))(
      args,
      opts.cwd,
      opts.signal,
    );
  const git = (args: string[]): Promise<string> =>
    (opts.runGit ?? ((a, cwd, signal) => runCommand("git", a, cwd, signal)))(
      args,
      opts.cwd,
      opts.signal,
    );

  let refs: PrRefs;
  try {
    refs = await readPrRefs(gh, parsePullRequestRef(opts.prRef));
  } catch (err) {
    return { ok: false, error: errText(err) };
  }

  if (refs.state === "merged") {
    return {
      ok: true,
      changed: false,
      detail: `PR #${refs.number} is already merged`,
      prNumber: refs.number,
    };
  }
  if (refs.state === "closed") {
    return {
      ok: false,
      error: `PR #${refs.number} is closed without being merged`,
      prNumber: refs.number,
    };
  }
  if (refs.crossRepository) {
    return {
      ok: false,
      error: `PR #${refs.number} comes from a fork — steamtrain will not force-push to another repository's branch. Rebase it from the fork, or land it manually.`,
      prNumber: refs.number,
    };
  }

  // Never clobber someone's work in progress. In babysit this runs in a fresh
  // isolated worktree, so a dirty tree means we are somewhere we should not be.
  try {
    const dirty = (await git(["status", "--porcelain"])).trim();
    if (dirty) {
      return {
        ok: false,
        error: `refusing to rebase PR #${refs.number}: the checkout at ${opts.cwd} has uncommitted changes. Run this in a clean worktree.`,
        prNumber: refs.number,
      };
    }
  } catch (err) {
    return { ok: false, error: errText(err), prNumber: refs.number };
  }

  const { headRefName: head, baseRefName: base } = refs;
  // Fetch base and head separately so a deleted head branch can fall back to
  // GitHub's pull ref without failing the whole fetch. Parallel agent fan-outs
  // routinely hit "couldn't find remote ref" when they only know the branch
  // name after repo auto-delete / prune — `refs/pull/<n>/head` still works
  // for open PRs and lets us recreate the branch on push.
  let headVia: "branch" | "pull";
  try {
    await git(["fetch", "--no-tags", remote, `+refs/heads/${base}:refs/remotes/${remote}/${base}`]);
  } catch (err) {
    return {
      ok: false,
      error: `could not fetch PR #${refs.number}'s base '${base}': ${errText(err)}`,
      prNumber: refs.number,
    };
  }
  try {
    await git(["fetch", "--no-tags", remote, `+refs/heads/${head}:refs/remotes/${remote}/${head}`]);
    headVia = "branch";
  } catch (branchErr) {
    try {
      await git([
        "fetch",
        "--no-tags",
        remote,
        `+refs/pull/${refs.number}/head:refs/remotes/${remote}/${head}`,
      ]);
      headVia = "pull";
    } catch (pullErr) {
      return {
        ok: false,
        error: `PR #${refs.number} head '${head}' is missing on ${remote} (and refs/pull/${refs.number}/head is unavailable) — the branch may have been auto-deleted. ${errText(pullErr)}`,
        prNumber: refs.number,
      };
    }
  }

  let headSha: string;
  let behind: number;
  try {
    headSha = (await git(["rev-parse", `${remote}/${head}`])).trim();
    // Commits on the base that the head does not have yet.
    behind = Number(
      (await git(["rev-list", "--count", `${remote}/${head}..${remote}/${base}`])).trim(),
    );
  } catch (err) {
    return { ok: false, error: errText(err), prNumber: refs.number };
  }

  if (Number.isFinite(behind) && behind === 0) {
    return {
      ok: true,
      changed: false,
      detail:
        headVia === "pull"
          ? `PR #${refs.number} already contains ${base} (head recovered via refs/pull/${refs.number}/head) — no rebase needed`
          : `PR #${refs.number} already contains ${base} — no rebase needed`,
      prNumber: refs.number,
    };
  }

  try {
    await git(["checkout", "--force", "--detach", headSha]);
  } catch (err) {
    return {
      ok: false,
      error: `could not check out PR #${refs.number}'s head: ${errText(err)}`,
      prNumber: refs.number,
    };
  }

  try {
    await git(["rebase", `${remote}/${base}`]);
  } catch (err) {
    let conflicts: string[] = [];
    try {
      conflicts = parseConflictPaths(await git(["diff", "--name-only", "--diff-filter=U"]));
    } catch {
      // Rebase may have failed before touching the index — no paths to report.
    }
    // Leave the checkout usable for whoever runs next (agent or human).
    try {
      await git(["rebase", "--abort"]);
    } catch {
      // Not mid-rebase after all.
    }
    return {
      ok: false,
      error: `PR #${refs.number} cannot be rebased onto ${base} automatically${conflicts.length > 0 ? ` — conflicts in: ${conflicts.join(", ")}` : `: ${errText(err)}`}`,
      ...(conflicts.length > 0 ? { conflicts } : {}),
      prNumber: refs.number,
    };
  }

  if (opts.push === false) {
    return {
      ok: true,
      changed: true,
      detail: `PR #${refs.number} rebases onto ${base} cleanly (not pushed)`,
      prNumber: refs.number,
    };
  }

  try {
    // Lease pinned to the sha we fetched: if anyone pushed to the head in the
    // meantime, this fails instead of discarding their commits. When the head
    // branch was missing and we recovered via refs/pull/<n>/head, expect an
    // absent remote ref (empty expect) so push recreates the branch.
    const lease =
      headVia === "pull"
        ? `--force-with-lease=refs/heads/${head}:`
        : `--force-with-lease=refs/heads/${head}:${headSha}`;
    await git(["push", lease, remote, `HEAD:refs/heads/${head}`]);
  } catch (err) {
    const message = errText(err);
    return {
      ok: false,
      error: /stale info|force-with-lease|rejected/i.test(message)
        ? `PR #${refs.number}'s head branch moved while it was being rebased — retry`
        : `could not push PR #${refs.number}'s rebased head: ${message}`,
      prNumber: refs.number,
    };
  }

  return {
    ok: true,
    changed: true,
    detail:
      headVia === "pull"
        ? `rebased PR #${refs.number} onto ${base} (${behind} new base commit(s)) and recreated ${head} from refs/pull/${refs.number}/head`
        : `rebased PR #${refs.number} onto ${base} (${behind} new base commit(s)) and force-pushed ${head}`,
    prNumber: refs.number,
  };
}
