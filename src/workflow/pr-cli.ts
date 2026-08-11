import type { CliIO } from "../cli";
import {
  DEFAULT_EMPTY_GRACE_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_REQUIRE_MERGEABLE_TIMEOUT_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  mergePullRequestWhenReady,
  requirePullRequestMergeable,
  waitForPullRequestChecks,
} from "./github-checks";
import { rebasePullRequestOntoBase } from "./pr-rebase";

/**
 * `steamtrain workflow pr …` — deterministic GitHub PR check-wait / land
 * helpers for babysit-style workflows. Agents prepare the PR; these commands
 * wait for EVERY status check (including non-required external reviews) and
 * only then optionally merge + delete the head branch.
 */

export async function runPrCommand(
  args: string[],
  io: CliIO,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    out(prHelpText());
    return 0;
  }
  if (sub === "wait-checks") {
    return runWaitChecks(args.slice(1), io, out, err);
  }
  if (sub === "merge-when-ready") {
    return runMergeWhenReady(args.slice(1), io, out, err);
  }
  if (sub === "require-mergeable") {
    return runRequireMergeable(args.slice(1), io, out, err);
  }
  if (sub === "rebase") {
    return runRebase(args.slice(1), io, out, err);
  }
  err(`unknown workflow pr command '${sub}'\n\n${prHelpText()}`);
  return 1;
}

export function prHelpText(): string {
  return `steamtrain workflow pr commands

Usage:
  steamtrain workflow pr wait-checks <pr> [--timeout-sec <n>] [--poll-sec <n>] [--empty-grace-sec <n>] [--json]
  steamtrain workflow pr merge-when-ready <pr> [--timeout-sec <n>] [--poll-sec <n>] [--empty-grace-sec <n>] [--strategy squash|merge|rebase] [--keep-branch] [--auto-rebase] [--json]
  steamtrain workflow pr require-mergeable <pr> [--timeout-sec <n>] [--poll-sec <n>] [--auto-rebase] [--json]
  steamtrain workflow pr rebase <pr> [--dry-run] [--json]

<pr> may be a number, a pull URL, a head branch name, or a "number\\nbranch" line.

wait-checks polls GitHub's statusCheckRollup until every check is terminal.
An empty rollup right after a fresh push is treated as "not registered yet"
(not "no CI"), so external review bots that start a few seconds late are not
raced. Exit 0 only when all checks are green (or the grace window passes with
no checks at all).

merge-when-ready runs wait-checks, then \`gh pr merge\` — and only then deletes
the head branch (unless --keep-branch). Use this from a command step AFTER an
agent has finished pushing fixes; never let the agent merge itself.

The merge passes \`--repo\`, which is what stops gh from deleting the LOCAL
branch (it only deletes the remote head ref). gh's local-branch step fails
whenever a worktree has the head checked out, as babysit's prepare worktree
does. The local branch is removed separately, and only when no worktree holds
it. A landed PR is never reported as a failed merge.

The land is serialized across processes (a cross-process lock keyed by the
repo's origin), so parallel babysit runs merge one PR at a time. Under the
lock the PR is re-checked: a base that moved under a sibling's merge is
handled (behind → update + re-wait, conflict → reported) and transient
"base branch was modified" errors are retried, instead of failing outright.
With --auto-rebase a conflict is first replayed through \`pr rebase\` once, so
a PR whose only problem is that a sibling landed ahead of it still lands.

require-mergeable exits 0 only when the remote head is MERGEABLE (or already
merged). It does not wait on CI — that is wait-checks / merge-when-ready.
Babysit runs this after the prepare agent so a narrated-but-unpushed rebase
cannot look ready to land. With --auto-rebase a purely mechanical conflict is
replayed once before failing; content conflicts stay a hard failure for the
agent loop.

rebase fetches the PR's head and base, rebases the head onto \`origin/<base>\`
and force-pushes it with a lease pinned to the ref it fetched. If the head
branch was auto-deleted, it falls back to \`refs/pull/<n>/head\` and recreates
the branch on push. It exits 0 with "no rebase needed" when the head already
contains the base. Real content conflicts exit non-zero and list the conflicting
paths — those need an agent or a human. It refuses to run in a dirty checkout,
and refuses fork PRs.
`;
}

interface PrFlags {
  pr?: string;
  timeoutSec?: number;
  pollSec?: number;
  emptyGraceSec?: number;
  strategy?: "squash" | "merge" | "rebase";
  keepBranch: boolean;
  autoRebase: boolean;
  dryRun: boolean;
  json: boolean;
}

function parsePrFlags(args: string[]): PrFlags | { error: string } {
  const flags: PrFlags = { keepBranch: false, autoRebase: false, dryRun: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      if (flags.pr !== undefined) return { error: `unexpected argument '${arg}'` };
      flags.pr = arg;
      continue;
    }
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    if (arg === "--keep-branch") {
      flags.keepBranch = true;
      continue;
    }
    if (arg === "--auto-rebase") {
      flags.autoRebase = true;
      continue;
    }
    if (arg === "--dry-run") {
      flags.dryRun = true;
      continue;
    }
    const next = args[i + 1];
    const take = (name: string): string | { error: string } => {
      if (next === undefined || next.startsWith("--")) {
        return { error: `${name} requires a value` };
      }
      i += 1;
      return next;
    };
    if (arg === "--timeout-sec") {
      const v = take(arg);
      if (typeof v !== "string") return v;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0)
        return { error: "--timeout-sec must be a positive number" };
      flags.timeoutSec = n;
      continue;
    }
    if (arg === "--poll-sec") {
      const v = take(arg);
      if (typeof v !== "string") return v;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return { error: "--poll-sec must be a positive number" };
      flags.pollSec = n;
      continue;
    }
    if (arg === "--empty-grace-sec") {
      const v = take(arg);
      if (typeof v !== "string") return v;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        return { error: "--empty-grace-sec must be a non-negative number" };
      }
      flags.emptyGraceSec = n;
      continue;
    }
    if (arg === "--strategy") {
      const v = take(arg);
      if (typeof v !== "string") return v;
      if (v !== "squash" && v !== "merge" && v !== "rebase") {
        return { error: "--strategy must be squash, merge, or rebase" };
      }
      flags.strategy = v;
      continue;
    }
    return { error: `unknown flag '${arg}'` };
  }
  return flags;
}

