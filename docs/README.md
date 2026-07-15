# steamtrain documentation

## Workflows

Start here if you are new to workflow authoring:

1. [`workflow-overview.md`](workflow-overview.md) — mental model, diagrams, execution behavior, TUI/CLI usage
2. [`workflow-examples.md`](workflow-examples.md) — patterns, bundled workflow walkthroughs, recipes
3. [`workflow-spec.md`](workflow-spec.md) — language reference and validation rules

Deep dives:

- [`agent-configuration.md`](agent-configuration.md) — agent instances: scopes, slash commands, and the TUI agent manager
- [`api-configuration.md`](api-configuration.md) — API instances for direct-inference `llm` steps: scopes, readiness checks, and the managers in every UI
- [`worktree-merge-back.md`](worktree-merge-back.md) — landing agent worktree changes: the `merge` step, PR mode, and history diff/apply/prune
- [`worktree-lifecycle.md`](worktree-lifecycle.md) — closing the worktree lifecycle: merge-step `cleanup`, repo-wide `workflow worktrees` GC, conflict recovery, and harvest actions in both UIs
- [`cost-and-budgets.md`](cost-and-budgets.md) — cost budgets, token accounting, and cost analytics
- [`detached-runs.md`](detached-runs.md) — detached (background) runs, the shared run queue, attach from any UI, cross-process cancel/approvals
- [`mid-run-steering.md`](mid-run-steering.md) — pause a live run, edit steps that haven't started (prompt/cmd/model/effort), and resume — from the TUI, web UI, or CLI
- [`init-tour-followups.md`](init-tour-followups.md) — `steamtrain init` + `tour` review dispositions: applied, declined (with rationale), and deferred

## Planning

- [`feature-roadmap.md`](feature-roadmap.md) — prioritized roadmap of next features and improvements
- [`next-frontier.md`](next-frontier.md) — second-generation ideas beyond the roadmap: live run steering, right-sized primitives, workflows that learn

## Project

- [`../README.md`](../README.md) — install, architecture, quick start
