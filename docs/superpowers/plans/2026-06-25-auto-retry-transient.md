# Auto-retry on Transient Failures Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically re-attempt an agent step that fails for a transient, side-effect-free reason (transport/spawn error before any completed result), with exponential backoff; never auto-retry logical failures, completed-but-errored turns, or cancellations.

**Architecture:** A pure `RetryPolicy` type + resolution/backoff helpers (`src/workflow/retry.ts`); a retry loop inside `executeAgentStep` that classifies each attempt as retryable (transport error / thrown, no `result` seen) vs not (a completed `result`, even if `isError`); a first-class `step_retry` event folded by the TUI reducer, the web `reduce()`, and `RunRecordBuilder`; an additive optional `attempts` on the history step.

**Tech Stack:** TypeScript, tsup, vitest, biome, zod.

## Global Constraints

- Commits are the user's own work — **no `Co-Authored-By` trailers for AI agents.**
- `RUN_RECORD_VERSION` must NOT change; new history fields are additive optional only.
- Only successful results are cached; the resume/cache contract is unchanged.
- Defaults: `maxAttempts:3, initialDelayMs:1000, factor:2, maxDelayMs:30000, jitter:true`.
- On by default for agent worker/processor steps (and fan-out children); `maxAttempts<=1` disables.

---

### Task 1: RetryPolicy type, schema, and resolution helpers

**Files:**
- Create: `src/workflow/retry.ts`
- Modify: `src/workflow/types.ts` (add `retry?` to `WorkerStep` and `WorkflowSpec`; add zod fields)
- Modify: `src/workflow/index.ts` (export retry module)
- Test: `tests/retry.test.ts`

**Interfaces:**
- Produces:
  - `interface RetryPolicy { maxAttempts?: number; initialDelayMs?: number; factor?: number; maxDelayMs?: number; jitter?: boolean }`
  - `interface ResolvedRetryPolicy { maxAttempts: number; initialDelayMs: number; factor: number; maxDelayMs: number; jitter: boolean }`
  - `const DEFAULT_RETRY: ResolvedRetryPolicy`
  - `resolveRetryPolicy(step?: RetryPolicy, workflow?: RetryPolicy): ResolvedRetryPolicy` — field-by-field: step ⟶ workflow ⟶ default.
  - `backoffDelayMs(policy: ResolvedRetryPolicy, attempt: number, rand?: () => number): number` — `attempt` is 1-based (the failed attempt); returns the wait before the next attempt. `min(maxDelayMs, initialDelayMs * factor^(attempt-1))`, times `rand()` in `[0,1]` when `jitter`.

- [ ] **Step 1: Write failing tests** in `tests/retry.test.ts`: resolution precedence (step over workflow over default), partial overrides resolve per-field, `backoffDelayMs` geometric growth (1000, 2000, 4000 with `rand=()=>1`, `jitter:true`), cap at `maxDelayMs`, jitter scales by rand, `jitter:false` ignores rand.
- [ ] **Step 2: Run** `npx vitest run tests/retry.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `src/workflow/retry.ts` with the interfaces above.
- [ ] **Step 4: Add schema + types** in `types.ts`: a `retryPolicySchema` (z.object, all optional, bounds: maxAttempts int 1–10, initialDelayMs int 0–60000, factor 1–10, maxDelayMs int 0–600000), attach `retry: retryPolicySchema.optional()` to the worker step schema and the top-level workflow schema; add `retry?: RetryPolicy` to `WorkerStep` and `WorkflowSpec` interfaces.
- [ ] **Step 5: Export** the retry module from `src/workflow/index.ts`.
- [ ] **Step 6: Run** `npx vitest run tests/retry.test.ts && npx tsc --noEmit` — expect PASS/clean.
- [ ] **Step 7: Commit** `feat: add retry policy type, schema, and backoff helpers`.

---

### Task 2: `step_retry` event

**Files:**
- Modify: `src/workflow/events.ts` (add `StepRetryEvent`, add to `WorkflowEvent` union)

**Interfaces:**
- Produces: `interface StepRetryEvent { kind: "step_retry"; phaseId: string; stepId: string; attempt: number; maxAttempts: number; delayMs: number; reason: string; ts: number }`

- [ ] **Step 1: Add** `StepRetryEvent` interface and union member in `events.ts` (doc-comment: emitted after a retryable failure, before the backoff sleep; `attempt` is the 1-based attempt that just failed).
- [ ] **Step 2: Run** `npx tsc --noEmit` — clean.
- [ ] **Step 3: Commit** `feat: add step_retry workflow event`.

---

### Task 3: Retry loop + classification in the engine

**Files:**
- Modify: `src/workflow/engine.ts`
- Test: `tests/retry-engine.test.ts`

**Approach:**
- Add `retryDefault?: RetryPolicy` to `ExecuteContext`; populate it from `spec.retry` where the run sets up `ctx` (top of `runWorkflow`/per-step ctx construction).
- Refactor the body of `executeAgentStep` into an inner `runOnce(): Promise<{ result: StepResult; retryable: boolean }>`:
  - `retryable` is `true` only when the failure came from an `error` event or a thrown exception **and no `result` event was observed**; `false` when a `result` event was seen (even `isError`) or when cancelled.
  - Track a `sawResult` flag set on the first `result` event.
- `executeAgentStep` resolves the policy once (`resolveRetryPolicy(step.retry, ctx.retryDefault)`), then loops up to `maxAttempts`: run `runOnce`; if `result.ok` or `!retryable` or `signal.aborted` or this was the last attempt → return `result` (with `attempts` set on it for the record, see Task 4); otherwise emit `step_retry` via `hooks.pushWorkflowEvent`, `await abortableSleep(backoffDelayMs(...), ctx.signal)`, and continue.
- `abortableSleep(ms, signal)`: resolves after `ms` or immediately on abort (listener + `clearTimeout`); local helper in engine.
- Carry the attempt count out via a new optional `StepResult.attempts?: number` (additive; set only when `> 1`). Add it to the `StepResult` interface in `types.ts`.

- [ ] **Step 1: Write failing tests** `tests/retry-engine.test.ts` with a counting adapter (yields `error`/`result` per a script): (a) transient `error` twice then success → adapter invoked 3×, run ok, step `attempts===3`; (b) always-throwing adapter → invoked `maxAttempts`×, run error; (c) `result.isError` → invoked exactly 1× (no retry); (d) fan-out child flakes once then succeeds → only that child retries, siblings invoked 1×; (e) cancel during backoff → run ends promptly, step not retried further. Use small `initialDelayMs` (e.g. 1) via per-step `retry`.
- [ ] **Step 2: Run** `npx vitest run tests/retry-engine.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the refactor + loop + `abortableSleep` + `ctx.retryDefault` threading + `StepResult.attempts`.
- [ ] **Step 4: Run** `npx vitest run tests/retry-engine.test.ts && npx tsc --noEmit` — PASS/clean.
- [ ] **Step 5: Commit** `feat: auto-retry transient agent failures with backoff`.

