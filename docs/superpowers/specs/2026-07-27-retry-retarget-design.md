# Retry failed steps with a retarget agent/model

Status: approved (design)
Date: 2026-07-27

## Problem

Retry-failed (`--from <id> --retry-failed`, TUI `f`, Web "Retry failed") reuses
the same agent/model bindings. When a step fails for quota, auth, or model
quality reasons on an otherwise-ready agent, the user cannot surgically retry
with a different runner without a full re-run or fighting the `specHash` drift
guard.

`--agent` only remaps **blocked** (not ready) agents, so it does not help when
the original agent is still doctor-healthy.

## Goals

- Retry failed / not-run steps while keeping succeeded steps seeded.
- Optionally force those steps onto a new agent (and optional model).
- Optionally narrow which steps re-execute (`--step`).
- Full parity: CLI, TUI, Web.
- Leave `--agent` blocked-only semantics unchanged.

## Non-goals

- Arrival-screen CTA changes.
- Mid-run `StepEditPatch.agent`.
- Persisting retarget into workflow files.
- Changing `specHash` drift rules.

## Design

### Core insight

`planRerun` already seeds done steps into the engine cache. Retarget is a
**session override** applied **after** a successful (non-downgraded) seed via
existing `applyWorkflowStepOverrides`. The catalog `specHash` comparison is
unchanged, so overrides do not trigger a downgrade.

### Shared planner — `src/workflow/retry-retarget.ts`

```ts
planRetryRetarget(spec, record, config, isReady, {
  agent,           // required
  model?,          // optional; else same-family on target, else target default
  stepIds?,        // optional filter of which failed/not-run steps to touch
}): { ok, overrides, stepIds } | { ok: false, error }

applyRetryStepFilter(record, seed, stepIds?): Map<stepId, StepResult>
```

Eligibility for retarget: agent-backed steps whose history status is not
`done`, optionally intersected with `stepIds`.

`applyRetryStepFilter`: when `stepIds` is set, seed synthetic skipped results
(`ok: true, skipped: true, output: ""`) for every non-done step **not** in the
filter so the engine does not launch them. Selected failed steps stay unseeded
and re-execute.

### CLI

```bash
steamtrain workflow run --from <id> --retry-failed \
  --retarget-agent <id> [--retarget-model <id>] [--step <id> ...]
```

Rules:

- `--retarget-agent` / `--retarget-model` / `--step` require `--from --retry-failed`
  (`--step` and retarget flags only valid with `--retry-failed`).
- `--retarget-model` requires `--retarget-agent`.
- `--step` alone is allowed (narrow retry, no retarget).
- `--agent` and `--retarget-agent` are mutually exclusive.
- If retry-failed is downgraded, retarget (and `--step` filter) is refused with
  a clear error.

### TUI

- `f` — plain retry-failed (unchanged).
- `t` — retarget overlay: pick agent → model → optional step multi-select → confirm.

### Web

- "Retry failed" remains plain retry.
- "Retry with agent…" opens a modal (agent, model, optional steps).
- `POST /api/history/:id/retry` accepts optional
  `{ retargetAgent, retargetModel, steps }`.

### Ordering

1. `planRerun(record, "retry-failed", …)`
2. If downgraded and retarget/`--step` requested → error
3. `applyRetryStepFilter(seed, stepIds?)`
4. If `--retarget-agent`: `planRetryRetarget` → `applyWorkflowStepOverrides`
5. Dispatch with seed + `specOverride`
