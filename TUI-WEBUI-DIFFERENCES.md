# TUI ↔ Web UI feature differences

Purpose: catalog where the terminal UI (`src/tui`) and the browser UI (`src/web`)
diverge in workflow **authoring, configuration, and running**, so we can later
make both UIs thin *views* over one shared foundation rather than two parallel
implementations.

This is a working document. The end state we're aiming for: a single
"workflow session / authoring" core that the TUI and the web server both drive,
with each layer owning only presentation + input handling.

Updated 2026-07-29: the web UI was rebuilt as the **Console** — a persistent
three-column cockpit (workflow rail · run pane · instrument rail) replacing the
old Station/Ride/Conductor theatrical layer; the tour workflow now runs through
the same cockpit as every other workflow, landing on a two-column Arrival page.
Configuration became a real **page** (`Settings`, its own route) instead of a
modal, which **widens** the TUI gap in §2/§4 below: the TUI's `/agents`
(Ctrl+A) and `/apis` managers are still modal overlays, so "manage agent/API
instances" is now ✅/✅ in capability but ⚠️ in presentation — a page you can
deep-link to and leave open beside a run vs. a modal that blocks the rest of
the screen. The new **instrument rail** (live spend/projected-cost/tokens/
cache-hit meters, a measured throughput sparkline, per-runner busy/idle status,
active worktrees, and a capped event log) is web-only — the TUI has no
persistent equivalent, only what fits in the status bar and doctor panel.

