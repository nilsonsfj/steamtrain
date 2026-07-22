# Auto-retry on transient failures — design

**Date:** 2026-06-25
**Status:** Approved (design)

## Goal

Automatically re-attempt an agent step that fails for a **transient, side-effect-free** reason (the subprocess crashed, couldn't launch, or hit a transport/rate-limit error before producing any result), with exponential backoff. Persistent and logical failures are never auto-retried. This handles flaky infrastructure without a human, and composes with the existing manual `retry-failed` (which handles persistent failures after the root cause is fixed).

## The safety principle

Auto-retry must **only** re-run a failure we can prove did no work. `executeAgentStep`
distinguishes two failure sources, and they map cleanly onto that line:

| Failure source (in `executeAgentStep`) | Meaning | Retryable? |
|---|---|---|
| `event.kind === "error"`, or a thrown exception from `adapter.run`, **with no `result` and no `tool_use`/`tool_result` seen** | subprocess couldn't run / crashed / transport error before the agent did any work | **Yes** — transient, no observable work, no side effects |
| `event.kind === "result"` with `isError: true` | the agent ran to completion and reported failure | **No** — may have committed / edited / called APIs |
| any failure after a `tool_use`/`tool_result` was seen | the agent already invoked a tool | **No** — a tool may have had side effects |
| any failure after a `result` event was already seen | agent completed a turn first | **No** — work likely done |
| cancelled (`signal.aborted`) | user stopped the run | **No** — never |
| gate `onFalse`, skipped-dependency, distributor, non-agent consolidator | decisions / deterministic | **No** — never (not agent subprocess failures) |

The rule: **retry only when the agent did no observable work** — it neither emitted a
completed `result` nor invoked a tool. A completed `result` means a full turn ran; a
`tool_use`/`tool_result` means a tool may already have caused a side effect (a commit, a
file write, an API call) even if the agent later crashed before reporting a result. Both
block retry. This is conservative by design — a read-only tool call also blocks a
(probably-safe) retry — but it keeps the retried set to failures that almost certainly
changed nothing: spawn failures and immediate transport/rate-limit errors before the agent
got underway. We also do **not** sniff result text for "rate limit" strings: a `result`
event means a turn completed, so we cannot assume it was side-effect-free.

An adapter that can't parse an envelope downgrades it to a `kind: "unknown"` event tagged
with a `rawType` rather than dropping it. The classifier honors that tag: an `unknown`
whose `rawType` is `tool_use`/`tool_result`/`assistant`/`user` is treated as a tool
invocation (blocks retry), and `rawType: "result"` is treated as a completed turn — so a
side-effecting but unparsed tool call can't slip through as a "clean" transport failure.

## Scope

- Applies to **agent-backed worker/processor steps**, and to **each fan-out child
  independently** (a flaky child retries without re-running its siblings).
- Never applies to: distributors, gates, non-agent consolidators, skipped steps, or
  cancelled steps.
- Lives in the **engine execution path** (a retry loop around the `executeAgentStep`
  call). It does **not** touch the resume/cache model or `rerun.ts`; only successful
  results are cached, exactly as today. Auto-retry (transient, in-run, automatic) and
  `retry-failed` (persistent, post-run, manual) are complementary.

## Configuration

A `RetryPolicy`, settable as a **workflow-level default** and overridable **per step**.
Sane defaults; fully optional.

```ts
interface RetryPolicy {
  maxAttempts?: number;     // total tries including the first; default 3; 1 disables
  initialDelayMs?: number;  // default 1000
  factor?: number;          // default 2  -> 1s, 2s, 4s, ...
  maxDelayMs?: number;      // default 30000 (cap)
  jitter?: boolean;         // default true; full jitter so fan-out children desync
}
```

Resolution order for a step: per-step `retry` ⟶ workflow `retry` default ⟶ built-in
defaults. Each field resolves independently (a step may override only `maxAttempts`).
`maxAttempts: 1` (or `<= 1`) disables retry for that step.

Schema: add an optional `retry` object (all fields optional, with bounds) to the worker
step schema and a workflow-level `retry` default. Validation bounds: `maxAttempts`
1–10, `initialDelayMs` 0–60000, `factor` 1–10, `maxDelayMs` 0–600000.

Delay for attempt `n` (1-based, the wait *before* attempt `n+1`):
`min(maxDelayMs, initialDelayMs * factor^(n-1))`, then if `jitter`, multiply by a
random value in `[0, 1]` (full jitter). The backoff sleep is abortable via the run's
`AbortSignal` — a cancel during a backoff wait ends the step immediately.

## Observability

A first-class workflow event and an additive history field.

- **Event:** `step_retry` — `{ kind: "step_retry", phaseId, stepId, attempt, maxAttempts,
  delayMs, reason, ts }`, emitted after a retryable failure and before the backoff sleep.
  `attempt` is the attempt that just failed (1-based); `delayMs` is the upcoming wait.
  Handled by all three event folds in lockstep: the TUI `workflowReducer`, the web
  `reduce()`, and `RunRecordBuilder`.
- **History:** an additive optional `attempts?: number` on the history step (total tries;
  absent/1 means no retry). No `RUN_RECORD_VERSION` bump — additive optional fields only,
  so `validateRecord` keeps existing records.
- UIs show "retrying (attempt 2/3, 2s)…" so a backing-off step doesn't look frozen.

## Error handling

- A step that exhausts `maxAttempts` fails exactly as it does today (same `StepResult`,
  `phaseOk = false`, downstream skip), only with `attempts > 1` recorded.
- Backoff sleeps are abortable; cancel wins immediately and the step is recorded
  cancelled (never cached, never retried).
- Retry counting/sleeping must not change the result shape, cost accounting (costUsd is
  summed only from the attempt that produced it — failed transport attempts have none),
  or the cache contract.

## Testing

- **Classification unit tests:** transport `error` event → retryable; thrown exception →
  retryable; `result.isError` → not retryable; failure after a `result` event → not
  retryable; cancelled → not retryable.
- **Policy resolution unit tests:** per-step overrides workflow default overrides built-in;
  partial overrides; `maxAttempts:1` disables; delay/backoff/jitter bounds and the cap.
- **Engine integration tests (counting adapter):** a step that errors transiently twice
  then succeeds runs 3 times and the run is `ok`; a step whose adapter always throws stops
  at `maxAttempts`; a `result.isError` step runs exactly once (no retry); a fan-out child
  that flakes retries independently while siblings run once; cancel during backoff ends the
  run promptly.
- **Event/record tests:** `step_retry` events emitted with correct attempt/delay; the three
  folds surface attempts; `attempts` round-trips through history save/load.

## Out of scope (YAGNI)

- Per-error-class policies (different backoff curves for rate-limit vs network).
- Retrying non-agent steps.
- Cross-run retry budgets or circuit breakers.

## Later: capacity failover (implemented)

Mid-flight model re-routing for quota / rate-limit failures that arrive as
completed error turns is implemented separately via `modelFailover` +
`fallbackModels` — see `docs/model-binding.md` and `src/workflow/model-failover.ts`.
That path intentionally sniffs capacity messages (and optional adapter
`category` tags) so a quota run-out can walk the failover chain without treating
ordinary logic `result.isError` failures as retryable.
