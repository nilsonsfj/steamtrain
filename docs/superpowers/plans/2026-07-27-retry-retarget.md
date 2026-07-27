# Retry Retarget Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users retry failed workflow steps with a different agent/model (CLI + TUI + Web) without losing succeeded-step seeds.

**Architecture:** After a non-downgraded `planRerun` seed, optionally filter which failed steps re-execute and apply session `{ agent, model }` overrides via `applyWorkflowStepOverrides`.

**Tech stack:** TypeScript, Vitest, existing workflow/reroute/override machinery, Ink TUI, web history API.

---

### Task 1: Shared core (`retry-retarget.ts`)

**Files:**
- Create: `src/workflow/retry-retarget.ts`
- Create: `tests/retry-retarget.test.ts`
- Modify: `src/workflow/index.ts` (exports)

**Steps:** TDD `planRetryRetarget` + `applyRetryStepFilter` per design; export from barrel.

### Task 2: CLI

**Files:**
- Modify: `src/run-cli.ts`, `src/cli.ts`
- Modify: `tests/cli.test.ts` (or dedicated tests)

**Steps:** Parse `--retarget-agent`, `--retarget-model`, `--step`; validate combos; wire after `planRerun`.

### Task 3: Web API + manager

**Files:**
- Modify: `src/web/runs.ts`, `src/web/server.ts`
- Modify: relevant web/history tests

### Task 4: Web UI

**Files:**
- Modify: `src/web/public/app.js`

### Task 5: TUI

**Files:**
- Modify: `src/tui/useHistory.ts`, `src/tui/useKeyboardInput.ts`, `src/tui/App.tsx`, `src/tui/WorkflowHistory.tsx`
- Create: small retarget overlay component as needed

### Task 6: User docs + PR

**Files:**
- Modify: `README.md` (and short history doc notes if present)
- Open PR from `feat/retry-retarget`
