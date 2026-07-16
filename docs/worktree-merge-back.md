# Worktree diff review and merge-back

Status: shipped (roadmap §1.1). This document explains the design — what the
`merge` step and the `history` harvesting CLI do, and why they are shaped the
way they are.

## The problem

Every agent step runs in an isolated git worktree (see
[`workflow-overview.md`](workflow-overview.md) §"Agent worktree isolation").
That protects the user's checkout, but it also means an `implement`-style
workflow *succeeds* and then strands its deliverable in
`$TMPDIR/steamtrain-worktrees/...`: harvesting the edits used to mean manual
`git diff` / `cherry-pick` archaeology across N step worktrees.

## Design goals

1. **Merge-back must not be a manual step.** A workflow that edits files
   should be able to land those edits as part of the run itself — declaratively,
   without the user driving a review UI afterwards.
2. **Deterministic where possible, LLM-driven only where necessary.** Merging
   N worktrees is standard git; paying an agent to do `git merge` would be
   slow, expensive, and less reliable. The only genuinely judgment-shaped part
   is resolving *semantic* conflicts between two agents' competing edits — so
   that is the one part that can (optionally) be an agent.
3. **Support multiple operating models.** Sometimes you want changes applied
   straight into the checkout; sometimes you want a branch; sometimes you want
   one PR per parallel agent so a human reviews each with full trace.
4. **Never damage the user's checkout.** Apply is pre-checked and
   all-or-nothing; all merging happens in a throwaway staging worktree; failure
   modes leave the checkout untouched.

## Why a step kind (and not "just a regular LLM step")?

We considered making merge-back a plain agent step — prompt an agent with the
worktree paths and let it integrate. That option **exists** (worktree paths
are now templatable: `{{steps.<id>.worktree.root}}` / `.branch` / `.cwd`), and
it is the right escape hatch for bespoke integration flows. But it is the
wrong *default*:

- 95% of merge-back is mechanical (`snapshot → merge → deliver`); an agent
  adds cost, latency, and nondeterminism to a solved problem.
- A declarative step gives the engine a typed result (`files`, `conflicts`,
  `prUrls`, `noChanges`) that gates and downstream steps can route on — an
  agent's prose can't be trusted for that.
- Standardization is what lets the TUI/web UI/CLI render merge results
  uniformly, and what the existing approval gates hook into: "show me the
  diff, then continue".

So: a deterministic `merge` step kind, with an agent *inside* it for exactly
the judgment-shaped part (conflict resolution), plus the template escape hatch
for anyone who wants full custom control.

## The mechanism

All harvesting is plain git, shared between the engine step and the CLI
(`src/workflow/merge.ts`):

1. **Snapshot.** Each source worktree's full working state (tracked edits +
   untracked files; ignored files excluded) is committed onto its own
   steamtrain branch — `steamtrain: snapshot of step '<id>'`. Worktrees and
   branches already belonged to steamtrain, so this is safe, idempotent, and
   makes the state durable/inspectable. Unchanged worktrees drop out here.
2. **Stage.** A throwaway staging worktree is created from the target repo's
   current HEAD, and each snapshot is `git merge --no-ff`-ed into it in order.
   Because worktrees share the repository's object database, no fetching or
   patch-shuffling is involved, and `git merge` finds merge bases itself —
   this works even when the user's HEAD moved since the run started.
3. **Resolve.** A conflicting merge follows `onConflict`:
   - `fail` (default): abort, step fails listing the conflicted files.
   - `ours` / `theirs`: `git merge -X ours|theirs` — deterministic winner for
     content conflicts. Tree-level conflicts (modify/delete, rename/rename)
     are not auto-resolved by `-X` and still fail; use `agent` for those.
   - `agent`: the configured agent is spawned *inside the staging worktree*
     with a built-in prompt naming the conflicted files (plus optional
     `prompt` guidance). It edits the files; the engine stages, verifies no
     conflict markers remain, and concludes the merge. Its cost/tokens are
     billed to the merge step, and its event stream renders live under the
     step like any agent step.
