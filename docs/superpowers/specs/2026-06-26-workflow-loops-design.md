# Workflow Loops Design

**Status:** Approved
**Date:** 2026-06-26
**Author:** Nilson Santos

## Goal

Let workflows express bounded cycles natively so authors no longer have to
"unroll" iterative work (review → fix → re-review) into a fixed chain of phases.
A loop runs until a condition is satisfied or a configurable per-loop iteration
cap is reached, with the cap defaulting to 10.

## Background

Today the workflow model is deliberately acyclic:

- A `WorkflowSpec` is a flat list of `phases`. Phases run **sequentially**;
  steps within a phase run in **parallel**.
- Every `dependsOn` / `forEach` source / gate `condition.step` must reference a
  step in a **strictly earlier** phase. `validateWorkflow`
  (`src/workflow/types.ts`) rejects same-phase and forward references, and
  therefore all cycles.
- The engine (`src/workflow/engine.ts`) iterates phases by index and caches each
  successful step's result by step id; a cached step replays instead of
  re-running (this is how resume works).
- Gates already exist and already route: `onFalse: "continue" | "fail" | "stop"`.
- The LLM meta-prompt (`src/workflow/generate.ts`) explicitly instructs models:
  "Loops are NOT supported — UNROLL them."

The live TUI reducer (`src/tui/workflow-state.ts`) and the history builder
(`src/workflow/history.ts`) both fold the same `WorkflowEvent` stream and match
phases/steps by **bare id** (`find` by `phaseId` / `stepId`). The web live view
(`src/web/html.ts`) does the same in vanilla JS. These folds are kept in lockstep
by `tests/workflow-history.test.ts`.

## Decisions (locked)

1. **Loop primitive:** loop-back gate (extend the existing `gate`), not a nested
   loop container and not a repeatable single phase. Smallest blast radius;
   keeps the flat phase model.
2. **Cap-reached behavior:** reuse the gate's existing `onFalse` (default
   `fail`). Exhausting the cap falls through to `onFalse`.
3. **Cap scope:** per-loop counter. `maxIterations` optional per gate; falls back
   to `config.loopMaxIterations` (default 10), hard ceiling 100, with the global
   `MAX_STEPS` budget as a backstop.

## The primitive

A `gate` step gains two optional fields:

- `loopTo?: string` — the id of an **earlier phase** to jump back to.
- `maxIterations?: number` — per-loop cap (1..100). Omitted → config default →
  `DEFAULT_LOOP_MAX_ITERATIONS` (10).

Evaluation semantics when a gate has `loopTo`:

- **condition true** → gate passes; execution continues forward (loop
  converged). No jump.
- **condition false AND iterations remain** → increment this gate's iteration
  counter, jump execution back to the `loopTo` phase, re-run the loop body.
- **condition false AND iterations exhausted** → apply `onFalse`
  (`fail` / `stop` / `continue`), exactly as a non-looping gate does today.

A gate without `loopTo` behaves exactly as it does now (no change).

The **loop body / region** is the contiguous span of phases
`[loopToIndex .. gatePhaseIndex]`. The gate must sit in a phase **after** the
phases it re-runs, so the existing rule "gate `condition.step` must be in an
earlier phase" continues to hold unchanged: the gate inspects the body's last
step (an earlier phase), and `loopTo` points further back.

### Static vs. runtime shape

- The **static spec** stays a flat phase list with exactly one back-edge per
  loop gate. Visualizations draw it as a cycle ("↺ loops back to *review*").
- At **runtime** the loop unrolls: the engine re-emits the body phases per
  iteration, so the live tree and history show
  `review#1 → fix#1 → recheck#1 → review#2 → fix#2 → …`, each iteration its own
  instance.

## Components & changes

### 1. Data model — `src/workflow/types.ts`

- `GateStep`: add `loopTo?: string`, `maxIterations?: number`.
- `workflowGateStepSchema`: add `loopTo: z.string().min(1).optional()` and
  `maxIterations: z.number().int().min(1).max(LOOP_MAX_ITERATIONS_CEILING).optional()`.
