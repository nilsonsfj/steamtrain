# steamtrain documentation

## Workflows

Start here if you are new to workflow authoring:

1. [`workflow-spec.md`](workflow-spec.md) — **complete language reference** for hand-writing workflows (every step kind, loops, templates, validation)
2. [`workflow-overview.md`](workflow-overview.md) — mental model, diagrams, execution behavior, TUI/CLI usage
3. [`workflow-examples.md`](workflow-examples.md) — patterns, bundled workflow walkthroughs, recipes
4. [`mainline-pipeline.md`](mainline-pipeline.md) — the centerpiece bundled workflow: one prompt in, one reviewed PR out

Deep dives:

- [`agent-configuration.md`](agent-configuration.md) — agent instances: scopes, slash commands, and the TUI agent manager
- [`api-configuration.md`](api-configuration.md) — API instances for direct-inference `llm` steps: scopes, readiness checks, and the managers in every UI
- [`permissions.md`](permissions.md) — per-step tool permissions and sandbox profiles: `read-only` / `edit` / `full`, the per-agent enforcement matrix, and post-run workspace verification
- [`worktree-merge-back.md`](worktree-merge-back.md) — landing agent worktree changes: the `merge` step, PR mode, and history diff/apply/prune
- [`worktree-lifecycle.md`](worktree-lifecycle.md) — closing the worktree lifecycle: merge-step `cleanup`, repo-wide `workflow worktrees` GC, conflict recovery, and harvest actions in both UIs
- [`cost-and-budgets.md`](cost-and-budgets.md) — cost budgets, token accounting, and cost analytics
- [`detached-runs.md`](detached-runs.md) — detached (background) runs, the shared run queue, attach from any UI, cross-process cancel/approvals
- [`mid-run-steering.md`](mid-run-steering.md) — pause a live run, edit steps that haven't started (prompt/cmd/model/effort), and resume — from the TUI, web UI, or CLI
- [`human-in-the-loop.md`](human-in-the-loop.md) — autonomy labels, `human` steps, agent clarifying questions (`canAsk`), interactive takeover, and run notifications
- [`ci-headless.md`](ci-headless.md) — running workflows in CI: `--report json|markdown|junit`, the stable exit-code contract, and the `steamtrain/run-workflow` GitHub Action
- [`init-tour-followups.md`](init-tour-followups.md) — `steamtrain init` + `tour` review dispositions: applied, declined (with rationale), and deferred
- [`desktop-app.md`](desktop-app.md) — the Electron desktop shell around the web UI: how it runs the engine, the GUI PATH fix, and what's still to come

## Planning

- [`feature-roadmap.md`](feature-roadmap.md) — prioritized roadmap of next features and improvements
- [`desktop-roadmap.md`](desktop-roadmap.md) — where the Electron desktop shell is going: M1–M3 and what is deliberately deferred
- [`next-frontier.md`](next-frontier.md) — second-generation ideas beyond the roadmap (several partially shipped; see inline status)

## Project

- [`../README.md`](../README.md) — install, architecture, quick start
