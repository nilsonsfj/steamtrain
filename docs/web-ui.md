# The steamtrain web UI

`steamtrain --web-ui` serves a local, browser-based front end for the **same**
workflow engine the TUI and CLI drive. It's the visual counterpart to the TUI:
the same catalog, the same runner, the same on-disk resume cache, and the same
doctor gating — just laid out as a pipeline you can watch in a browser.

```bash
steamtrain --web-ui                 # http://127.0.0.1:4317
steamtrain --web-ui --port 8080     # custom port
steamtrain --web-ui --host 0.0.0.0  # bind all interfaces — auth token auto-generated
steamtrain --web-ui --host 0.0.0.0 --auth-token s3cret   # your own full token
steamtrain --web-ui --host 0.0.0.0 --auth-token s3cret --read-token view-only
STEAMTRAIN_AUTH_TOKEN=s3cret steamtrain --web-ui --host 0.0.0.0  # token via env
steamtrain --web-ui --read-only     # localhost share: view workflows/runs, no writes
```

If port 4317 is already taken, steamtrain exits with a clear message and suggests
`--port` instead of crashing with an `EADDRINUSE` stack trace.

The server starts listening immediately and prints its URL; agent health and
llm-API readiness are probed in the background and the header's health chips
fill in once they land (the page never blocks on the doctor). Every chip is a
button: click one to open the **Agent & API setup** panel, which lists each
agent and endpoint with its status and — for anything not ready — the exact
fix with a one-click copy and a Recheck button (the browser analog of
`steamtrain init`'s readiness table). A chip names what it counted —
`ready · 2 agents + 1 API` — and runners that aren't installed get no chip at
all, so the header stays calm on a fresh machine. Settings → **Runners**
manages both [agent instances](agent-configuration.md) and the
[API instances](api-configuration.md) direct-inference `llm` steps call: each
row has an **on/off** switch and an **Edit** editor, ready runners sort first
and disabled ones last. Agent and API edits default to **global** scope
(`~/.steamtrain/config.json`), matching the TUI `/agent` / `/api` commands; each
row can opt into project scope (`./steamtrain.json`). Timeouts live under
Settings → **Limits & budget** and still write to the project file.

## What it shows

### The Console: three columns, one expanded band

The web UI is a persistent three-column cockpit — there is no separate
"landing" mode and no full-bleed takeover for any workflow, including the
free `tour`. Every workflow runs through the same layout:

- **Workflow rail** (left) — every workflow (bundled / user / project), tagged
  by source, with a one-line block summary (`fan-out · worker · merge …`).
  `+` opens the Create-workflow form.
- **Run pane** (center) — the selected workflow's title/description/actions
  (Configure, Clone), the composer (Describe box, Plan/Run, `fresh` toggle),
  and the **pipeline canvas**: one **band** per phase instance, stacked in run
  order. A band's identity is **`phaseId:iteration`, not bare `phaseId`** — a
  loop that re-enters a phase (a bounded gate loop-back, a review→fix cycle)
  produces one band per iteration rather than all iterations collapsing into a
  single band that keeps overwriting itself. A queued phase collapses to its
  header line; a done phase lists its steps with final status/cost/tokens.
  **Exactly one band is expanded at a time** — the running phase, or whichever
  step's row the reader clicked — and only the expanded band hosts the live,
  follow-the-stream **output pane** (scroll up to pause following, back to the
  bottom to re-engage). A `workflow`-call step's row carries a "what runs
  inside" expander: a rollup line plus the resolved child spec's steps and the
  models that actually run them (overrides applied), recursing into nested
  sub-workflows.
- **Instrument rail** (right) — live run telemetry; see below.

Clicking any step row also opens the **step drill-in drawer**: runner,
worktree branch + directory, start time, live elapsed / final duration, cost,
tokens, exit code, data-flow inputs, and the step's full output in a
scrollable follow-the-stream pane with one-click copy. `Esc` closes it.

A completed run replaces the pipeline canvas with the two-column **Arrival**
page: a headline, receipt cards (ran / cost / produced), the per-step ledger,
worktree changes, and destinations ("Run again", "Export"). The engine's
`arrivalReceiptCards()` returns plain `{id, label, value}` facts — it has **no
severity field** — so this is a plain fact ledger, not a severity-graded
report; if a workflow's own report happens to mention severities (bug-hunt's
consolidator prose, say), that is the workflow's text, not structured data the
page renders or grades on.

