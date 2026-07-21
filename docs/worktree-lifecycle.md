# Closing the worktree lifecycle: analysis and design

Date: 2026-07-14. Status: shipped (this document describes both the analysis
that motivated the change set and the decisions taken).

Companion to [`worktree-merge-back.md`](worktree-merge-back.md), which covers
the merge/harvest *mechanism*. This document covers the *lifecycle*: what was
flawed or incomplete in the parallel-workers-in-worktrees + merge-at-the-end
model as a whole, and how each end was closed.

## The model under review

Every agent-backed step (and `command` step) runs in an isolated git worktree
on a `steamtrain/<runId>/<step>-<unique>` branch, snapshotting the checkout's
working state. Worktrees are **retained after the run** — deliberately, so
work is never silently lost — and harvested either declaratively (a `merge`
step: snapshot → merge in a staging worktree → deliver as apply/branch/PR,
with `fail | ours | theirs | agent` conflict handling) or after the fact
(`workflow history show --diff / apply / prune`).

That mechanism was sound: merging is deterministic git; the one
judgment-shaped part (semantic conflicts between two agents' competing edits)
is the one part that can be an LLM (`onConflict: "agent"`); the user's
checkout is only ever touched by a pre-checked, all-or-nothing `git apply`.

## Flaws found

### 1. The lifecycle never terminated (worst gap)

"Retained after the run" had no counterweight:

- A successful `merge` step **delivered the result and still kept every
  source worktree and branch forever.** The deliverable was durable, the
  sources were garbage — but nothing collected them.
- Cleanup existed only as per-run `history prune <id>`, which requires
  knowing a run id and only works while the run record exists (history keeps
  the newest 100; records are also deletable with `history clear`).
- Worktree *directories* live under `$TMPDIR`, which the OS reaps on its own
  schedule; the *branches* live in the user's repo, which nothing reaps.
  The steady state of a happy steamtrain user was dozens of stale
  `steamtrain/...` branches polluting `git branch` and stale worktree
  registrations in `git worktree list`, with no tool-provided way out.
- Runs that crashed before a history record was written leaked worktrees and
  branches that *no* run-scoped command could ever find again.

**Closed by:**

- **`cleanup: true` on the merge step.** After a successful delivery the
  source worktrees and branches are pruned; the delivered result is the
  single durable copy. Failure paths always keep the worktrees (post-mortem
  harvesting must stay possible), which is why this is an option on the merge
  step and not a blanket policy. Cleaned sources are reported in the step
  output and in the structured result (`cleaned`).
- **Repo-wide GC: `steamtrain workflow worktrees [list|prune]`.** Discovery
  works from git itself (`git branch --list 'steamtrain/*'` +
  `git worktree list --porcelain`), so it finds *every* steamtrain worktree
  and branch — including orphans with no run record — and cross-references
  run history where records exist (run, workflow, harvested/pruned status).
  `prune` policy:
  - no selector → **stale entries only** (worktree directory gone): always
    safe, there is nothing left to harvest from a directory the OS deleted;
  - `--run <id>`, `--older-than <days>`, `--all` widen the selection;
  - entries that appear to hold **unharvested work** (dirty worktree, or
    branch commits not reachable from `HEAD`, and no recorded apply/prune)
    are skipped unless `--force` — GC must never eat work the user hasn't
    landed or explicitly discarded;
  - `steamtrain/merged/*` branches are deliverables, never GC targets;
  - `--dry-run` previews; fully-pruned recorded runs get `prunedAt` stamped.
  - `workspace: "attach:<stepId>"` steps don't allocate a worktree of their
    own — they run inside the source step's, so GC only ever sees ONE entry
    per attach group (the source's), not one per attacher. A `mode:
    "worktree"` merge step DOES allocate its own kept worktree (same base
    directory and naming convention as any other step's), so it shows up as
    its own discoverable GC entry — dirty state / unreachable branch commits
    protect it exactly like an agent step's worktree until it's harvested or
    explicitly pruned.

### 2. Merge failure was a dead end

`onConflict: "fail"` (the default) listed the conflicted files and stopped.
`history apply` was hardwired to `mode: "apply"` + `onConflict: fail`. So the
moment two parallel workers touched the same file, every recovery path led
out of the tool into manual `git merge` archaeology across `$TMPDIR` paths.
The failure messages also gave no next step.

**Closed by:**

- `history apply` gained the full delivery surface:
  `--mode apply|branch|pr`, `--branch <name>`, `--onconflict ours|theirs`.
  A conflicted apply now has three in-tool answers: pick a deterministic
  winner, deliver to a branch and merge by hand, or land one step at a time
  (`--step`).
- Every conflict failure (engine merge step, CLI, web) now carries shared,
  surface-appropriate guidance (`mergeConflictGuidance`), including the
  pointer to `onConflict: "agent"` — the LLM-assisted path — for semantic
  conflicts.
- The web UI turns a 409 conflict into **retry buttons** ("first wins" /
  "last wins") rather than a dead-end error banner.

Decision: LLM-assisted resolution stays a *run-time* feature (the merge
step's `onConflict: "agent"`), not a post-hoc CLI flag. Post-hoc harvesting
runs outside an engine context (no adapter pool, no cost accounting, no event
stream to render the agent under); replaying that machinery in the CLI would
duplicate the engine for a case the deterministic options plus `--mode
branch` already cover. If demand appears, the right shape is a small
generated one-step merge workflow, not a bespoke code path.

### 3. Results were CLI-only; the UIs could show but not act

Both UIs showed a step's worktree branch/dir live, and the merge step's text
output listed merged files — but a run *without* a merge step stranded its
deliverable with no UI affordance at all: no diffstat, no apply, no prune, no
indication in run history whether a run's work was ever landed or discarded.
`harvest:` status existed only in `history show` (CLI).

**Closed by:**

- **Web:** run history detail gained a "Worktree changes" section — per-step
  diffstat of the retained worktrees (from the new
  `GET /api/history/:id/worktrees`), the recorded harvest status
  (applied/branch/PR/pruned), and actions: **Apply to checkout**, **Merge to
  branch**, **Prune** (`POST /api/history/:id/harvest`, `/prune`), with the
  conflict-retry flow described above. Prune confirms before discarding.
- **TUI:** history detail gained `a` (apply to checkout) and `x` (prune,
  double-press to confirm — it deletes unapplied work), with outcomes and
  conflict guidance surfaced as notices, and hints shown only for runs that
  actually have worktrees.
- **Shared core:** all three surfaces call the same
  `src/workflow/gc.ts` helpers (`harvestRunWorktrees`, `pruneRunWorktrees`,
  `finalRunWorktrees`), which also persist the outcome onto the run record —
  so "was this run landed?" has one answer everywhere. `RunHarvestInfo` now
  also records the delivery `branch`/`prUrl` for branch/pr harvests.

### 4. Minor closures done along the way

- The `harvest:` line in `history show` reports branch/PR deliveries.
- CLI help documents the whole lifecycle (retention → inspect → harvest →
  prune → GC) in one place.

## Non-goals (explicit decisions)

- **No automatic GC on run completion or a background daemon.** Retention is
  a feature (inspectability); eager auto-delete would silently destroy the
  escape hatch. The closure is explicit (`cleanup: true` where the author
  declares delivery is enough) plus a safe, discoverable manual GC. A future
  opt-in config (`worktreeRetentionDays`) can build on `gcRepoWorktrees`
  unchanged.
- **No full patch viewer in the TUI.** The TUI shows diffstat-level state and
  actions; full patches remain `history show <id> --diff` (already paged,
  greppable, pipeable). The web UI is the richer surface and can grow a patch
  view on top of the same endpoint later.
- **Conflicts with the user's *local* edits stay fail-fast** in `apply` mode
  (pre-checked `git apply`). That state belongs to the user, not the
  workflow; auto-resolving it would modify uncommitted local work. `--mode
  branch` is the sanctioned route around it.

## Test coverage added

- `tests/workflow-gc.test.ts` — change detection, stale-only default prune,
  unharvested-work protection + `--force`, merged-branch immunity, history
  cross-ref/stamping, CLI `worktrees list|prune`.
- `tests/history-harvest-cli.test.ts` — `--mode branch` delivery + record
  stamping, conflict guidance + `--onconflict theirs` recovery, flag
  validation.
- `tests/workflow-merge-step.test.ts` — `cleanup: true` prunes sources after
  delivery; a conflicted cleanup merge keeps every worktree and fails with
  actionable guidance.
- `tests/web-server.test.ts` — worktrees/harvest/prune endpoints end to end
  against a real repo.
