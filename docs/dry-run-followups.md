# dry-run / plan preview — follow-ups

## Shipped (PR #59)
- `planWorkflow()` core function
- CLI `workflow plan` command
- Web API `POST /api/workflows/:name/plan`
- Web UI "Plan" button
- TUI Ctrl+D dry-run preview
- 25 tests

## Follow-up dispositions (updated 2026-07-15 — all items closed)

### 1. Historical cost estimation — shipped (run-level)
`planHistoryContext` (`src/workflow/plan.ts`) aggregates completed recorded
runs of the planned workflow; the CLI `workflow plan` prints a
`history: N completed runs · avg cost … (range …) · avg duration …` line and
includes a `history` object in `--json` output. Run-level (not per-step)
aggregation is deliberate: per-step attribution of loop iterations and
fan-out children across spec edits is noisy, and `workflow costs` already
answers the per-step question for those who want it. The TUI/web plan views
don't show the line yet — `planWorkflow` stays pure and history-free, so
adding it there is a rendering decision, not a plumbing one.

### 2. TUI params support — shipped (PR #78)
The TUI plan preview passes resolved input params to `planWorkflow`.

### 3. `--dry-run` flag on `workflow run` — shipped
`workflow run <name> … --dry-run` prints the plan and exits (identical output
to `workflow plan`); run-only execution flags (`--fresh`, `--detach`,
`--approve-all`, `--on-approval`) are dropped since a dry run never executes.
`workflow dry-run` also exists as a top-level alias for `workflow plan`.

### 4. Expanded forEach children in plan — declined
Pre-rendering each static item's child prompt inflates the plan output
(hundreds of near-identical prompt blocks for a large distributor) for little
signal beyond the existing `fan-out: <step> → <source> (N items)` line plus
the parent's rendered prompt. Revisit only if users ask to preview a
*specific* child's prompt.

### 5. Cost band from model list prices — declined
A price table without a token estimate is a guess dressed as a number: agent
steps' token usage is dominated by tool-call transcripts that can't be
predicted from the prompt. Real recorded history (item 1) answers the same
question honestly. Declining keeps the plan trustworthy.

### 6. Session overrides test coverage — shipped (PR #79)
`planWorkflow` with overridden agent/model/effort/prompt is covered in
`tests/workflow-plan.test.ts`.