Settings (agents, APIs, timeouts/budget) is a real **page**, not a modal —
see [Settings](#settings) below.

### Instrument rail: derived telemetry

The engine's event stream carries per-step cost and token totals but no rate
and no forecast, so the instrument rail derives both client-side
(`src/web/telemetry.ts`, shared with the reducer bundle so both the logic and
its tests live in one place):

- **Throughput is measured, not modeled.** A timer samples the run's
  cumulative token total every 2 seconds and keeps a rolling 60-second window
  of those samples; the sparkline bars are tokens/second between consecutive
  samples, normalized against the busiest interval currently in the window.
  It goes to zero once nothing has been sampled recently — there is no decay
  curve or smoothing, just the measured rate.
- **Projected cost is an explicit heuristic, not a forecast:**
  `spend ÷ completed steps × total steps`. It assumes the remaining steps cost
  about what the finished ones did on average. That assumption is wrong for
  any workflow whose step costs differ a lot — a cheap gate step running after
  an expensive scan step will pull the projection in whichever direction the
  finished steps happen to skew. Treat it as a rough budget trip-wire, not a
  bill. The instrument rail also shows Spend, Tokens, Cache hits, runners
  currently in flight (busy steps only — idle catalog agents are omitted),
  active worktrees, and a capped (200-entry), newest-first event log — all
  read directly off the event stream, not derived.

### Settings

Click **Settings** in the header to open the settings page (it replaces the
cockpit in `#center`, not a modal overlay, and is deep-linkable via
`#settings/<section>`). The source design draws seven settings sections; only
**two ship — Runners and Limits & budget** — because those are the only two
with a real config API behind them. This is a deliberate scope decision, not
an oversight: the other five (model bindings, permissions, access & sharing,
notifications, cache & worktrees) have no persistence layer to write to, so
rendering them would mean dead tabs that accept input and silently do
nothing. They stay off the nav until a config API exists for them.

Under the runner table, Runners carries the two dials that govern how runners
are *used* rather than which ones exist:

- **Concurrency** — the ceiling on steps run in parallel within a phase
  (`maxConcurrency`). The slider's bounds come from the server, so it can never
  offer a number the config schema would reject. It shares the section's
  Save/Discard: nothing is written until you save, and the value is only sent
  when it actually moved (agents/APIs default to the global file, while
  `maxConcurrency` is project-scoped — sending it unchanged would rewrite
  `steamtrain.json` on every runner save).
- **Health checks** — how often runner availability is re-probed: **Manual**
  (only the Recheck all button), **On launch** (re-probe as the launch sheet
  opens, so its skip predictions and runner counts are current), or **Every
  60s**. This is a viewing preference for one browser — it changes what this
  tab asks for, never what a run reads — so it lives in `localStorage`, not in
  config. Viewers never get the timer: `POST /api/doctor` is a control-plane
  write.

`GET /api/config` — which the Runners/Limits sections need to render current
values — is **blocked for read-only sessions** (its payload carries agent
`env`, `extraArgs`, and binary paths, which the read-token contract treats as
privileged). The settings page degrades accordingly for a read-only session:
it never issues the request in the first place, and renders no write
controls — there is nothing to fall back to, by design, not a silent failure.

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
| `/api/meta` | GET | agents + APIs, models, efforts, health (for the create form) |
| `/api/doctor` | GET | current agent health (`doctor`) and llm-API readiness (`apis`) — the last snapshot (fixed at startup + config save) |
| `/api/doctor` | POST | re-run the probes now (setup panel Recheck): re-resolve every agent binary + re-probe every API, persist, and return the fresh `{ doctor, apis }` |
| `/api/runs` | POST | `{ workflow, input, freshCache?, freshWorktrees?, maxParallel? }` → `{ runId }` (`freshCache` ignores the step cache; `freshWorktrees` discards the previous run's retained trees) |
| `/api/runs` | GET | in-flight run registry: server-owned runs merged with external (CLI `--detach` / TUI) runs from `.steamtrain/runs/`, including queued/paused state and pending approval/input summaries |
| `/api/runs/:id/stream` | GET | Server-Sent Events: each `WorkflowEvent` (plus non-terminal `queued` frames), then a terminal `status` frame; tails externally-owned runs from the live-run registry |
| `/api/runs/:id/cancel` | POST | abort a running workflow (external runs: drops the registry's cancel marker) |
| `/api/runs/:id/pause` / `/api/runs/:id/resume` | POST | mid-run steering: stop scheduling new steps / continue (external runs: via the registry's control files) |
| `/api/runs/:id/edit-step` | POST | `{ stepId, prompt?/cmd?/model?/effort?/permissions? }` — edit a not-yet-started step while paused (`permissions` clamps its sandbox profile; `""` clears it); engine-validated ([mid-run-steering.md](mid-run-steering.md), [permissions.md](permissions.md)) |
| `/api/runs/:id/kill-step` | POST | `{ stepId }` — fail one running step and let the run carry on ([mid-run-steering.md](mid-run-steering.md)). Manager-owned runs only: a detached run's steps belong to the process running them |
| `/api/workflows/:name/lint` | POST | `{ spec? }` → `{ issues: [{ stepId, issue }] }` — the source view's warning gutter, from the same readiness the launch sheet uses |
| `/api/runner-usage` | GET | `{ runs, counts, available }` — recorded runs each runner worked in, for the settings table's Runs column |
| `/api/history` | GET | past-run summaries (newest first) |
| `/api/history/:id` | GET | one past run's full record (phase → step tree) |
| `/api/history` / `/api/history/:id` | DELETE | clear all runs, or delete one |
| `/api/history/:id/rerun` | POST | re-run a past run → `{ runId }` |
| `/api/history/:id/retry` | POST | retry a past run's failed steps → `{ runId, downgraded? }` |
| `/api/auth` | POST | `{ token }` → creates a session, sets the auth cookie (when auth is enabled); returns `{ capability: "full"|"read" }` |
| `/api/session` | GET | `{ authRequired, capability, readOnly }` — SPA chrome / capability probe |
| `/api/logout` | POST | revokes the presented session and clears the auth cookie |

The client folds the streamed `WorkflowEvent`s into a phase → step tree with the
shared `workflowReducer` (`src/workflow/reducer.ts`), bundled for the browser
as `/static/steamtrain-reducer.bundle.js`, so the visualization stays
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

From a run's detail view you can **Re-run** it (same workflow + input, fresh),
**Retry failed** (replay succeeded steps and re-execute only failures), or
**Retry with agent…** (same as retry-failed, but force failed agent steps onto a
chosen agent/model, optionally narrowed to specific steps). Retry seeds
already-succeeded steps from the record itself, so it works even if the on-disk
cache is gone; if the workflow definition changed since the run, a plain retry
safely falls back to a full re-run (the UI notes this). Retarget / step filters
refuse that downgrade instead of silently applying to a full re-run.

## Scope & security

The web UI is a **privileged control plane**: whoever reaches it can launch
agent runs with your credentials, edit and delete workflows, and read run
history. The server hardens both of its modes accordingly.

**Local mode (the default).** `steamtrain --web-ui` binds `127.0.0.1` and
needs no token — the frictionless path. It still defends against the two ways
a hostile *website* can reach a localhost server through your browser:

- **DNS rebinding** — requests whose `Host` header is not a loopback name
  (`localhost`, `127.0.0.1`, `[::1]`, or the bind host) are rejected with
  `403`, so a domain rebound to `127.0.0.1` gets nothing.
- **Drive-by CSRF** — state-changing requests carrying a cross-origin
  `Origin`/`Referer` are rejected in every mode. Browsers always attach
  `Origin` to cross-site fetches, while `curl`-style local scripting (which
  sends neither header) keeps working untouched.

**Exposed mode.** Binding a non-loopback host (`--host 0.0.0.0`, a LAN
address, …) requires authentication. If you don't pass a token, one is
auto-generated and printed at startup — an exposed server is never silently
open. Supply your own with `--auth-token <token>` or the
`STEAMTRAIN_AUTH_TOKEN` environment variable (which keeps it out of `ps` and
shell history), or explicitly opt out with `--no-auth` on a network you fully
trust.

**Read-only / share mode.** A second credential, `--read-token` (or
`STEAMTRAIN_READ_TOKEN`), mints a **viewer session**: every `GET` works
for workflows, history, live attach + SSE (and `POST /api/logout` still ends
the session), but every other state-changing route — and `GET /api/config`
(which embeds agent `env` / `extraArgs`) — returns `403 read-only session`.
Keep the full `--auth-token` for yourself and hand teammates the read token.
`--read-only` forces *every* session (including ones minted from the full auth
token, and the no-auth localhost path) into viewer capability — useful for a
dedicated share bind. On a non-local `--read-only` bind with no tokens, the
auto-generated credential is a read token. The full and read tokens must be
different values (including after env resolution).

With auth enabled:

- `POST /api/auth` exchanges the token for a **random server-side session**
  (`HttpOnly`, `SameSite=Strict` cookie, 7-day expiry, revoked by
  `POST /api/logout` and on process restart). The cookie never encodes the
  token itself. The response includes `capability: "full" | "read"` so the
  SPA can hide Run / authoring / harvest / approval controls.
- Failed logins are **rate limited** per client address (10 per minute, then
  `429`).
- State-changing requests must carry a same-origin `Origin` or `Referer`.
- The landing page and `/static/*` assets stay public; every `/api/*` route
  returns `401` without a session.
- A read-only session still sees **full step outputs and run history** — treat
  the read token like access to this project's run artifacts, not a public
  internet share.

**Behind a reverse proxy.** The server speaks plain HTTP; for exposure beyond
a trusted network put it behind a TLS-terminating proxy and pass
`--trust-proxy`. `X-Forwarded-*` headers are **client-controllable and ignored
by default** — a browser can set `X-Forwarded-Host` on a rebound same-origin
request — so they are honored only under `--trust-proxy`, which you set when
*you* run the proxy that overwrites them. With it enabled: `X-Forwarded-Proto:
https` marks the session cookie `Secure`, `X-Forwarded-Host` drives origin
comparison and lifts the loopback `Host` allowlist, and `X-Forwarded-For`
identifies the client for login rate limiting. SSE responses always send
`X-Accel-Buffering: no` so proxies don't buffer the event stream.

Runs are gated by the doctor just like the CLI: a workflow whose agents aren't
healthy returns a `400` with the reason instead of starting.

See [`workflow-overview.md`](workflow-overview.md) for the execution model and
[`workflow-spec.md`](workflow-spec.md) for the spec fields surfaced on each card.
