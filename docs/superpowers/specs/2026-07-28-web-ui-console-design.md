# Web UI — "Console" redesign

Status: approved, not yet implemented
Date: 2026-07-28
Source: Claude Design project "Steamtrain UI Redesign" (`Steamtrain Web UI.dc.html`), direction **1b Console**

## Why

The design doc audits the shipping web UI (`1a`, a faithful recreation) and then
offers two directions. `1b` **Console** was chosen: everything on one screen,
phases as dense bands instead of card grids, and a permanent instrument rail
carrying telemetry that today exists only as a thin status line. `1c` Reader is
explicitly out of scope.

Three problems the current UI has that this fixes:

- Run telemetry (spend, tokens, cache hits, worktrees, what each runner is doing)
  is either absent or compressed into one status line.
- The arrival page overflows a 900px-tall viewport, so results scroll away from
  the totals that explain them.
- Configuration is a modal stacked over the shell, which cannot grow to hold the
  runner readiness/fix affordances that already exist in the setup panel.

The redesign also dials the brand back: the Station / Ride / Conductor / Arrival
theatrical layer is retired.

## Scope

All three `1b` screens: live run, arrival, and settings-as-a-page. Direction `1c`
is not implemented. No change to the workflow engine, the event stream, or any
API contract except the additions named in §6.

## 1. Client architecture

Today `src/web/public/app.js` is a single 6,103-line IIFE and `app.css` is 4,764
lines. This change rewrites most of the render layer, so the client is split
along the seams the new layout creates. Each file is a plain `<script defer>`
attaching to a shared `window.Steamtrain` namespace — the same pattern
`SteamtrainReducer` and `SteamtrainDiff` already use. `defer` guarantees
execution order, so no module loader is introduced.

| file | contents |
|---|---|
| `st-core.js` | state `S`, API helpers, SSE wiring, reducer folding, hash router, `h()` DOM helper, formatters |
| `st-shell.js` | header chrome, workflow rail, health chips, "Active elsewhere" |
| `st-run.js` | center pane: idle composer, phase bands, step rows, live output pane |
| `st-instruments.js` | right rail |
| `st-arrival.js` | arrival page |
| `st-settings.js` | settings page and its sections |
| `st-modals.js` | create/configure/clone, history browser, diff panels, approvals, human input |
| `st-boot.js` | wiring; calls `Steamtrain.start()` |

CSS splits on the same seams: `tokens.css`, `shell.css`, `run.css`,
`instruments.css`, `arrival.css`, `settings.css`, `modals.css`.

### Asset manifest

`app.js` and `app.css` cease to exist; the files above replace them entirely.

`PageAssetRevisions` in `src/web/html.ts` currently names four assets in four
explicit fields, and `STATIC_ASSETS` in `src/web/server.ts` repeats that list.
Seventeen assets (eight new scripts, the two existing bundles, seven
stylesheets) makes that untenable, so both derive from one exported, ordered
manifest:

- `renderIndex` emits `<link>` and `<script>` tags in manifest order with
  content-hash query strings, exactly as today.
- `STATIC_ASSETS` is built by mapping the manifest, so the immutable
  `max-age=31536000` cache headers, the `staticAssetsPresent()` startup check,
  and `missingStaticAssets()` all keep working with no change in behaviour.
- `PageAssetRevisions` becomes `Record<string, string>` keyed by filename.

`scripts/copy-assets.ts` must copy every file in `src/web/public/`, not an
enumerated list.

## 2. Design tokens

`1b` refines the existing palette rather than replacing it: flatter, darker, less
glow. Notably it **drops Space Grotesk** — every heading in `1b` is IBM Plex Sans
600 — so the Google Fonts `<link>` loses that family and `--font-display` is
retired.

```
canvas        #0c0e11      well (output)   #080a0c
rail/surface  #0e1114      header          #101317      raised  #14181d
border        #232830      border-quiet    #1b1f25      border-strong #2f3742
text          #e6eaef      muted #98a2af   dim #6c7784  faint   #3a424d
accent        #34d3c4      bright #7eefe4  dim #1c6f68
running       #4aa3ff (text #9ecbff)       done  #3fb950 (text #6ed67a)
gate/warn     #d29922                      error #f85149 (text #f0837e)
```