---

### Task 4: History records attempts

**Files:**
- Modify: `src/workflow/history.ts` (add `attempts?` to `HistoryStep`; `RunRecordBuilder` records it from `step_done` result and/or `step_retry`)
- Modify: `src/workflow/history-store.ts` (`validateRecord` passes through `attempts`)
- Test: `tests/workflow-history.test.ts`

- [ ] **Step 1: Write failing test** "records and round-trips step attempts": build a record from a stream containing `step_retry` then `step_done` with `result.attempts===3`; assert the saved+loaded `HistoryStep.attempts===3`.
- [ ] **Step 2: Run** the test — expect FAIL.
- [ ] **Step 3: Implement** additive `attempts?: number` on `HistoryStep`; in `RunRecordBuilder` set `attempts` from `result.attempts` on `step_done` (fallback: count `step_retry` events + 1); `validateRecord` passes `attempts: typeof r... === "number" ? ... : undefined`. Do NOT bump `RUN_RECORD_VERSION`.
- [ ] **Step 4: Run** `npx vitest run tests/workflow-history.test.ts && npx tsc --noEmit` — PASS/clean.
- [ ] **Step 5: Commit** `feat: record per-step retry attempts in run history`.

---

### Task 5: Fold `step_retry` in the TUI and web UIs

**Files:**
- Modify: `src/tui/workflow-state.ts` (handle `step_retry`: mark step "retrying", store attempt/maxAttempts)
- Modify: `src/tui/App.tsx` if needed for display ("retrying (n/N, Ns)…")
- Modify: `src/web/html.ts` (the embedded `reduce()` + render: show retrying state)
- Test: extend `tests/*` for the TUI reducer if a reducer test file exists

- [ ] **Step 1:** Handle `step_retry` in `src/tui/workflow-state.ts` — set a transient `retrying` status with `attempt`/`maxAttempts` on the step node; a subsequent `step_start`/`step_done` clears it. Add/extend a reducer unit test.
- [ ] **Step 2:** Surface "retrying (n/N)…" in the TUI step row.
- [ ] **Step 3:** Mirror in the web `reduce()` and render in `src/web/html.ts`.
- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit` — PASS/clean.
- [ ] **Step 5: Commit** `feat: show retry attempts in TUI and web UIs`.

---

### Task 6: Docs

**Files:**
- Modify: `README.md`, `docs/web-ui.md`, `TUI-WEBUI-DIFFERENCES.md`, and any workflow-authoring doc

- [ ] **Step 1:** Document the `retry` policy (workflow default + per-step), defaults, the safety rule (only no-completed-result transient failures retry), and `step_retry` visibility.
- [ ] **Step 2: Run** full `npx vitest run`, `npx tsc --noEmit`, `npm run build`, `npx biome check` on touched files.
- [ ] **Step 3: Commit** `docs: document auto-retry on transient failures`.

---

## Self-Review

- Spec coverage: classification (T3), policy/schema/defaults (T1), event (T2), history (T4), folds/UI (T5), docs (T6), tests in each. ✓
- Type consistency: `RetryPolicy`/`ResolvedRetryPolicy`/`resolveRetryPolicy`/`backoffDelayMs`/`StepRetryEvent`/`StepResult.attempts`/`HistoryStep.attempts` named consistently across tasks. ✓
- Safety: retry gated on "no completed result observed"; cancellation and gates never retry; cache contract unchanged. ✓
