# The steamtrain web UI

`steamtrain --web-ui` serves a local, browser-based front end for the **same**
workflow engine the TUI and CLI drive. It's the visual counterpart to the TUI:
the same catalog, the same runner, the same on-disk resume cache, and the same
doctor gating — just laid out as a pipeline you can watch in a browser.

```bash
steamtrain --web-ui                 # http://127.0.0.1:4317
steamtrain --web-ui --port 8080     # custom port
steamtrain --web-ui --host 0.0.0.0  # bind all interfaces (e.g. a remote box)
```

The server starts listening immediately and prints its URL; agent health is
probed in the background and the picker's health chips fill in once it lands
(the page never blocks on the doctor).

## What it shows

- **Sidebar** — every workflow (bundled / user / project), tagged by source, with
  a one-line block summary (`fan-out · worker · merge …`).
- **Run bar** — the selected workflow's title/description, an input box
  (`Cmd/Ctrl+Enter` to launch), a `fresh` toggle (ignore the resume cache), a
  live elapsed timer, and a step-progress bar.
- **Pipeline canvas** — phases stack vertically (they run sequentially); within a
  phase, steps render as parallel **cards**. Each card is color-coded by block
  kind and shows:
  - status (pending → running → done/error), with a pulsing indicator while live;
  - the agent · model backing the step;
  - data-flow **inputs** (`dependsOn`) and `forEach` fan-out source;
  - the assigned work item for dynamic `forEach` children;
  - a streamed **output tail** that grows as the agent emits text;
  - duration, cost, `cached`, and gate pass/block badges on completion.
- **Run summary** — a per-step table (status · time · cost · notes) plus run
  totals once the workflow finishes.

## How it works

The browser is a thin client; all execution stays in the steamtrain process.

```
browser ──POST /api/runs──▶ run manager ──▶ Orchestrator.runWorkflow()
   ▲                              │
   └──── SSE /stream ◀── WorkflowEvent stream (folded into the pipeline)
```

| route | method | purpose |
| --- | --- | --- |
| `/` | GET | the single-page app (no build step, no client deps) |
| `/api/workflows` | GET | catalog summaries for the sidebar |
| `/api/workflows/:name` | GET | a full `WorkflowSpec` for visualization |
| `/api/workflows/generate` | POST | SSE: LLM-draft + save a workflow (`scope: user\|project`) |
| `/api/workflows/:name` | PUT | save a created/edited spec (`scope: user\|project`) |
| `/api/workflows/:name` | DELETE | delete a user or project workflow |
| `/api/meta` | GET | agents, models, efforts, health (for the create form) |
| `/api/doctor` | GET | current agent health |
| `/api/runs` | POST | `{ workflow, input, fresh? }` → `{ runId }` |
| `/api/runs/:id/stream` | GET | Server-Sent Events: each `WorkflowEvent`, then a terminal `status` frame |
| `/api/runs/:id/cancel` | POST | abort a running workflow |
| `/api/history` | GET | past-run summaries (newest first) |
| `/api/history/:id` | GET | one past run's full record (phase → step tree) |
| `/api/history` / `/api/history/:id` | DELETE | clear all runs, or delete one |
| `/api/history/:id/rerun` | POST | re-run a past run → `{ runId }` |
| `/api/history/:id/retry` | POST | retry a past run's failed steps → `{ runId, downgraded? }` |

The client folds the streamed `WorkflowEvent`s into a phase → step tree with the
same model the TUI uses (`src/tui/workflow-state.ts`), so the visualization stays
faithful to the engine's real behavior. Step results are persisted to the same
`.steamtrain/cache` directory, so a canceled web run resumes from where it left
off on the next launch — exactly like the TUI. Transient agent failures
auto-retry (a `step_retry` event renders as `↻ retry n/N` on the step), and a
step's total attempt count shows on its card when it took more than one try.

## Run history

Every completed run is recorded to `.steamtrain/history/` (the shared
`RunRecordBuilder` folds the same `WorkflowEvent` stream into one JSON record, and
the same store backs the TUI and CLI). Click **⏱ History** in the header to list
past runs; click a run to replay its pipeline — the phase → step tree, each step's
output, metrics, and the run summary — rendered with the same components a live
run uses. "Clear all" removes the on-disk records.

From a run's detail view you can **Re-run** it (same workflow + input, fresh) or
**Retry failed** (replay the steps that succeeded and re-execute only the failed
or not-run ones). Retry seeds the already-succeeded steps from the record itself,
so it works even if the on-disk cache is gone; if the workflow definition changed
since the run, retry safely falls back to a full re-run (the UI notes this).

## Scope & security

The server binds to `127.0.0.1` by default and is intended for local use; it has
no authentication. Only pass `--host 0.0.0.0` on a network you trust, since
anyone who can reach the port can launch agent runs. Runs are gated by the doctor
just like the CLI: a workflow whose agents aren't healthy returns a `400` with
the reason instead of starting.

See [`workflow-overview.md`](workflow-overview.md) for the execution model and
[`workflow-spec.md`](workflow-spec.md) for the spec fields surfaced on each card.