Each step kind gets a two-tone pair — a rule colour and a label colour — so the
kind chip in a step row reads at 10.5px uppercase: worker `#6fb1ff`/`#8fb6e0`,
consolidator `#5fe0c6`/`#7fdccb`, with equivalents defined for distributor,
gate, command, and llm. Radii collapse to 4/5/6/8/10px. The body's three-layer
radial-gradient background becomes a flat canvas.

## 3. Live run

**Header**, 46px: brand mark and wordmark in a fixed 220px cell; breadcrumb
`cwd / workflow / run id` in mono; a status pill (pulsing dot + state); then, right
aligned, the agent-health chip group (`3 ready` / `1 needs auth` / `2 absent`,
already served by `/api/doctor`), and Runs and Settings buttons.

**Left rail**, 236px: `Workflows` header with total count and a `+` button, then
rows carrying the workflow name, a lock glyph when every agent step is read-only,
and `phaseCount·stepCount`. All three come from `/api/workflows`, which already
returns `phaseCount`, `stepCount`, and a `permissions` summary. Bundled and
Project workflows are separate groups. The rail's footer is **Active elsewhere**,
listing detached and awaiting-approval runs from the live-run store.

**Center pane** has two states:

- *Idle* — the workflow's description, its variables form, the Describe textarea,
  Plan and Run, and the fresh-cache toggle. This state is not drawn in the
  mockup; it inherits today's composer, restyled to the new tokens.
- *Running* — phase bands take the pane. The header strip above them switches
  from composer to elapsed time, a two-segment progress bar (done / in-flight),
  step count, and Pause / Detach / Cancel.

A **phase band** is a header row — `01`, status dot, title, `3 steps parallel`,
and a right-aligned `time · cost · tokens` rollup — over step rows laid out on a
fixed nine-column grid:

```
14px  150px  96px  168px  1fr  62px  68px  92px  20px
dot   id     kind  agent  meta time  cost  tok   chevron
```

`meta` carries the worktree branch and whatever else is true of the step:
findings count, `cached`, retry count. Numeric columns are right-aligned with
`font-variant-numeric: tabular-nums`.

Exactly one band is expanded at a time — the running band, or the one whose step
the user selected — and it grows to host the **live output pane**: a `following`
indicator, Wrap / Copy / Full step controls, and the step's text in the dark
well. Every other band stays collapsed to its rows. Queued phases collapse
further, to a single header line. The chevron on a row still opens the existing
step drill-in drawer; that interaction is unchanged.

**Right rail**, 300px, five stacked instruments: Spend, Throughput, Runners in
flight, Worktrees, Event log. Detailed in §5.

## 4. Arrival

A `minmax(0, 1fr) 420px` grid under the same header.

Left: a status kicker (`Complete`), the run timestamp and duration, the headline
from the arrival report, four stat cells (elapsed, cost, tokens, steps ok/failed),
and Run again / Export. Below the rule, the report body renders as severity-labelled
rows — a 74px severity column beside the finding text and its `file:line`.

Right: the **step ledger**, a `12px minmax(0,1fr) 54px 62px` table of every step
with its kind, model, time, and cost, and cached/gate state inline. Its footer
carries the run totals the ledger cannot: sandbox (`5 read-only · 0 violations`),
worktrees (`4 merged back · 0 left`), retries.

Both columns scroll independently inside the viewport. This is what resolves the
overflow the audit calls out: the receipt and the totals that explain it stay on
screen together.

## 5. Instrument rail

Four of the five instruments read directly off reducer state and the SSE stream:

- **Spend** — accumulated `costUsd`, with a budget bar and `/ $N budget` label
  shown only when the running workflow's spec declares `maxCostUsd`. That field
  is per-workflow, not global config, so the bar is conditional by design.
- **Runners in flight** — grouped from running steps' `agent`/`model`, with idle
  runners and queued counts derived from pending steps.
- **Worktrees** — from `StepState.worktree`, landed live by the `step_workspace`
  event. The `+N` diffstat is only available post-run today; live rows render the
  branch without it rather than showing a fabricated zero.
