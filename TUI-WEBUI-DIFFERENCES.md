# TUI ↔ Web UI feature differences

Purpose: catalog where the terminal UI (`src/tui`) and the browser UI (`src/web`)
diverge in workflow **authoring, configuration, and running**, so we can later
make both UIs thin *views* over one shared foundation rather than two parallel
implementations.

This is a working document. The end state we're aiming for: a single
"workflow session / authoring" core that the TUI and the web server both drive,
with each layer owning only presentation + input handling.

Last updated: 2026-06-16 (after the first unification pass in
`feat/unify-workflow-authoring`: the authoring core is now shared).

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

`WorkflowAuthor` (formerly `src/web/authoring.ts`) moved into `src/workflow`
and is now the single authoring core both frontends drive — see §5.

Both UIs also fold the **same `WorkflowEvent` stream** into a phase→step render
model — independently:

- TUI: `src/tui/workflow-state.ts` (`workflowReducer`)
- Web: the `reduce()` function embedded in `src/web/html.ts`

These two reducers are near-duplicates and are a prime extraction target (see §5).

---

## 2. Feature matrix

✅ present · ⚠️ partial / different · ❌ absent

| Capability | TUI | Web | Notes |
| --- | :---: | :---: | --- |
| Browse workflows (bundled/user/project) | ✅ | ✅ | |
| View pipeline / step details | ✅ | ✅ | Web lays phases out as a vertical pipeline with parallel cards |
| Run a workflow + live progress | ✅ | ✅ | |
| Fresh run (ignore cache) | ✅ | ✅ | |
| Cancel a run | ✅ | ✅ | |
| Resume from on-disk cache | ✅ | ✅ | |
| Create workflow via LLM draft | ✅ | ✅ | Different draft-target selection (below) |
| Choose drafting agent/model | ⚠️ | ✅ | TUI: `/model` on the picker sets a session draft override (`src/tui/draft-model.ts`), shown in the header; auto-picks first healthy agent otherwise. Web: per-draft agent/model/effort selects in the create modal. TUI override has no effort knob yet |
| Per-step **agent** override | ✅ | ✅ | |
| Per-step **model** override | ✅ | ✅ | |
| Per-step **effort** override | ✅ | ✅ | |
| Per-step **prompt** editing | ❌ | ✅ | TUI override is `Pick<…,"agent"\|"model"\|"effort">` only |
| Edit workflow **name** | ❌ | ✅ | Web modal; rename drops old user entry |
| Edit workflow **description** | ❌ | ✅ | |
| Clone / duplicate a workflow | ✅ | ✅ | Both via `WorkflowAuthor.clone`; TUI `/cloneworkflow [--project] <new-name>` |
| Delete a user or project workflow | ✅ | ✅ | Both via `WorkflowAuthor.remove`; TUI `/deleteworkflow <name>` (bundled still guarded) |
| Author into the **project** layer (`steamtrain.json`) | ✅ | ✅ | Shared `WorkflowScope`; create/clone/save target user or project. CLI: `workflow create --scope project`; TUI: `--project`; web: scope selector |
| Stage overrides *without* persisting | ✅ | ❌ | TUI session overrides (now flushed via `WorkflowAuthor.flushSessionOverrides`); web still saves immediately |
| Explicit "save session changes" step | ✅ | ⚠️ | TUI `/saveworkflows` → shared flush; web persists on each save |
| Skip/unchanged reporting on save | ✅ | ❌ | `flushSessionOverrides`/`saveSessionWorkflowsToUser` returns saved/skipped/unchanged (TUI surfaces it) |
| Agent health display | ✅ | ✅ | TUI doctor panel; web health chips |
| Run history (inspect past runs) | ✅ | ✅ | Shared `RunRecordBuilder` + `WorkflowHistoryStore` (`.steamtrain/history`); TUI `/history`, web ⏱ History, CLI `workflow history` |
| Re-run / retry-failed a past run | ✅ | ✅ | Shared `planRerun`/`seedCacheFromRecord` (`src/workflow/rerun.ts`); TUI `r`/`f` in history detail, web Re-run/Retry buttons, CLI `workflow run --from <id> [--retry-failed]` |
| Auto-retry transient failures | ✅ | ✅ | Shared engine (`src/workflow/retry.ts`); workflow/per-step `retry` policy, `step_retry` event surfaced as `↻ retry n/N` in both UIs, attempts recorded in history |
| Prompt history / drafts | ✅ | ❌ | TUI-only (`prompt-history`, `prompt-draft`) |
| Workspaces (non-workflow dispatch) | ✅ | ❌ | Out of scope for unification (for now) |

---

## 3. Web-only capabilities (remaining gaps to bring into the TUI)

Now in the **shared core** and exposed by the TUI:

- ✅ **Clone / duplicate** — `WorkflowAuthor.clone`; TUI `/cloneworkflow`.
- ✅ **Delete** a user workflow — `WorkflowAuthor.remove`; TUI `/deleteworkflow`.