async function runWaitChecks(
  args: string[],
  io: CliIO,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const parsed = parsePrFlags(args);
  if ("error" in parsed) {
    err(`${parsed.error}\n\n${prHelpText()}`);
    return 1;
  }
  if (!parsed.pr) {
    err(`wait-checks requires a PR ref\n\n${prHelpText()}`);
    return 1;
  }
  const cwd = io.cwd ?? process.cwd();
  const result = await waitForPullRequestChecks({
    cwd,
    prRef: parsed.pr,
    timeoutMs: (parsed.timeoutSec ?? DEFAULT_WAIT_TIMEOUT_MS / 1000) * 1000,
    pollIntervalMs: (parsed.pollSec ?? DEFAULT_POLL_INTERVAL_MS / 1000) * 1000,
    emptyGraceMs:
      parsed.emptyGraceSec !== undefined ? parsed.emptyGraceSec * 1000 : DEFAULT_EMPTY_GRACE_MS,
    onPoll: (_snapshot, evaluation) => {
      if (!parsed.json) out(`${evaluation.detail}\n`);
    },
  });

  if (parsed.json) {
    out(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    out(`${result.evaluation.detail}\n`);
  } else {
    err(`${result.error}\n`);
  }
  return result.ok ? 0 : 1;
}

async function runRebase(
  args: string[],
  io: CliIO,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const parsed = parsePrFlags(args);
  if ("error" in parsed) {
    err(`${parsed.error}\n\n${prHelpText()}`);
    return 1;
  }
  if (!parsed.pr) {
    err(`rebase requires a PR ref\n\n${prHelpText()}`);
    return 1;
  }
  const result = await rebasePullRequestOntoBase({
    cwd: io.cwd ?? process.cwd(),
    prRef: parsed.pr,
    push: !parsed.dryRun,
  });

  if (parsed.json) {
    out(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    out(`${result.detail}\n`);
  } else {
    err(`${result.error}\n`);
  }
  return result.ok ? 0 : 1;
}

async function runRequireMergeable(
  args: string[],
  io: CliIO,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const parsed = parsePrFlags(args);
  if ("error" in parsed) {
    err(`${parsed.error}\n\n${prHelpText()}`);
    return 1;
  }
  if (!parsed.pr) {
    err(`require-mergeable requires a PR ref\n\n${prHelpText()}`);
    return 1;
  }
  const cwd = io.cwd ?? process.cwd();
  const result = await requirePullRequestMergeable({
    cwd,
    prRef: parsed.pr,
    timeoutMs: (parsed.timeoutSec ?? DEFAULT_REQUIRE_MERGEABLE_TIMEOUT_MS / 1000) * 1000,
    pollIntervalMs: (parsed.pollSec ?? DEFAULT_POLL_INTERVAL_MS / 1000) * 1000,
    autoRebase: parsed.autoRebase,
    onPoll: (_snapshot, detail) => {
      if (!parsed.json) out(`${detail}\n`);
    },
  });

  if (parsed.json) {
    out(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    out(`${result.detail}\n`);
  } else {
    err(`${result.error}\n`);
  }
  return result.ok ? 0 : 1;
}

async function runMergeWhenReady(
  args: string[],
  io: CliIO,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const parsed = parsePrFlags(args);
  if ("error" in parsed) {
    err(`${parsed.error}\n\n${prHelpText()}`);
    return 1;
  }
  if (!parsed.pr) {
    err(`merge-when-ready requires a PR ref\n\n${prHelpText()}`);
    return 1;
  }
  const cwd = io.cwd ?? process.cwd();
  const result = await mergePullRequestWhenReady({
    cwd,
    prRef: parsed.pr,
    timeoutMs: (parsed.timeoutSec ?? DEFAULT_WAIT_TIMEOUT_MS / 1000) * 1000,
    pollIntervalMs: (parsed.pollSec ?? DEFAULT_POLL_INTERVAL_MS / 1000) * 1000,
    emptyGraceMs:
      parsed.emptyGraceSec !== undefined ? parsed.emptyGraceSec * 1000 : DEFAULT_EMPTY_GRACE_MS,
    mergeStrategy: parsed.strategy,
    deleteBranch: !parsed.keepBranch,
    autoRebase: parsed.autoRebase,
    onPoll: (_snapshot, evaluation) => {
      if (!parsed.json) out(`${evaluation.detail}\n`);
    },
    landLockOptions: {
      onWait: (message) => {
        if (!parsed.json) out(`${message}\n`);
      },
    },
  });

  if (parsed.json) {
    out(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    out(`${result.detail}\n`);
  } else {
    err(`${result.error}\n`);
  }
  return result.ok ? 0 : 1;
}
