# Sub-Workflows Design

**Status:** Approved
**Date:** 2026-07-04
**Author:** Nilson Santos

## Goal

Let a workflow step invoke another named workflow as a child run, so a proven
workflow (e.g. `bug-hunt`) can be embedded as one stage of a bigger pipeline
(e.g. `release`) instead of being copy-pasted or hand-unrolled. This is
roadmap item 2.5 ("Sub-workflows and reusable step templates"), scoped down —
see Non-goals.

## Non-goals

- **Step templates (`stepDefaults`/`extends`)** — the other half of roadmap
  2.5. Pure authoring sugar with no runtime/engine impact; independent of
  sub-workflows and deliberately deferred to a separate design.
- Parameterized/typed workflow inputs beyond the existing single `{{input}}`
  string (that's roadmap 2.4, not this).
- A visual "nested run" UI (TUI/web rendering polish is out of scope; this
  design only guarantees the *data* is there in a shape the existing
  renderers can already fold, per the flattening decision below).

## Background

Current architecture (see `src/workflow/types.ts`, `src/workflow/engine.ts`):

- `WorkflowStepKind` is `"worker" | "processor" | "distributor" |
  "consolidator" | "gate" | "merge" | "command"` — a discriminated union, each
  member a zod schema combined into `workflowStepSchema`.
- `executeStep()` in `engine.ts` dispatches on `step.kind` via an if-chain
  (not a lookup table); each kind has its own executor function
  (`executeAgentStep`, `executeCommandStep`, `executeMergeStep`,
  `executeForEachStep`, inline gate/distributor/consolidator logic).
- `StepResult.childResults?: StepResult[]` already exists — used today by
  `forEach` fan-out to hold each generated child's flat result. The engine's
  cost/token aggregation in `runSingleStep` already sums `childResults[]`
  when present instead of the parent's own `costUsd`.
- Run history (`src/workflow/history.ts`) is a **flat, event-folded** list of
  `HistoryPhase[]` each holding a flat `HistoryStep[]`; fan-out children are
  siblings in that same flat list, linked only by `parentStepId`. There is no
  nested `RunRecord`-within-`RunRecord` shape anywhere today.
- `validateWorkflow` (`types.ts`) is a pure, synchronous function: zod shape
  validation plus structural checks (dangling refs, workspace-inherit
  eligibility, loop nesting, and a static `MAX_STEPS=1000` budget computed
  from the spec's own phases/steps + loop expansion arithmetic). It has no
  I/O and no knowledge of any other workflow.
- `WorkflowDeps` (engine.ts) is the injected-dependency bag a run is given
  (`createAdapter`, `agentWorkspace`, etc.) — deliberately decoupled from
  filesystem/catalog concerns so the engine stays unit-testable with fakes.
- `catalog.ts` loads/merges bundled + user + project workflow specs into a
  `Record<string, WorkflowSpec>` and calls `validateWorkflow` on anything it
  accepts — the only place "all known workflow names" currently lives.
- `template.ts`'s `renderPrompt` resolves `{{steps.<id>.output}}` /
  `{{steps.<id>.json.<path>}}` / `.artifacts.<name>` / `.worktree.<field>`
  against a narrowed view of `StepResult`, with regex ordering deliberately
  load-bearing (more specific patterns must be tried before the greedy
  general `STEP_FIELD` pattern).
- Worktree/workspace inheritance (`workspace: "inherit:<stepId>"`) is
  restricted today to `worker`/`processor`/`command` **sources** — kinds that
  produce exactly one worktree. `gate`/`distributor`/`consolidator`/`merge`
  are already excluded from being inherit-eligible sources.

## Decisions (locked)

1. **New step kind, no agent/workspace fields.** A `workflow` step invokes a
   named workflow; it never spawns its own agent turn and never owns its own
   worktree — the child run's own steps handle all of that internally.
2. **Catalog resolution is injected, not imported.** `WorkflowDeps` gains an
   optional `resolveWorkflow?: (name: string) => WorkflowSpec | undefined`.
   Engine code never imports `catalog.ts`. Callers (CLI/TUI/web) that already
   load the catalog pass it in.
3. **Cycle & depth guard at runtime, not validate time.** A
   `Set<string>` of in-flight workflow names is threaded through execution
   context; re-entering a name already on the stack fails the step with a
   clear cycle error. A hardcoded `MAX_WORKFLOW_NESTING_DEPTH = 5` is an
   additional backstop.
4. **Step budget: independent per nesting level.** See "Step budget decision"
   below — this is a deliberate deviation from the roadmap's literal wording
   and is called out on its own for future reference.
5. **History shape: flatten, don't nest.** A child run's phases/steps are
   folded into the *parent run's own* flat `phases`/`steps` lists, using the
   existing `parentStepId` convention (same as `forEach` children) plus
   step-id namespacing `<workflowStepId>::<childStepId>` to avoid collisions.
   No new `RunRecord`-in-`StepResult` field; `computeRunTotals`, both UI
   reducers, and the history store's shape validator are unaffected.
6. **Cost/output bubble through existing fields, not new syntax.** The
   workflow step's own `StepResult.childResults` holds the child run's leaf
   step results, so the *existing* cost/token summation (engine.ts's
   `runSingleStep`, history.ts's `computeRunTotals`) picks it up unmodified.
   `StepResult.output`/`.json` mirror the *designated output step's*
   `output`/`json` — default the child's last step in execution order,
   overridable via `outputStep`. No new template placeholder syntax needed.
7. **Not an inherit-eligible workspace source.** Same exclusion already
   applied to `gate`/`distributor`/`consolidator`/`merge`.

## Step budget decision — documented for future reference

**Roadmap text (2.5) says:** "Recursion depth capped; the existing ≤1000-step
budget applies to the expanded tree."

**What we're actually doing instead:** each nested workflow run enforces its
own **independent** `MAX_STEPS=1000` ceiling, rather than `validateWorkflow`
recursively fetching child specs (by name, from the catalog) to statically
pre-compute one combined worst-case step count across the whole expanded
tree.

**Why:**
- `validateWorkflow` is pure and synchronous today (zod shape + structural
  checks only, no I/O). Making it recursively resolve child workflow specs
  by name requires threading catalog access into it, which:
  - breaks that purity (validation errors could now depend on the state of
    the catalog at validate time, which can change before run time — a
    workflow imported/edited between validate and run could invalidate the
    earlier check);
  - requires its own cycle detection at validate time (A depends on B
    depends on A) duplicating decision 3's runtime guard;
  - couples `types.ts` (currently dependency-free) to `catalog.ts`
    (filesystem/home-dir concerns).
- The runtime guards already in place (decision 3's cycle/depth cap, plus
  each nesting level's own 1000-step ceiling) already bound the *total*
  possible work to `MAX_WORKFLOW_NESTING_DEPTH × MAX_STEPS` in the worst
  case — large, but not unbounded, and enforced without new I/O in the
  validator.

**Known gap this leaves open:** a single **parent run** could still end up
executing far more than 1000 total steps once you sum across all its nested
child runs (each capped independently at 1000, up to 5 levels deep). The
roadmap's original intent — one combined ceiling across the whole expanded
tree — is *not* met by this design.

**Follow-up to track:** if in practice this turns out to matter (a workflow
author accidentally builds something that burns far more than 1000 steps
total across nested runs), revisit by either (a) plumbing a *shared* dynamic
budget counter down through nested `runWorkflow` calls via `WorkflowDeps`
(no static recursion needed — just decrement a shared counter at runtime,
much simpler than static pre-computation), or (b) biting the bullet on
catalog-aware recursive validation. Option (a) is likely the better fix and
should be the default next step if this gap is ever hit in practice — flag
as a fast-follow, not blocking this design.

## The new step kind

```ts
interface WorkflowCallStep extends WorkflowStepBase {
  kind: "workflow";
  workflow: string;      // name of the workflow to invoke (catalog lookup via resolveWorkflow)
  input?: string;        // template rendered to become the child run's {{input}}
  outputStep?: string;   // optional: id of the child step whose output/json surfaces
                         // as this step's result. Default: the child's last
                         // executed step (by execution order, not phase order).
}
```

- `dependsOn` / `when` behave exactly like any other step — a workflow step
  is an ordinary node in the DAG scheduler, no special-cased scheduling.
- Not eligible as a `workspace: inherit:` source (decision 7).
- No `artifacts:` field of its own; a child workflow's own declared
  artifacts are the mechanism for surfacing files, exposed through whichever
  step is `outputStep` (or accessed via the flattened, namespaced step id
  directly, e.g. a template author who knows the internal shape could in
  principle reference `{{steps.<workflowStepId>::<childStepId>.artifacts.x}}`
  — this works today with zero new template code since namespaced ids are
  just ordinary step ids in the flattened result map).

## Execution model

`executeWorkflowStep(step, ctx, hooks)` (new function in `engine.ts`,
following the existing executor pattern — never throws, always returns a
timed result):

1. Resolve `ctx.deps.resolveWorkflow?.(step.workflow)`. Missing → failed
   `StepResult` with a clear "workflow steps not supported in this context"
   or "unknown workflow '<name>'" message.
2. Check `step.workflow` against the in-flight name stack (decision 3) and
   depth cap. Violation → failed result, no execution attempted.
3. Render `step.input` via the existing `renderPrompt` context
   (`input`/`outputs`/`results`/`iteration`) to produce the child's
   `{{input}}`.
4. Recursively call `runWorkflow(childSpec, { input: renderedInput, cwd:
   ctx.cwd, ... }, childDeps, ctx.signal)` where `childDeps` is `ctx.deps`
   with the in-flight name stack extended by `step.workflow`. The child gets
   its own independent `MAX_STEPS` budget (decision 4) but shares
   `ctx.signal` so a parent-level abort (e.g. workflow-level `maxCostUsd`
   breach) cancels the in-flight child too.
5. Collect the child run's step results into a flat list, namespace each
   child step id as `<step.id>::<childStepId>`, and set `parentStepId:
   step.id` on each (decision 5) — these become this step's own
   `childResults`.
6. Determine the output step: `step.outputStep` if given (must exist in the
   child spec — validated statically, see below), else the child's
   last-executed step. Copy that step's `output`/`json` onto this step's own
   `StepResult`.
7. `ok` = the child run's overall `ok` (i.e. the child completed
   successfully, no unhandled step failures per its own gate semantics).
8. `costUsd`/`tokens` are left `undefined` on the top-level result — they're
   derived by existing summation over `childResults` (decision 6), exactly
   like `forEach` parents today.

## Validation (`validateWorkflow` additions)

Purely structural, no catalog access (decision 4's tradeoff):

- `kind: "workflow"` requires a non-empty `workflow` string and (like every
  other kind) a unique `id`.
- `dependsOn` / `when.step` reference rules are unchanged (still "earlier
  phase," same as today).
- Budget accounting: a `workflow` step counts as a **fixed cost of 1** toward
  the parent spec's own `MAX_STEPS` — the child's own steps are invisible to
  the parent's static count (decision 4).
- `outputStep`, if present, is **not** validated against the child spec's
  step ids at validate time (that would require catalog access) — if it
  doesn't exist in the child at run time, `executeWorkflowStep` fails the
  step with a clear error rather than silently falling back to "last step."

## Docs & example

- `docs/workflow-spec.md`: new `###` subsection under "Building blocks" for
  the `workflow` kind (fields, semantics, worked example), a row in the
  shared step-fields kind-enum table, and validation-rules bullets for the
  new structural checks and the fixed-cost-1 budget rule (with a pointer to
  this design doc's "Step budget decision" section for the rationale).
- `docs/workflow-examples.md`: one bundled example demonstrating the
  motivating case from the roadmap — a `release` workflow with a step that
  invokes `bug-hunt` as one of its stages.

## Testing plan

- `tests/workflow-workflow-step.test.ts` (new): fake `resolveWorkflow`
  returning canned child specs; assert successful invocation, `outputStep`
  selection (default and explicit), cycle rejection (self-reference and
  A→B→A), depth-cap rejection, missing-workflow-name failure, and
  `resolveWorkflow` absent → clear failure (no crash).
- `tests/workflow-history.test.ts`: add a case asserting namespaced
  `<workflowStepId>::<childStepId>` flattening and that `computeRunTotals`
  correctly rolls up nested cost/tokens without double-counting.
- `tests/workflow-spec.test.ts`: schema accept/reject cases for the new
  kind's required fields.
- `tests/workflow-generate.test.ts` / e2e: if `generate.ts`'s meta-prompt is
  updated with the new kind (see Docs section — mirrors existing per-kind
  bullets), add a corresponding extraction/validation test case.