- New exported constants:
  - `DEFAULT_LOOP_MAX_ITERATIONS = 10`
  - `LOOP_MAX_ITERATIONS_CEILING = 100`
- `validateWorkflow`:
  - `loopTo` must reference an existing phase whose index is **≤** the gate's
    phase index. A forward or unknown `loopTo` is rejected with a clear message.
  - Loop regions may **nest** but must not **partially overlap**: for any two loop
    gates, their regions are either disjoint or one fully contains the other.
    Reject partial overlap.
  - Extend the worst-case step-budget check. Worst case =
    `baseSteps + Σ_loops(regionStepCount × (effectiveMax − 1)) + forEachExpansion`,
    still capped at `MAX_STEPS`. `effectiveMax` uses the gate's `maxIterations`
    when set, else `LOOP_MAX_ITERATIONS_CEILING` (the static validator cannot see
    the runtime config default, so it bounds with the ceiling to stay safe).
  - For nested loops, multiply the inner region's expansion by the outer loop's
    `effectiveMax` so the bound reflects the true worst case.

### 2. Engine — `src/workflow/engine.ts`

- `WorkflowDeps`: add `loopMaxIterations?: number`.
- Replace the `for (let pi = 0; …)` phase walk with a manual index that can jump
  backward. Keep a `Map<string, number>` of per-gate iteration counts.