Updated 2026-07-21: agent/API **setup** reached parity and became actionable in
both UIs. The doctor now attaches a structured `fixCommand` (install / login /
`export <ENV>=…`) to each not-ready result. TUI: the `/agents` (Ctrl+A) and
`/apis` managers show per-row readiness + version, an inline fix for the
selected not-ready entry, a readiness summary, and `r` to recheck. Web: header
health chips are buttons that open a new **Agent & API setup** panel (each
agent/endpoint's status + fix + one-click copy + Recheck + Edit-config link);
`binary_missing` / `key_missing` collapse into one quiet chip instead of a wall
of red; the config modal leads with agents and links to the setup panel.

Updated 2026-07-20: both UIs gained bulk step retargeting — Web Configure has
a "Retarget all agent steps" bar plus per-step "Use for all"; TUI Ctrl+E
accepts `A` to apply the current agent/model/effort to every agent-backed
step, and `/set-all <agent> [model] [effort]` (plus `/agent|/model|/effort
… --all`) stages the same overrides. Mid-run editors now expose model/effort
alongside prompt/cmd.

Last updated: 2026-07-22.

Updated 2026-07-22 (sub-workflow experience): `workflow` (sub-workflow) steps
became transparent and controllable in both UIs. A new
`WorkflowCallStep.overrides` field carries per-child-step agent-field patches
(keys may be `::`-namespaced to reach nested sub-workflows) that the engine
layers onto the resolved child at run time — the shared child spec on disk is
never mutated. `applyWorkflowStepOverrides` is now namespace-aware (a
`<workflowStepId>::<childStepId>` override key routes onto the call step's own
`overrides`), so `/set-all`, `/agent|/model --all`, and the web bulk/per-step
retargeting **cascade into sub-workflows**. `listRetargetableSteps(spec,
resolve)` recurses into resolvable sub-workflows; a shared
`describeSubWorkflow` (`src/workflow/sub-workflow-view.ts`) resolves a call
step into its effective structure (steps, the models that actually run,
autonomy, override count). TUI: the preview row shows a resolved rollup and
the detail panel unfolds the child's steps with their effective targets and an
override marker. Web: the pipeline card gets an expandable "what runs inside"
block, the config modal renders nested per-child-step editors that cascade
(and are included in "Retarget all"), and `GET /api/workflows/:name` now ships
the transitively-resolved `children` specs. The shared helpers
(`describeSubWorkflow`, `subWorkflowRollup`, `applyWorkflowSessionOverrides`,
…) are exported into the browser reducer bundle so both UIs use the same code.

Updated 2026-06-16 (after the first unification pass in
`feat/unify-workflow-authoring`: the authoring core is now shared).
Updated 2026-06-28: web client code + reducer bundle now live as real files
under `src/web/public/` and are served at `/static/*` (no longer embedded in
`src/web/html.ts`).
Updated 2026-07-10: the TUI gained an in-place step editor (Ctrl+E in the
workflow preview → `WorkflowStepEditor`) for agent/model/effort/prompt, on top
of the existing slash commands.
Updated 2026-07-10 (run visibility): both UIs gained a live step drill-in with
the full scrollable output, per-step live timers, and worktree visibility, fed
by a new shared `step_workspace` event and `startedAt`/`endedAt`/`worktree`
fields on the shared reducer's `StepState`.
Updated 2026-07-14 (worktree lifecycle): both UIs gained post-run worktree
harvest (apply/prune from history) with diffstat.
Updated 2026-07-25 (graphical diffs): both UIs render code-review-style inline
unified diffs of a run's worktree changes off a shared parser
(`src/workflow/unified-diff.ts`). Web: each worktree step in the history detail
expands into a lazily fetched, cached, per-file-collapsible diff panel
(`src/web/diff-view.ts`, bundled as `SteamtrainDiff`), and approval checkpoints
gain a collapsible "View diff". TUI: history detail opens a full-screen,
scrollable run diff with `v` (per-step patches, dual line-number gutters,
status badges). The CLI `workflow history show <id> --diff` stays the uncapped
surface; the UIs cap very large diffs and say so inline.
Updated 2026-07-15: the web run input gained ↑/↓ prompt-history recall
(localStorage-backed, recorded on Run/Plan) — closing the last documented
feature gap in §4. The TUI gained `/help` (keys + command list overlay) and an
unknown-slash-command guard; both are TUI-only by design (the web UI is
button-driven and has no command line).
Updated 2026-07-30 (web run browser): the web's run history moved out of its
full-screen modal and became a page at `#runs` (`src/web/public/st-runs.js`),
matching the shell the cockpit and Settings already use — a 236px status +
workflow filter rail, the run table, and a 340px receipt rail that a row click
selects into. The old modal's deep view survives as that page's **Full
receipt** (same hero, per-model costs, worktree lifecycle, and phase tree, now
in the centre pane rather than over it), and the page adds run comparison and
JSON export, which the TUI does not have. `#run-<uuid>` links still work: a
live run attaches in the cockpit as before, a recorded one now opens here.

---

## 1. Shared foundation (already common)

Both UIs already sit on the same lower layers — this is the part that's done
right and should expand:

| Module | Responsibility | Used by |
| --- | --- | --- |
| `src/orchestrator` | catalog access, dispatch gating, run streaming | TUI + web |
| `src/workflow/engine.ts` | `runWorkflow` → `WorkflowEvent` stream | both (via orchestrator) |
| `src/workflow/catalog.ts` | load/merge catalog, `saveUserWorkflow`, `deleteUserWorkflow`, `saveSessionWorkflowsToUser` | both |
| `src/workflow/authoring.ts` | **`WorkflowAuthor`**: generate + edit + clone + delete + staged overrides/flush, behind `AuthoringHost` | **both** (web: Orchestrator; TUI: React-state adapter) |
| `src/workflow/generate.ts` | `generateWorkflow` (LLM → validated spec) | both (via `WorkflowAuthor`) |
| `src/workflow/overrides.ts` | `applyWorkflowStepOverrides` | both (via `WorkflowAuthor.previewWithOverrides`) |
| `src/workflow/types.ts` | spec schema + `validateWorkflow` | both |
| `src/agents/agent-meta.ts` | `buildAgentMeta` / `defaultDraftModel` — the agent→model→effort→default→health view-model | both (web via `/api/meta`; `WorkflowAuthor.agentMeta`) |
| `src/agents/models.ts` | `modelsForAgent`, `effortsForModel`, defaults | TUI menus directly; the shared view-model wraps it |
| `src/apis` | `resolveApiInstances` / `buildApiMeta` / `resolveLlmStepApi` — the API-instance view-model for direct-inference `llm` steps | both (web via `/api/meta` + `/api/config`; TUI manager + status bar) |
| `src/workflow/live-run-store.ts` + `live-run.ts` | the shared live-run registry (`.steamtrain/runs/`): detached runs, attach tailing, the `maxParallelRuns` queue, cross-process cancel/approvals | all three (CLI `run/attach/runs/cancel/approve`; TUI runner + `/attach`; web run manager + `/api/runs*`) |

`WorkflowAuthor` (formerly `src/web/authoring.ts`) moved into `src/workflow`
and is now the single authoring core both frontends drive — see §5.

Both UIs also fold the **same `WorkflowEvent` stream** into a phase→step render
model via the shared `workflowReducer` in `src/workflow/reducer.ts` (the TUI
imports it through `src/tui/workflow-state.ts`; the web bundles it as
`/static/steamtrain-reducer.bundle.js`).

---

## 2. Feature matrix

✅ present · ⚠️ partial / different · ❌ absent

| Capability | TUI | Web | Notes |
| --- | :---: | :---: | --- |
| Browse workflows (bundled/user/project) | ✅ | ✅ | |
| View pipeline / step details | ✅ | ✅ | Web lays phases out as a vertical pipeline with parallel cards |
| Run a workflow + live progress | ✅ | ✅ | |
| Live step drill-in: full scrollable output | ✅ | ✅ | TUI: →/Enter on a step, PgUp/PgDn scroll with follow mode; Web: click a card → drawer with follow-the-stream output pane |
| Live per-step timers + worktree visibility | ✅ | ✅ | Shared `step_workspace` event + `startedAt` in the reducer; both UIs show the worktree branch/dir and a ticking per-step elapsed |
| Fresh run (ignore cache) | ✅ | ✅ | |
| Cancel a run | ✅ | ✅ | |
| Attach to any in-flight run (cross-process) | ✅ | ✅ | Shared `.steamtrain/runs/` registry; TUI `/attach` + run browser, web Active runs panel |
| Pause / edit / resume a live run | ✅ | ✅ | TUI `p`/`e`, web Pause + step-edit modal; cross-process via control files (`mid-run-steering.md`) |
| Detach a running run into the background | ✅ | ✅ | TUI `d`, web **Detach**, `POST /api/runs/:id/detach`; abort-and-hand-off under the same id so detach is immediate and the run survives closing the UI (`detached-runs.md`) |
| Resume from on-disk cache | ✅ | ✅ | |
| Create workflow via LLM draft | ✅ | ✅ | Different draft-target selection (below) |
| Choose drafting agent/model | ✅ | ✅ | TUI: `/model` + `/effort` on the picker sets a session draft override; Web: per-draft agent/model/effort selects in the create modal |
| Per-step **agent** override | ✅ | ✅ | TUI: `/agent` **or** the in-place step editor (Ctrl+E in preview, ←/→ to cycle); Web modal |
| Per-step **model** override | ✅ | ✅ | TUI: `/model` **or** step editor (Ctrl+E); Web modal |
| Per-step **effort** override | ✅ | ✅ | TUI: `/effort` **or** step editor (Ctrl+E); Web modal |
| Per-step **prompt** editing | ✅ | ✅ | TUI: `/prompt <text>` **or** step editor (Ctrl+E → Enter on the prompt field); Web modal |
| Per-step **permissions** (sandbox profile) | ✅ | ✅ | TUI: `/permissions [read-only\|edit\|full\|clear] [--all]`; Web: **Permissions** select per step in the configure modal (save or "Try without saving"). Both surface the profile badge + enforcement per step, and the run's sandbox summary before launch (`permissions.md`) |
| Clamp a pending step's sandbox mid-run | ✅ | ✅ | TUI: `p` then `e` → sandbox row (←/→); Web: paused step card → **Edit step** → Permissions; CLI `workflow edit-step --permissions` (`mid-run-steering.md`) |
| In-place step editor | ✅ | ✅ | TUI: Ctrl+E on a selected preview step opens `WorkflowStepEditor` (↑/↓ field · ←/→ change agent/model/effort · Enter edit prompt); stages the same session overrides as the slash commands. Web: per-step configure modal |
| Edit workflow **name** | ✅ | ✅ | TUI `/rename-workflow <old> <new>`; Web modal |
| Edit workflow **description** | ✅ | ✅ | TUI `/describe-workflow <name> <desc>`; Web modal |
| Clone / duplicate a workflow | ✅ | ✅ | Both via `WorkflowAuthor.clone`; TUI `/clone-workflow [--project] <new-name>` |
| Delete a user or project workflow | ✅ | ✅ | Both via `WorkflowAuthor.remove`; TUI `/delete-workflow <name>` (bundled still guarded) |
| Author into the **project** layer (`steamtrain.json`) | ✅ | ✅ | Shared `WorkflowScope`; create/clone/save target user or project. CLI: `workflow create --scope project`; TUI: `--project`; web: scope selector |
| Stage overrides *without* persisting | ✅ | ✅ | TUI session overrides (now flushed via `WorkflowAuthor.flushSessionOverrides`); web "Try without saving" stores session overrides |
| Explicit "save session changes" step | ✅ | ✅ | TUI `/save-workflows` → shared flush; web "Flush to disk" button calls `POST /api/overrides/flush` |
| Skip/unchanged reporting on save | ✅ | ✅ | `flushSessionOverrides`/`saveSessionWorkflowsToUser` returns saved/skipped/unchanged; both TUI and web surface the report |
| Agent health display | ✅ | ✅ | TUI doctor panel + per-row readiness in the agent manager; web health chips |
| Actionable readiness fixes + recheck | ✅ | ✅ | Both surface the install/login fix (structured `fixCommand` on doctor results) and re-run the doctor on demand. TUI: fix line + `r` recheck in the agent/API managers. Web: the **Agent & API setup** panel (opened from any health chip) with per-entry fix + one-click copy + Recheck; calm states (`binary_missing` / `key_missing`) collapse into a quiet summary chip in both UIs |
| Re-route blocked steps to a ready agent | ✅ | ✅ | Shared `planAgentReroute` / `Orchestrator.planWorkflowReroute` (`src/workflow/reroute.ts`); TUI `/reroute` (stages session overrides) + blocked-preview hint, web sidebar `↷ via <agent>` badge + run strip + `reroute: true` on `POST /api/runs`, CLI `workflow run/plan --agent <id>` + blocked-run hint |
| API health display (llm steps) | ✅ | ✅ | Shared `runApiDoctor`; TUI status bar `◆` entries, web health chips + `GET /api/doctor` `apis` |
| Manage agent instances | ✅ | ✅ | TUI `/agent` + `/agents` manager (Ctrl+A); web Settings → Runners (agents/APIs default to global/`user` scope, per-row project override) |
| Manage API instances (llm steps) | ✅ | ✅ | Shared `src/apis` core; TUI `/api` + `/apis` manager; web Settings → Runners APIs section (same scope model as agents) |
| Enable / disable a runner | ✅ | ✅ | Same `enabled: false` config flag in both; TUI Enter/Space in the `/agents` + `/apis` managers, web per-row **on/off** in Settings → Runners (disabled rows sort last and are skipped by the doctor) |
| Run history (inspect past runs) | ✅ | ✅ | Shared `RunRecordBuilder` + `WorkflowHistoryStore` (`.steamtrain/history`); TUI `/history`, web **Runs** page (`#runs`: status/workflow filter rail, run table, receipt rail, full receipt), CLI `workflow history` |
| Compare runs side by side | ❌ | ✅ | Web only: check two or more rows on the Runs page → **Compare** (totals, wall clock, cost, steps, tokens per run); **Export** downloads the checked summaries as JSON |
| Post-run worktree harvest (apply/prune from history) | ✅ | ✅ | Shared `src/workflow/gc.ts` (`harvestRunWorktrees`/`pruneRunWorktrees`); TUI `a`/`x` in history detail, web "Worktree changes" section (diffstat + Apply/Branch/Prune + conflict-retry), CLI `workflow history apply/prune` + `workflow worktrees` GC |
| Graphical full-patch diff panels (review a run's changes inline) | ✅ | ✅ | Shared `src/workflow/unified-diff.ts` parser; TUI full-screen scrollable run diff (`v` from history detail, dual gutters + status badges), web expandable per-step diff panels + collapsible approval diffs (`src/web/diff-view.ts` bundle); CLI `workflow history show <id> --diff [--step <id>]` for the uncapped patch |
| Re-run / retry-failed a past run | ✅ | ✅ | Shared `planRerun`/`seedCacheFromRecord` (`src/workflow/rerun.ts`); TUI `r`/`f` in history detail, web Re-run/Retry buttons, CLI `workflow run --from <id> [--retry-failed]` |
| Retry-failed with retarget agent/model | ✅ | ✅ | Shared `planRetryRetarget` (`src/workflow/retry-retarget.ts`); TUI `t` overlay, web **Retry with agent…**, CLI `--retarget-agent` / `--retarget-model` / `--step` |
| Auto-retry transient failures | ✅ | ✅ | Shared engine (`src/workflow/retry.ts`); workflow/per-step `retry` policy, `step_retry` event surfaced as `↻ retry n/N` in both UIs, attempts recorded in history |
| Prompt history | ✅ | ✅ | TUI: `prompt-history` (per-mode, ↑/↓); Web: run-input ↑/↓ recall backed by localStorage, recorded on Run/Plan |
| Prompt drafts (per-mode unsent drafts) | ✅ | ⚠️ | TUI `prompt-draft` restores unsent input per mode; the web keeps the unsent draft only while browsing history (↓ restores it) |
| Sub-workflow contents insight (models/params/steps) | ✅ | ✅ | Shared `describeSubWorkflow`; TUI row rollup + detail-panel breakdown, Web expandable "what runs inside" card block |
| Retarget/`set-all` cascades into sub-workflows | ✅ | ✅ | `WorkflowCallStep.overrides` (namespace-aware `applyWorkflowStepOverrides`); TUI `/set-all` + `--all` recurse via `listRetargetableSteps(spec, resolve)`, Web nested per-step editors + "Retarget all" |
| Workspaces (non-workflow dispatch) | ✅ | ❌ | Out of scope for unification (for now) |

---

## 3. Web-only capabilities (remaining gaps to bring into the TUI)

Now in the **shared core** and exposed by the TUI:

- ✅ **Clone / duplicate** — `WorkflowAuthor.clone`; TUI `/clone-workflow`.
- ✅ **Delete** a user workflow — `WorkflowAuthor.remove`; TUI `/delete-workflow`.
- ✅ **Per-step prompt editing** — TUI `/prompt` command.
- ✅ **Workflow description editing** — TUI `/describe-workflow` command.
- ✅ **Workflow name editing** — TUI `/rename-workflow` command.
- ✅ **Explicit draft-target selection** — TUI `/model` (agent/model) + `/effort` (effort level) in the workflow picker.

Still web-only (the shared core can persist them, but the TUI has no editing UI
for them yet):

(none remaining)

## 4. TUI-only capabilities (remaining gaps to expose in the web)

1. ~~**Staged session overrides**~~ — Done. Web now has "Try without saving" in the configure modal, staged override state, and "Flush to disk" button with saved/skipped/unchanged reporting.
2. ~~**`/save-workflows`-style flush**~~ — Done. `POST /api/overrides/flush` calls the shared `flushSessionOverrides` and returns the report.
3. ~~**Prompt history**~~ — Done (2026-07-15). The web run input records
   every Run/Plan submission to localStorage and recalls with ↑/↓.
4. **Per-mode prompt drafts** — Soft gap. The TUI persists one unsent draft per
   mode; the web restores the current unsent text only while traversing history.

---

## 5. Architectural divergences

Status after `feat/unify-workflow-authoring`:

1. ✅ **Event reducer unified.** `src/workflow/reducer.ts` is the single
   source of truth for folding `WorkflowEvent`s. It is shared natively by the
   TUI and compiled via a build-time esbuild step (`scripts/build-reducer.ts`)
   into `src/web/public/steamtrain-reducer.bundle.js`, served at
   `/static/steamtrain-reducer.bundle.js` for the browser UI.

2. ✅ **Authoring logic unified.** `WorkflowAuthor` moved to
   `src/workflow/authoring.ts` and is the single authoring core. The web server
   drives it via `Orchestrator` (which implements `AuthoringHost`); the TUI
   drives the **same class** via a small React-state adapter host. The TUI's
   `createWorkflow`, `saveWorkflows`, and preview resolution all route through
   it; `/clone-workflow` and `/delete-workflow` are thin wrappers over it.

3. ✅ **Override vs. edit model.** The core exposes both:
   `previewWithOverrides` (staged, non-destructive) and `flushSessionOverrides`
   (commit with saved/skipped/unchanged), plus `save`/`clone` (immediate). Both
   the TUI and web UI expose staged session overrides and an explicit flush;
   direct save/clone actions remain immediate by design.

4. ✅ **Capability surface.** The core exposes the full edit surface
   (prompt/name/description via `save`, clone, delete). The TUI now renders
   all of them: clone, delete, prompt, name, description, and draft-target selection.

5. ✅ **Metadata view-model.** `buildAgentMeta` / `defaultDraftModel` in
   `src/agents/agent-meta.ts` is the one agent→model→effort→default→health
   shape. `/api/meta` returns it verbatim (via `WorkflowAuthor.agentMeta`); the
   TUI still uses `models.ts` for its inline menus but can adopt the view-model.

6. ✅ **Catalog refresh unified.** A write goes through
   `WorkflowAuthor` → `loadWorkflowCatalog` → `AuthoringHost.setCatalog`, which
   is `Orchestrator.setCatalog` (web) or `setRuntimeCatalog` (TUI). One
   after-write reload path.

---

## 6. Convergence status

Unification is complete. `src/tui` and `src/web` are pure rendering + input
layers; all workflow logic (load, edit, draft, validate, persist, stage
overrides, run, fold events) lives in shared modules under `src/workflow` (+
orchestrator).

Core authoring and run capabilities are unified. Prompt history on the web
shipped 2026-07-15; one soft UX gap remains because the web restores the current
unsent text only while traversing history instead of persisting a draft per mode.
The override model is shared: both UIs can stage non-destructive session
overrides and explicitly flush them, while direct save/clone actions persist
immediately by design.