4. **Deliver** (`mode`):
   - `apply` — the staging diff is applied to the user's checkout as
     uncommitted working-tree changes. `git apply --check` runs first, so the
     apply is all-or-nothing; conflicts with *local* edits fail cleanly with
     guidance instead of half-patching (that failure mode is the user's state,
     not the workflow's — a different problem from source-vs-source conflicts,
     and deliberately not auto-resolved).
   - `branch` — the merged state stays on a named local branch; the checkout
     is untouched.
   - `pr` — the branch is pushed to `origin` and `gh pr create` opens a pull
     request targeting the branch the run started from (falling back to the
     remote's default branch on a detached HEAD). With `perSource: true` the whole pipeline runs once per source
     worktree: one branch + PR per parallel agent, the "human reviews each
     implementation with trace" operating model.

## Manual harvesting (the same machinery, after the fact)

Runs that didn't include a `merge` step — or older runs — can be harvested
from history, since every step result records its worktree root/branch/base:

```bash
steamtrain workflow history show <id> --diff            # full per-step patches
steamtrain workflow history show <id> --diff --stat     # files + counts only
steamtrain workflow history show <id> --diff --step impl[2]
steamtrain workflow history apply <id> [--step <stepId>] # merge into checkout
steamtrain workflow history apply <id> --mode branch [--branch <name>]  # deliver to a branch (or --mode pr)
steamtrain workflow history apply <id> --onconflict ours|theirs         # deterministic conflict winner
steamtrain workflow history prune <id>                   # discard worktrees + branches
steamtrain workflow worktrees                            # repo-wide: list every retained worktree/branch
steamtrain workflow worktrees prune [--older-than <days>|--run <id>|--all] [--force] [--dry-run]
```

`--diff` is non-mutating (it stages the worktree state into a throwaway
`GIT_INDEX_FILE` to diff against the recorded base commit). `apply` reuses the
exact same snapshot→stage→deliver pipeline; conflicts fail with recovery
guidance unless `--onconflict` picks a winner. Both `apply` and `prune` record
their outcome on the run record (`harvest:` line in `history show`, including
the branch/PR for branch/pr deliveries), so a run's "was this ever landed /
discarded?" status is part of its history.

The same actions are first-class in both UIs (shared `src/workflow/gc.ts`
helpers): the TUI history detail (`a` apply, `x` prune — double-press
confirmed) and the web UI's run history "Worktree changes" section (per-step
diffstat, harvest status, Apply / Merge-to-branch / Prune buttons, and
conflict-retry buttons on a 409). Repo-wide garbage collection — including
orphaned worktrees whose run record is gone — is
[`worktree-lifecycle.md`](worktree-lifecycle.md)'s subject.

## Interactions with the rest of the engine

- **Scheduling:** a merge step's `from` references count as dependencies under
  DAG scheduling, alongside `dependsOn` and template references.
- **Skips:** like a consolidator, a merge step treats skipped sources as
  absent and is skipped only when *all* of its sources were skipped.
- **Failures:** any failed source (or failed fan-out child) fails the merge
  step — nothing is merged.
- **Caching/resume:** a successful merge step is cached like any step; a
  resumed run replays it without re-applying.
- **Fan-out:** a `forEach` parent source contributes every child worktree;
  children that never ran (budget) or were skipped are ignored.
- **Doctor:** a merge step with a conflict agent counts toward the workflow's
  agent set, so preflight checks its binary like any agent step.

## Lifecycle closure (shipped 2026-07-14)

The retention model's open ends — worktrees/branches accumulating forever,
conflict failures with no in-tool recovery, and harvest actions reachable only
from the CLI — are analyzed and closed in
[`worktree-lifecycle.md`](worktree-lifecycle.md): `cleanup: true` on the merge
step, `workflow worktrees list|prune` GC, `history apply`
`--mode/--branch/--onconflict`, and harvest actions in both UIs.

## Future work this unlocks

- **Full patch viewer in the UIs (roadmap §1.1):** diffstat and harvest
  actions shipped in both UIs; inline unified diffs can grow on the same
  `GET /api/history/:id/worktrees` primitives.
- **CI mode (roadmap §1.2):** posts `history show --diff`-style patches on PRs.
