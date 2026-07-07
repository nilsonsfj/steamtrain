# dry-run / plan preview — follow-ups

## Shipped (PR #59)
- `planWorkflow()` core function
- CLI `workflow plan` command
- Web API `POST /api/workflows/:name/plan`
- Web UI "Plan" button
- TUI Ctrl+D dry-run preview
- 25 tests

## Remaining follow-ups

### 1. Historical cost estimation
Query past run records (`aggregateCosts`) to estimate per-step and per-model costs for the plan. Show cost bands (min/avg/max) based on historical data.

### 2. TUI params support
The TUI `handlePlan` doesn't pass resolved input parameters to `planWorkflow`. If a workflow uses `{{inputs.*}}` templates, the TUI plan will render them as empty strings. Either prompt for params or read from the input form state.

### 3. `--dry-run` flag on `workflow run`
Add `--dry-run` as a flag on `workflow run` that prints the plan and exits, instead of requiring a separate `workflow plan` command.

### 4. Expanded forEach children in plan
Currently the plan shows static item counts for forEach with static items, and "dynamic" for agent-backed distributors. Could pre-render the static items to show what each child would receive.

### 5. Cost band from model list prices
Even without historical data, show estimated costs based on model pricing tables (input/output token costs per model).

### 6. Session overrides test coverage
Add tests for `planWorkflow` with session overrides applied (overridden agent/model/effort/prompt).
