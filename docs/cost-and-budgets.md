# Cost budgets, tokens & cost analytics

steamtrain tracks how much every run costs — in **USD** and in **tokens of every
type** — and lets you cap spend before a big fan-out burns real money. This is
visible in the TUI, the web UI, and the CLI, and is aggregated across history so
you can answer "which step / model is eating the budget?".

## Token accounting

Every agent reports usage in its own shape; steamtrain normalizes all of them
onto one `TokenUsage` model so the numbers mean the same thing everywhere:

| Category     | Meaning                                                        |
| ------------ | -------------------------------------------------------------- |
| `input`      | uncached prompt/input tokens (cache reads/writes excluded)     |
| `output`     | completion tokens (includes reasoning where the provider bills reasoning as output, e.g. Codex) |
| `cacheRead`  | input tokens served from the prompt cache (cheaper)            |
| `cacheWrite` | input tokens written to the prompt cache (cache creation)      |
| `reasoning`  | reasoning/thinking tokens when reported separately (a subset of `output`; never double-counted in the total) |

The **total** token count is `input + output + cacheRead + cacheWrite` —
`reasoning` is excluded because it is billed inside `output`.

Mapping per agent:

- **Claude / Amp** — from the result event's `usage` block (`input_tokens`,
  `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`).
- **Codex** — from `usage`; `input_tokens` is the *total* input, so uncached
  `input` is `input_tokens − cached_input_tokens`, and `cacheRead` is the cached
  count. `reasoning_output_tokens` maps to `reasoning`.
- **OpenCode** — from the step-finish `tokens` block (`input`, `output`,
  `reasoning`, `cache.read`, `cache.write`).

Tokens are recorded per step (`StepResult.tokens`), rolled into run totals
(`RunTotals.tokens`), and aggregated per model.

## Where it shows up

- **TUI** — the status bar shows a live `$cost · N tok` ticker while a run is in
  flight. The workflow view header shows totals plus a per-model breakdown line;
  each step row and the step-detail panel show that step's tokens.
- **Web UI** — the run status line has the same live ticker; step cards show
  per-step tokens; the run summary has a `tokens` column, a token total, and a
  **By model** table. History rows and the history detail view show the same.
- **CLI** — `workflow run` prints per-step tokens, run totals with a token
  count, and a per-model breakdown. `workflow history show <id>` shows the same
  for a recorded run.

## Cost budgets (`maxCostUsd`)

Set a USD cap and steamtrain stops scheduling **new** steps once the cap is
reached. Steps already in flight run to completion; the run ends with status
`budget-exceeded` and its cache intact.

### Workflow-level

```jsonc
{
  "name": "big-fanout",
  "maxCostUsd": 5.00,
  "phases": [ /* ... */ ]
}
```

Once the run's accumulated cost reaches `$5.00`, no new step is scheduled. The
run is recorded as `budget-exceeded`. Because completed steps are cached, raising
`maxCostUsd` and re-running **resumes** from where it stopped — prior spend from
the cache counts toward the (new) cap, so a resume won't blow past it either.

### Step-level (`forEach` fan-outs)

```jsonc
{
  "id": "review",
  "forEach": "steps.targets.items",
  "agent": "claude",
  "model": "opus",
  "maxCostUsd": 2.00,
  "prompt": "Review {{item}}"
}
```

Once this fan-out's dispatched children have spent `$2.00`, no further children
are dispatched. Undispatched children show as not-run, and a resume re-runs only
them.

Both caps are optional and independent. When a budget is hit, a
`budget_exceeded` event is emitted (surfaced live in every UI) and the run's
final `workflow_done` carries `budgetExceeded: true`.

## Analytics: `workflow costs`

```
steamtrain workflow costs [--workflow <name>] [--json]
```

Aggregates recorded spend and tokens across your run history:

- **by workflow** — total cost/tokens and run count per workflow;
- **by model** — cost/tokens per `agent/model`, biggest spender first;
- **by step** — the top step-id spenders across all runs.

Use `--workflow <name>` to scope to one workflow, or `--json` for the raw
aggregate (handy in CI or a dashboard).
