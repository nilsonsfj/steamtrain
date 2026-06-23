# Act on run history: re-run / retry-failed

Status: approved (design)
Date: 2026-06-23

## Problem

Run history is inspect-only. You can look at a past run but cannot do anything
with it. The two high-value actions are:

- **Re-run** a past run — same workflow, same input, same cwd — without
  re-typing anything.
- **Retry only failed steps** — re-execute the steps that errored (and any that
  never ran) while replaying the ones that already succeeded. Agents flake; a
  single bad step should not cost the whole pipeline.

## Key insight

The engine already resumes from a `cache: Map<stepId, StepResult>`
(`src/workflow/engine.ts`): steps present in the cache replay without spawning;
absent steps execute. The on-disk cache (`src/workflow/cache-store.ts`) stores
**only successful** steps. So "retry-failed" is fundamentally "run the workflow
with the already-succeeded steps seeded into the cache."

What history adds over the existing on-disk cache: the `RunRecord` is a durable
record of every step's result (including fan-out children), so a retry can be
seeded **from the record** even when the on-disk cache was pruned, cleared, or
the run happened on another machine. The record is the source of truth.

## Design

### 1. Record format (additive, no version bump)

`validateRecord` (`src/workflow/history-store.ts`) drops any record whose
`version !== RUN_RECORD_VERSION`, so a version bump would silently delete all
existing history. Instead, add an **optional** field — non-breaking, no
migration, no data loss:

- Add `specHash?: string` to `RunRecord` and `RunRecordMeta`.
- `RunRecordBuilder` stores it; CLI / web / TUI pass `hashWorkflowSpec(spec)`
  when constructing the builder (all three have the spec at run start).
- `validateRecord` passes `specHash` through if present.
- Existing v1 records keep loading; they simply lack `specHash`, which disables
  retry-failed for them (re-run still works).

### 2. Shared core — new `src/workflow/rerun.ts`

One UI-agnostic module so the three surfaces don't diverge.

```ts
export type RerunMode = "rerun" | "retry-failed";

export interface RerunPlan {
  workflow: string;
  input: string;
  cwd: string;
  /** Steps to seed into the engine cache. Empty for a full re-run. */
  seedCache: Map<string, StepResult>;
  /** Set when retry-failed was downgraded to a full re-run. */
  downgraded?: "spec-changed" | "no-spec-hash";
}

export interface RerunError {
  error: string;
}

/**
 * Pure. Cache every step that completed, keyed by stepId (parents AND fan-out
 * children). The engine's existing resume semantics do the rest:
 *  - a done fan-out parent replays wholesale (children from result.childResults);
 *  - a failed fan-out parent re-enters executeForEachStep, replaying done
 *    children and re-running failed ones.
 */
export function seedCacheFromRecord(record: RunRecord): Map<string, StepResult>;

/** Decide what actually launches, applying the spec-drift guard. */
export function planRerun(
  record: RunRecord,
  mode: RerunMode,
  currentSpec: WorkflowSpec | undefined,
): RerunPlan | RerunError;
```

`seedCacheFromRecord`: for every `HistoryStep` with `status === "done"` and a
`result`, set `cache[step.stepId] = step.result`. Skip `pending` / `error` /
`running`.

`planRerun`:

- If `currentSpec` is undefined (workflow no longer in the catalog) →
  `{ error: "workflow '<name>' no longer exists" }`.
- `mode === "rerun"` → `seedCache` empty (fresh; uses current spec; no guard
  needed).
- `mode === "retry-failed"`:
  - `record.specHash` absent → `downgraded: "no-spec-hash"`, empty seed.
  - `record.specHash !== hashWorkflowSpec(currentSpec)` →
    `downgraded: "spec-changed"`, empty seed.
  - otherwise → `seedCache = seedCacheFromRecord(record)`.
- `workflow` / `input` / `cwd` always come from the record.

Exported from `src/workflow/index.ts`.

### 3. Launch wiring (each surface stays thin)

All three surfaces already drive a run pipeline that accepts a `cache: Map`.
Re-run / retry-failed just feed it a seed:

- Write the seeded cache to the on-disk cache store first (current key) so an
  interrupted retry resumes correctly afterward.
- `rerun` mode additionally `store.clear(key)` before running (true fresh).

**CLI** — `workflow run --from <runId> [--retry-failed]`:

- `--from <runId>` makes `<name>` optional (taken from the record) and defaults
  `--input` to the record's input (an explicit `--input` still overrides).
- Resolves the record via the history store, calls `planRerun`, seeds the cache,
  then runs through the existing doctor / record / persist pipeline unchanged.
- A downgraded plan prints a one-line warning to stderr.

**TUI** — `WorkflowHistory` detail view:

- `r` = re-run, `f` = retry-failed. `f` is a no-op note when
  `totals.failed === 0` (nothing to retry).
- Routes through the existing `App` run loop with the seeded cache.

**Web** — History detail:

- "Re-run" / "Retry failed" buttons → new POST routes that call
  `WorkflowRunManager.start` with the seeded cache, then navigate to the live
  run view.
- A `downgraded` plan renders a one-line banner ("workflow changed since this
  run — doing a full re-run").

### 4. Testing

- `tests/rerun.test.ts` (pure core): seed includes done parents + children,
  excludes pending/error/running; retry-failed downgrades on missing /
  mismatched specHash; error when the workflow is absent; a fully-successful
  run yields an all-cached seed.
- Engine integration: a seeded cache re-executes only error/pending steps
  (asserted with a counting fake adapter), including a failed fan-out child.
- CLI: `run --from <id> --retry-failed` re-runs only failures; `--from` alone
  does a fresh run; `--from` defaults the input.
- Web server: POST re-run / retry routes start a run with the right seed; the
  drift downgrade is flagged.

### 5. Out of scope (YAGNI)

- Editing input before re-run (re-run uses the recorded input; CLI `--input`
  override is the escape hatch).
- Diffing two runs or selecting individual steps to retry — separate features.