- **Event log** — events off the SSE stream, timestamped relative to run start.
  The client retains the most recent 200 and the rail shows as many as fit,
  newest first.

Two instruments have no data behind them today and are derived client-side:

- **Throughput** — cumulative token totals sampled on a fixed tick into a 60s
  ring buffer, rendered as the 12-bar sparkline. Measured, not modelled.
- **Projected cost** — `spend ÷ completed steps × total steps`, rendered under a
  "Projected" label so it reads as an estimate. This is a heuristic and will be
  wrong on workflows whose steps differ greatly in cost; that caveat is recorded
  in the code and in `docs/web-ui.md`.

## 6. Settings

New hash routes `#settings` and `#settings/<section>`, parsed in
`src/web/run-deep-link.ts` alongside the existing run deep links. `parseDeepLink`
gains a discriminated result so the router can tell a run link from a settings
link; `parseRunDeepLink` keeps its current signature and behaviour.

Layout: 236px left nav plus a content pane with a section header, its table, and a
dirty-state footer (Discard / Save changes). A note under the nav states that
edits apply to global scope by default and that a row switched to project scope
is written into `./steamtrain.json`.

The mockup draws seven sections. Only those with a real config API behind them
ship:

- **Runners** — agents and API endpoints in one table: status dot, name, kind,
  binary/endpoint with version and extra args, default model, scope, edit/delete.
  `/api/config` already tags every agent and API with global-vs-project scope, so
  the `scope` column is real. Not-ready rows expand inline with the doctor's
  `fixCommand`, a copy button, and Recheck — absorbing today's separate setup
  panel. Backed by `GET`/`PUT /api/config` and `GET`/`POST /api/doctor`.
- **Limits & budget** — step timeout and workflow timeout, both already accepted
  by `PUT /api/config`.

Model bindings, Permissions, Access & sharing, Notifications, and Cache &
worktrees are **not** in the nav. Each would need a config API that does not
exist. Rendering them as dead tabs would be worse than omitting them; adding them
is separate work.

The existing config modal and setup panel are removed once the page replaces
them.

## 7. Retired

- `renderStationAtmosphere`, `renderStationHero`, `renderConductorStage`,
  `renderYardTrack`, `renderTrackStrip`, and the theatrical staging inside
  `renderArrival`.
- The `departing` / `riding` mode machinery and `document.body.dataset.mode`.
- Roughly 1,400 lines of Station / Ride / Conductor / Arrival CSS, and the
  animated engine SVG, steam, rails, signal, and platform layers.
- `--font-display` and the Space Grotesk font request.

The tour workflow itself is untouched — only its bespoke presentation goes. It
runs through the Console like any other workflow.

## 8. Must keep working

Each gets an explicit verification step during implementation:

configure / clone / create modals · run history browser · unified diff viewer ·
approval checkpoints · human input (human steps and agent clarifying questions) ·
sub-workflow "what runs inside" · prompt-history recall (↑/↓) · read-only session
mode · narrow-screen layout · `prefers-reduced-motion` · the `#announcer` live
region · run and approval deep links.

## 9. Testing

- Manifest: every asset in the manifest resolves on disk, and `renderIndex`
  emits them in manifest order with cache-busting revisions.
- `parseDeepLink` distinguishes run links from settings links, rejects malformed
  section names, and leaves `parseRunDeepLink` behaviour unchanged.
- Throughput ring buffer and the projected-cost helper are pure functions and
  unit-tested directly, including the zero-completed-steps case.
- Existing web tests (`web-approval`, `web-detach`, `web-human-input`,
  `web-live-runs`, `web-loops`, `web-pause`, `web-rerun-retarget`,
  `web-server`) assert API behaviour rather than markup and are expected to pass
  unchanged. Any that turn out to assert on retired DOM are updated, not deleted.

## 10. Docs

`docs/web-ui.md` gains a description of the Console layout and the derived-telemetry
caveat. `TUI-WEBUI-DIFFERENCES.md` gains a dated entry recording that the web UI
moved to the Console layout and that configuration became a page, since that
widens the gap with the TUI's modal-based managers.
