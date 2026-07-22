import type { CliIO } from "../cli";
import {
  DEFAULT_EMPTY_GRACE_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  mergePullRequestWhenReady,
  waitForPullRequestChecks,
} from "./github-checks";

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
  err(`unknown workflow pr command '${sub}'\n\n${prHelpText()}`);
  return 1;
}

export function prHelpText(): string {
  return `steamtrain workflow pr commands

Usage:
  steamtrain workflow pr wait-checks <pr> [--timeout-sec <n>] [--poll-sec <n>] [--empty-grace-sec <n>] [--json]
  steamtrain workflow pr merge-when-ready <pr> [--timeout-sec <n>] [--poll-sec <n>] [--empty-grace-sec <n>] [--strategy squash|merge|rebase] [--keep-branch] [--json]

<pr> may be a number, a pull URL, a head branch name, or a "number\\nbranch" line.

wait-checks polls GitHub's statusCheckRollup until every check is terminal.
An empty rollup right after a fresh push is treated as "not registered yet"
(not "no CI"), so external review bots that start a few seconds late are not
raced. Exit 0 only when all checks are green (or the grace window passes with
no checks at all).

merge-when-ready runs wait-checks, then \`gh pr merge\` — and only then deletes
the head branch (unless --keep-branch). Use this from a command step AFTER an
agent has finished pushing fixes; never let the agent merge itself.
`;
}

interface PrFlags {
  pr?: string;
  timeoutSec?: number;
  pollSec?: number;
  emptyGraceSec?: number;
  strategy?: "squash" | "merge" | "rebase";
  keepBranch: boolean;
  json: boolean;
}

function parsePrFlags(args: string[]): PrFlags | { error: string } {
  const flags: PrFlags = { keepBranch: false, json: false };
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
    onPoll: (_snapshot, evaluation) => {
      if (!parsed.json) out(`${evaluation.detail}\n`);
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