Still web-only (the shared core can persist them, but the TUI has no editing UI
for them yet):

1. **Per-step prompt editing.** The web Configure modal rewrites any
   agent-backed step's prompt. The TUI step override is still
   `agent`/`model`/`effort` only. The shared `save`/`clone` path *can* write an
   edited prompt — the TUI just lacks an editor affordance.
2. **Workflow name & description editing**, including clean rename
   (`WorkflowAuthor.save(name, spec, previousName)` already handles the rename;
   the TUI has no rename/description editor).
3. **Explicit draft-target selection** — the web create form picks agent + model
   + effort from `/api/meta`; the TUI still auto-picks the first healthy agent
   (`pickGenerationTarget`). `agentMeta()` is shared, so a TUI picker is now a
   thin add-on.

## 4. TUI-only capabilities (remaining gaps to expose in the web)

The persistence primitives are shared (`WorkflowAuthor.flushSessionOverrides`
wraps `saveSessionWorkflowsToUser`), but the **web UI** doesn't surface them:

1. **Staged session overrides** — change a step's agent/model/effort for the
   *next run only* without writing to disk. The web still commits immediately;
   `previewWithOverrides` + `flushSessionOverrides` exist for it to adopt.
2. **`/saveworkflows`-style flush** with **saved / skipped / unchanged**
   reporting — available via the shared core; the web has no "flush" button yet.
3. **Prompt history & drafts** — part of the run experience the web lacks.

---

## 5. Architectural divergences

Status after `feat/unify-workflow-authoring`:

1. ⚠️ **Two event reducers.** `src/tui/workflow-state.ts#workflowReducer` and
   the `reduce()` in `src/web/html.ts` still independently fold `WorkflowEvent`s.
   **Not yet unified** — the web reducer is plain JS embedded in a (non-bundled)
   page template, so sharing the TUI's TS reducer needs a browser bundling step
   for `html.ts`. Deferred to its own change. This is now the largest remaining
   divergence.

2. ✅ **Authoring logic unified.** `WorkflowAuthor` moved to
   `src/workflow/authoring.ts` and is the single authoring core. The web server
   drives it via `Orchestrator` (which implements `AuthoringHost`); the TUI
   drives the **same class** via a small React-state adapter host. The TUI's
   `createWorkflow`, `saveWorkflows`, and preview resolution all route through
   it; `/cloneworkflow` and `/deleteworkflow` are thin wrappers over it.

3. ⚠️ **Override vs. edit model.** The core now exposes both:
   `previewWithOverrides` (staged, non-destructive) and `flushSessionOverrides`
   (commit with saved/skipped/unchanged), plus `save`/`clone` (immediate). The
   TUI uses the staged path; the web uses immediate. The seam exists for the web
   to add a staged mode.

4. ⚠️ **Capability surface.** The core exposes the full edit surface
   (prompt/name/description via `save`, clone, delete). The TUI now renders
   clone + delete; prompt/name/description editors are still web-only UI.

5. ✅ **Metadata view-model.** `buildAgentMeta` / `defaultDraftModel` in
   `src/agents/agent-meta.ts` is the one agent→model→effort→default→health
   shape. `/api/meta` returns it verbatim (via `WorkflowAuthor.agentMeta`); the
   TUI still uses `models.ts` for its inline menus but can adopt the view-model.

6. ✅ **Catalog refresh unified.** A write goes through
   `WorkflowAuthor` → `loadWorkflowCatalog` → `AuthoringHost.setCatalog`, which
   is `Orchestrator.setCatalog` (web) or `setRuntimeCatalog` (TUI). One
   after-write reload path.

---

## 6. Remaining convergence work

Done in `feat/unify-workflow-authoring`: §5.2, §5.5, §5.6, plus clone/delete in
the TUI and the staged-flush seam (§5.3). What's left:

1. **Extract the `WorkflowEvent` reducer** into a shared, UI-agnostic module and
   bundle it into `html.ts` so the browser uses the same fold as the TUI
   (§5.1). Needs a small browser build step for the page script.
2. **Render the full edit surface in the TUI** — per-step prompt editing and
   name/description editing (the core already persists them) (§4 / §5.4).
3. **Add a staged mode to the web** — "try without saving" + an explicit flush
   button with saved/skipped/unchanged reporting, using `previewWithOverrides` /
   `flushSessionOverrides` (§4).
4. **TUI draft-target picker** — let the TUI choose agent/model/effort for the
   LLM draft using the shared `agentMeta()` instead of auto-picking (§3).

End state: `src/tui` and `src/web` contain only rendering + input; everything
about workflows (load, edit, draft, validate, persist, run, fold events) lives
in shared modules under `src/workflow` (+ orchestrator). The authoring half of
that is now done; the run-fold (reducer) half is the main piece left.