- When a loop-back gate evaluates and must loop again:
  1. Compute `effectiveMax = gate.maxIterations ?? deps.loopMaxIterations ?? DEFAULT_LOOP_MAX_ITERATIONS`.
  2. If the counter `< effectiveMax`: increment it; **delete the cache and
     results entries for every step id in the loop region** so they re-execute
     (outputs remain readable until each step overwrites them, so a "fix" step
     can read the previous iteration's "review"); emit a `loop_iteration` event;
     set the phase index back to `loopToIndex`.
  3. If the counter is exhausted: do **not** jump; apply `onFalse` as today
     (`fail`/`stop`/`continue`).
- Each phase/step event emitted during iteration `k` carries `iteration: k`
  (iteration 1 is the first pass). For fan-out children too.
- Template context gains `iteration` (current loop iteration, default 1) exposed
  as `{{iteration}}`; the gate's count is also reachable as
  `{{steps.<gateId>.iteration}}`.
- Resume: a fully completed loop replays from cache (final iteration's results).
  A run interrupted mid-loop re-runs the body from `loopTo` on resume — safe,
  documented behavior, no partial-iteration replay.

### 3. Templating — `src/workflow/template.ts`

- Accept an `iteration` value in the render context and resolve `{{iteration}}`.
- Resolve `{{steps.<gateId>.iteration}}` from the gate's StepResult (see below).

### 4. Events & folds — `events.ts`, `tui/workflow-state.ts`, `workflow/history.ts`

- Add optional `iteration?: number` to `StepStartEvent`, `StepDoneEvent`,
  `PhaseStartEvent`, `GateEvaluatedEvent`, `StepStreamEvent`, `StepRetryEvent`,
  `FanOutEvent`.
- New `LoopIterationEvent`:
  `{ kind: "loop_iteration"; gateStepId: string; loopTo: string; iteration: number; maxIterations: number; ts: number }`.
  Add to the `WorkflowEvent` union.
- Both folds (`workflowReducer` and `RunRecordBuilder.handle`) key phases and
  steps by the composite **`phaseId + (iteration ?? 1)`**. `phaseOf` / `stepOf`
  and the reducer's `find`/`map` matchers take the iteration into account.
  When `iteration` is undefined (every non-loop run), behavior is identical to
  today, preserving the reducer↔builder lockstep test.
- The render models (`PhaseState`, `HistoryPhase`) carry an optional
  `iteration?: number` so the UI can badge iterations and `workflowStateFromRecord`
  round-trips it.
- `StepResult` for a loop gate carries `iteration` (the count reached) so
  templating and history can show it.

### 5. Config — `src/config/types.ts`

- `SteamtrainConfig` + `configFileSchema`: add
  `loopMaxIterations?: number` (`z.number().int().min(1).max(LOOP_MAX_ITERATIONS_CEILING).optional()`).
- Thread `config.loopMaxIterations` into `WorkflowDeps.loopMaxIterations` at every
  engine call site (CLI run, TUI run, web run manager).

### 6. LLM generation — `src/workflow/generate.ts`

- Replace the "Loops are NOT supported — UNROLL them" section with a section that
  teaches the loop-back gate: a gate with `loopTo` (an earlier phase id) and
  optional `maxIterations`, the convergence/exhaustion semantics, and the rule
  that the gate must be in a phase after the body it re-runs.
- Add a worked example: implement → review → fix → recheck, with a gate whose
  `condition` tests "no issues" and `loopTo: "review"`, `maxIterations: 5`.
- Extend the self-check to cover the loop back-edge (loopTo points to an earlier
  phase; gate sits after the body).

### 7. TUI — authoring, editing, visualization

- `src/tui/workflow-spec-ui.ts`: surface gate `loopTo` and `maxIterations` in the
  shared spec UI helpers (labels/derivation used by create + edit).
- `src/tui/WorkflowStepDetails.tsx` (+ create flow as needed): when a step is a
  gate, allow choosing `loopTo` (from earlier phase ids) and `maxIterations`.
- `src/tui/WorkflowPreview.tsx` / `src/tui/WorkflowView.tsx`: render the loop
  back-edge on the gate ("↺ loops back to *review* · max 10"); the live view
  shows an iteration badge per re-run phase/step and a `loop_iteration` marker.

### 8. Web — visualization, live view, authoring

- `src/web/html.ts`: static spec render draws the loop edge; the SSE live
  consumer becomes iteration-aware (composite `phaseId + iteration` keys, mirror
  of the TS folds) and shows iteration badges + the `loop_iteration` marker.
- `src/web/server.ts`: authoring endpoints accept the new gate fields. Validation
  is the shared `validateWorkflow`, so acceptance is mostly automatic; confirm
  the spec round-trips through save/load.

### 9. Docs

- `docs/workflow-creation.md`: document the loop-back gate, the per-loop cap and
  config default, and the convergence/exhaustion semantics; add the worked
  example.
- `README.md`: note that workflows support bounded loops.

## Error handling

- **Invalid loop topology** (forward/unknown `loopTo`, partial region overlap) →
  rejected by `validateWorkflow` with a specific message; surfaced everywhere the
  validator already surfaces errors (CLI, TUI, web, LLM repair prompt).
- **Budget overflow** (loops × region too large) → rejected by the existing
  `MAX_STEPS` budget check with a loop-aware message.
- **Cap reached without convergence** → `onFalse` decides (fail/stop/continue),
  no new failure mode.
- **Abort mid-loop** → the in-flight step is killed and the run ends, exactly as
  abort works today; no special loop handling required.

## Testing

- **types:** valid back-ref accepted; forward `loopTo` rejected; unknown `loopTo`
  rejected; partial region overlap rejected; nested regions accepted; loop budget
  math rejects oversized loops and accepts within budget.
- **engine:** loop runs until condition met; loop stops at cap then applies
  `onFalse` for each of fail/stop/continue; `{{iteration}}` renders the current
  iteration; cache entries for the region are invalidated each iteration (steps
  re-run); a "fix" step reads the previous iteration's "review" output; abort
  mid-loop ends cleanly.
- **folds:** reducer and history builder both produce per-iteration phase/step
  instances and remain in lockstep; a non-loop run is byte-identical to today.
- **generate:** meta-prompt mentions the loop-back gate; a generated loop spec
  validates; the worked example validates.
- **config:** `loopMaxIterations` parses within bounds, rejects out-of-bounds,
  and is applied as the per-loop default when a gate omits `maxIterations`.

## Out of scope

- Nested loop containers and `while`/`until` block syntax (rejected in favor of
  the loop-back gate).
- Repeatable single phases.
- Cross-loop shared budgets (each loop has its own counter).
- Partial-iteration resume (a mid-loop interruption re-runs the body).
