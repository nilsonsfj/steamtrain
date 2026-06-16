# TUI ↔ Web UI feature differences

Purpose: catalog where the terminal UI (`src/tui`) and the browser UI (`src/web`)
diverge in workflow **authoring, configuration, and running**, so we can later
make both UIs thin *views* over one shared foundation rather than two parallel
implementations.

This is a working document. The end state we're aiming for: a single
"workflow session / authoring" core that the TUI and the web server both drive,
with each layer owning only presentation + input handling.

Last updated: 2026-06-16 (after adding web authoring in
`feat/web-ui-workflow-authoring`).

---

## 1. Shared foundation (already common)

Both UIs already sit on the same lower layers — this is the part that's done
right and should expand:

| Module | Responsibility | Used by |
| --- | --- | --- |
| `src/orchestrator` | catalog access, dispatch gating, run streaming | TUI + web |
| `src/workflow/engine.ts` | `runWorkflow` → `WorkflowEvent` stream | both (via orchestrator) |
| `src/workflow/catalog.ts` | load/merge catalog, `saveUserWorkflow`, `deleteUserWorkflow`, `saveSessionWorkflowsToUser` | both |
| `src/workflow/generate.ts` | `generateWorkflow` (LLM → validated spec) | both |
| `src/workflow/overrides.ts` | `applyWorkflowStepOverrides` | TUI; web applies edits directly |
| `src/workflow/types.ts` | spec schema + `validateWorkflow` | both |
| `src/agents/models.ts` | `modelsForAgent`, `effortsForModel`, defaults | TUI directly; web via `/api/meta` |

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
| Choose drafting agent/model/effort | ❌ | ✅ | TUI auto-picks first healthy agent (`pickGenerationTarget`) |
| Per-step **agent** override | ✅ | ✅ | |
| Per-step **model** override | ✅ | ✅ | |
| Per-step **effort** override | ✅ | ✅ | |
| Per-step **prompt** editing | ❌ | ✅ | TUI override is `Pick<…,"agent"\|"model"\|"effort">` only |
| Edit workflow **name** | ❌ | ✅ | Web modal; rename drops old user entry |
| Edit workflow **description** | ❌ | ✅ | |
| Clone / duplicate a workflow | ❌ | ✅ | Web "Clone" saves a copy under a new name |
| Delete a user workflow | ❌ | ✅ | TUI requires hand-editing `workflows.json` |
| Stage overrides *without* persisting | ✅ | ❌ | TUI session overrides; web saves immediately |
| Explicit "save session changes" step | ✅ | ⚠️ | TUI `/saveworkflows`; web persists on each save |
| Skip/unchanged reporting on save | ✅ | ❌ | `saveSessionWorkflowsToUser` returns saved/skipped/unchanged |
| Agent health display | ✅ | ✅ | TUI doctor panel; web health chips |
| Prompt history / drafts | ✅ | ❌ | TUI-only (`prompt-history`, `prompt-draft`) |
| Workspaces (non-workflow dispatch) | ✅ | ❌ | Out of scope for unification (for now) |

---

## 3. Web-only capabilities (to bring into the shared core / TUI)

1. **Per-step prompt editing.** The Configure modal rewrites any agent-backed
   step's prompt. The TUI override type deliberately excludes `prompt`.
2. **Workflow name & description editing**, including clean rename (the old
   user entry is removed so no duplicate remains).
3. **Clone / duplicate** — save any workflow (even bundled) as a new user copy.
4. **Delete** a user workflow (guarded: user-source only; bundled/project are
   read-only).
5. **Explicit draft-target selection** — pick agent + model + effort for the LLM
   draft, sourced from the live catalog (`/api/meta`), with current/off-catalog
   values kept selectable so a save never silently rewrites them.
6. **One-step persistence** — editing a bundled/project workflow transparently
   writes a user copy that overrides it, in a single action.

Implementation today lives in `src/web/authoring.ts` (`WorkflowAuthor`) +
routes in `src/web/server.ts`. `WorkflowAuthor` is the closest thing to the
shared authoring core we want — it already wraps generate + validate + save +
delete + catalog reload behind a small `AuthoringHost` interface.

## 4. TUI-only capabilities (to expose in the web / shared core)

1. **Staged session overrides** — change a step's agent/model/effort for the
   *next run only*, without writing to disk. Web currently commits immediately.
2. **`/saveworkflows`** — a deliberate "flush staged changes to the user file"
   step, with **saved / skipped / unchanged** reporting
   (`saveSessionWorkflowsToUser` / `collectSessionWorkflowSaves`).
3. **Prompt history & drafts** — not authoring per se, but part of the run
   experience the web lacks.

---

## 5. Architectural divergences (the real unification work)

These are the duplications/asymmetries to resolve so both UIs are views over
one foundation:

1. **Two event reducers.** `src/tui/workflow-state.ts#workflowReducer` and the
   `reduce()` in `src/web/html.ts` independently fold `WorkflowEvent`s into a
   phase→step tree. → Extract one framework-agnostic reducer (plain TS) that
   both consume; the web reducer is currently hand-written in the page script.

2. **Authoring logic split.** The web has a clean service (`WorkflowAuthor`);
   the TUI inlines create/override/save in `App.tsx` (`patchWorkflowStep`,
   `saveWorkflows`, the `/createworkflow` handler). → Promote a shared
   `WorkflowAuthoringSession` (probably generalizing `WorkflowAuthor`) that
   supports **both** immediate save (web) and staged overrides + flush (TUI).
   The `AuthoringHost` interface is already a good seam.

3. **Override vs. edit model.** TUI mutates via `applyWorkflowStepOverrides`
   (non-destructive, layered); web edits the spec and persists. The unified core
   should represent edits as a layer that can be either previewed (staged) or
   committed, covering both behaviors.

4. **Capability surface mismatch.** Prompt/name/description/clone/delete exist
   only on the web because the TUI override type is narrow. The shared core
   should expose the **full** edit surface; each UI decides what to render.

5. **Metadata access.** TUI calls `src/agents/models.ts` directly; web reaches
   it over `/api/meta`. Fine to keep — but the shape returned by `/api/meta`
   (agent → models → efforts → default → healthy) is the natural shared
   view-model and could be produced by one helper used by both.

6. **Catalog refresh.** Both reload via `loadWorkflowCatalog` after a write
   (TUI `setRuntimeCatalog`; web `Orchestrator.setCatalog`). Unify behind one
   "after-write reload" path on the shared session.

---

## 6. Suggested convergence order

1. Extract the **WorkflowEvent reducer** into a shared, UI-agnostic module;
   point both reducers at it (kill the duplicate in `html.ts`).
2. Generalize **`WorkflowAuthor` → a shared authoring session** with two commit
   modes: `staged` (TUI overrides + flush) and `immediate` (web). Move TUI
   `patchWorkflowStep`/`saveWorkflows` onto it.
3. Widen the **edit surface** in the shared core to prompt/name/description +
   clone + delete; have the TUI render the new affordances.
4. Add **staged overrides + `/saveworkflows`-style flush** to the web so it can
   also try-without-saving and report saved/skipped/unchanged.
5. Define one **agent/model/effort view-model** helper feeding both `/api/meta`
   and the TUI menus.

End state: `src/tui` and `src/web` contain only rendering + input; everything
about workflows (load, edit, draft, validate, persist, run, fold events) lives
in shared modules under `src/workflow` (+ orchestrator).
