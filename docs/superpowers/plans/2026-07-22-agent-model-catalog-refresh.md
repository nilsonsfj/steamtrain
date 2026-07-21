# Agent Model Catalog Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh per-agent model catalogs, family identity, class prefs, and Codex GPT-5.6 pricing for July 2026 (incl. Gemini 3.6 Flash).

**Architecture:** Curated static catalogs as offline fallbacks; live CLI refresh unchanged. Antigravity migrates to slug ids with legacy display-label compatibility.

**Tech Stack:** TypeScript / Bun / existing agent adapter + model-identity registry.

## Global Constraints

- Keep Cursor static list curated (no full effort/fast dump).
- No new Antigravity USD cost estimator.
- Preserve workflow compatibility for old Antigravity display labels.

---

### Task 1: Antigravity slug migration + Gemini 3.6

**Files:** `src/agents/antigravity.ts`, `src/agents/antigravity-variants.ts`, `tests/antigravity-*.test.ts`, `tests/models.test.ts`

- [ ] Update `ANTIGRAVITY_MODELS` to live slugs; default `gemini-3.6-flash-high`
- [ ] Map effort onto `-high`/`-medium`/`-low` (and legacy `(High)` labels)
- [ ] Parse slug lines from `agy models`
- [ ] Update tests

### Task 2: OpenCode + Cursor catalogs

**Files:** `src/agents/opencode.ts`, `src/agents/cursor.ts`

- [ ] Add Zen/Go model gaps from live APIs
- [ ] Expand Cursor curated notables

### Task 3: Codex pricing

**Files:** `src/agents/codex.ts`, `tests/codex-adapter.test.ts`

- [ ] Add Sol/Terra/Luna rates; cover with a pricing test

### Task 4: Identity + classes + docs

**Files:** `src/agents/model-identity.ts`, `src/agents/model-classes.ts`, `docs/model-binding.md`, related resolve tests

- [ ] Add `gemini-3.6-flash`, `gemini-3.5-flash-lite` families
- [ ] Retarget aliases/class prefs
- [ ] Run `npm test` / typecheck for touched areas
