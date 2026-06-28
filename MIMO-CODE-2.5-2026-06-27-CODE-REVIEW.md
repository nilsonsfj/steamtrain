# MIMO-CODE-2.5 Deep Codebase Review

**Project:** steamtrain
**Date:** 2026-06-27
**Reviewer:** Principal Software Engineer (MIMO-CODE-2.5)
**Scope:** Full codebase — correctness, architecture, code quality, security, testing
**Last updated:** 2026-06-27

---

## Executive Summary

**steamtrain** is a terminal orchestrator that runs coding agents (Claude Code, OpenCode, Codex, Amp) as managed subprocesses and renders their activity live in an Ink TUI. It also exposes a web UI. The codebase is ~15,000 lines of TypeScript across 80+ source files and 65 test files.

### Overall Assessment

| Area | Grade | Notes |
|------|-------|-------|
| Architecture | B+ | Clean adapter pattern, good separation of concerns in workflow subsystem |
| Correctness | B+ | Most critical issues resolved; minor edge cases remain |
| Type Safety | B+ | Strong Zod usage, strict tsconfig, exhaustiveness checks added |
| Security | A- | Headers, body limits, prototype pollution, and error sanitization all addressed |
| Test Coverage | A- | 605 tests; OS signal handling, orchestrator, malformed requests, doctor, cache store covered |
| Performance | B | Async catalog I/O, transcript/frame caps, backpressure; TUI re-render concerns remain |
| Maintainability | B- | App.tsx is a 923-line monolith (decomposed from 1905), server.ts route organization |

**Remaining findings: 42** (0 Critical, 0 High, 4 Medium, 38 Low)

---

## Table of Contents

1. [Critical Findings](#1-critical-findings)
2. [High Findings](#2-high-findings)
3. [Medium Findings](#3-medium-findings)
4. [Low Findings](#4-low-findings)
5. [Architectural Observations](#5-architectural-observations)
6. [Test Coverage Analysis](#6-test-coverage-analysis)
7. [Security Audit](#7-security-audit)
8. [Performance Analysis](#8-performance-analysis)
9. [Recommendations Summary](#9-recommendations-summary)

---

## 1. Critical Findings

### C7. No OS signal handling tests (SIGINT/SIGTERM) — **RESOLVED**
- **File:** `src/cli.ts`, `src/index.tsx`
- **Category:** Coverage Gap
- Without signal handling tests, orphaned agent processes, corrupted cache files, or incomplete history writes on Ctrl+C remain undetectable.
- **Resolution:** Added `tests/spawn-signal.test.ts` (10 tests) covering `runProcessLines` AbortSignal propagation, SIGKILL fallback, timeout, and child cleanup. Added `tests/cli-signal.test.ts` (8 tests) covering the CLI interrupt handler pattern (abort on first Ctrl+C, force exit on second), signal propagation through the full chain (SIGINT → AbortController → runProcessLines → kill), and SIGTERM/SIGKILL integration with real child processes. Also fixed a latent bug where `resolveWait()` was needed to unblock the generator when `startKill()` is called externally (abort signal/timeout) while the generator is blocked on `await waitForItem()`.

---

## 2. High Findings

(none remaining)

---

## 3. Medium Findings

### M2. Variant caches use module-level mutable state
- **File:** `src/agents/codex-variants.ts:19-20`, `src/agents/opencode-variants.ts:19-20`
- **Category:** Architecture
- Shared mutable singleton pattern. Tests running in parallel share cache state. Tests exist to mitigate, but the pattern is fragile.

### M5. Prompt-as-positional-arg pattern is fragile across all adapters
- **File:** `src/agents/codex.ts:285-299`, `claude.ts:227`, `opencode.ts:244`
- **Category:** Correctness / Security
- Prompt as last positional arg conflicts with CLI flag grammar changes. Consider stdin piping or `--prompt` flag.

### M11. No concurrency limit on LLM generation endpoint — **RESOLVED**
- **File:** `src/web/server.ts:158-165`
- **Category:** Resource Exhaustion
- `POST /api/workflows/generate` spawns subprocesses without throttling. Can exhaust credits and file descriptors.
- **Resolution:** Added `maxConcurrentGenerations` option (default 2) to `StartWebUiOptions`. Module-level counter tracks active generations; returns 503 when limit reached. Counter decremented in `finally` block to ensure cleanup on errors.

### M18. `applyWorkflowStepOverrides` can overwrite gate-specific fields
- **File:** `src/workflow/overrides.ts:7-22`
- **Category:** Edge Case
- `isAgentBackedStep` returns true for distributor/consolidator steps with `agent` field. Spread could overwrite `condition` with agent fields.

### M36. No CORS headers on any endpoint
- **File:** `src/web/server.ts`
- **Category:** HTTP Handling
- Acceptable for loopback binding, but `--host 0.0.0.0` exposes server on network.

---

## 4. Low Findings

### L1. `LineBuffer.push` uses O(n²) string concatenation
- **File:** `src/agents/line-buffer.ts:15`

### L3. `stringifyContent` doesn't handle circular references gracefully
- **File:** `src/agents/util.ts:4,26-32`

### L4. `codex-efforts-fallback.ts` GPT 5.4/5.3/5.2 all use GPT_55_EFFORTS
- **File:** `src/agents/codex-efforts-fallback.ts:13-15`

### L5. `opencode-efforts-fallback.ts` maps Qwen to Anthropic efforts
- **File:** `src/agents/opencode-efforts-fallback.ts:46-48`

### L6. `codex-variants.ts` and `opencode-variants.ts` share duplicated interfaces
- **File:** `src/agents/codex-variants.ts:8-11`, `src/agents/opencode-variants.ts:8-11`

### L8. Adapter creation path inconsistency
- **File:** `src/orchestrator/orchestrator.ts:73-79` vs `159-183`

### L9. `Orchestrator` uses `process.cwd()` as default cwd
- **File:** `src/orchestrator/orchestrator.ts:107`

### L10. `Orchestrator` workflow catalog not defensively copied
- **File:** `src/orchestrator/orchestrator.ts:44-46,63-66`

### L11. `setDoctor()` replaces entire array — TOCTOU with `resolve()`
- **File:** `src/orchestrator/orchestrator.ts:42,49-51`

### L12. `Channel` queue grows without bound
- **File:** `src/workflow/pool.ts:62-96`

### L13. No CORS headers
- **File:** `src/web/server.ts`

### L14. `closeAllConnections?.()` requires Node >= 18.2.0
- **File:** `src/index.tsx:70`

### L17. `homeRelativePath` follows symlinks
- **File:** `src/paths.ts:6-7`

### L19. Client-side `getElementById` lacks null guards
- **File:** `src/web/html.ts`

### L20. Port 0 accepted without notification
- **File:** `src/cli.ts:88-95`

### L22. EventSource auto-reconnect after run completion
- **File:** `src/web/html.ts:976-996`

### L23. Temp directory cleanup inconsistency in tests
- **File:** ~15 test files

### L25. No test timeout configuration
- **File:** `vitest.config.ts`

### L26. `biome.json` disables `useImportType`
- **File:** `biome.json:37`

### L28. SSE reader doesn't handle partial `data:` lines
- **File:** `tests/web-server.test.ts:132-158`

### L29. `reducer-build.test.ts` runs esbuild inside a test
- **File:** `tests/reducer-build.test.ts:10-41`

### L30. Hardcoded `/tmp` in many test specs
- **File:** `tests/workflow-engine.test.ts:77`

### L31. `codex-efforts.test.ts` uses `beforeEach` but `models.test.ts` doesn't
- **File:** `tests/codex-efforts.test.ts:25-27`

### L33. `MenuBackdrop` negative margin overlay is fragile
- **File:** `src/tui/CommandSuggestionMenu.tsx:106-119`

### L34. `useWorkIndicator` resets elapsed to 0 on inactive
- **File:** `src/tui/useWorkIndicator.ts:14-18`

### L35. `WorkflowStepDetails` truncation uses `Math.max(120, width * 5)`
- **File:** `src/tui/WorkflowStepDetails.tsx:214`

### L36. `EventStream` `estimateRows` is a rough heuristic
- **File:** `src/tui/EventStream.tsx:106-116`

### L37. No loading state in `WorkflowPreview` when spec unresolved
- **File:** `src/tui/App.tsx:1666-1691`

### L38. `migrateSessionOverrides` exported but only used locally
- **File:** `src/tui/App.tsx:1884-1894`

### L40. `STATUS_GLYPH` vs `STATUS_STYLE` naming confusion
- **File:** `src/tui/WorkflowHistory.tsx:14-18`

### L42. `EventRow` `summarizeInput` unsafe cast
- **File:** `src/tui/EventRow.tsx:157-158`

### L43. `WorkflowPicker` computes `phaseCount`/`stepCount` inline
- **File:** `src/tui/WorkflowPicker.tsx:48-49`

### L44. `orchestrator` recreation cascading through memoized values
- **File:** `src/tui/App.tsx:259-262`

### L45. `patchWorkflowStep` identity oscillation
- **File:** `src/tui/App.tsx:245-257,762-813`

### L46. `useEffect` with `configWarning` etc. can fire stale dispatches
- **File:** `src/tui/App.tsx:657-670`

### L47. `WorkflowCreate` `innerWidth` calculation assumes standard borders
- **File:** `src/tui/WorkflowCreate.tsx:36`

### L48. `WorkflowHistory` `selectVisibleWindow` misleading when empty
- **File:** `src/tui/WorkflowHistory.tsx:30`

### L50. `WorkflowStepDetails` prompt truncation too generous
- **File:** `src/tui/WorkflowStepDetails.tsx:214`

---

## 5. Architectural Observations

### 5.1 Strengths

| Area | Observation |
|------|-------------|
| **Adapter pattern** | Discriminated union `AgentEvent` type with adapter-specific mappers is clean. |
| **Zod schemas** | Raw CLI output validated with `.passthrough()` for forward compatibility. |
| **LineBuffer** | Correctly handles chunk boundary reassembly. |
| **Workflow layering** | Clean separation between types/engine/reducer/store. |
| **Atomic writes** | Temp-file-then-rename pattern prevents partial reads. |
| **TypeScript config** | `strict: true`, `noUncheckedIndexedAccess: true`, `noFallthroughCasesInSwitch: true`. |

### 5.2 Weaknesses

| Area | Observation |
|------|-------------|
| **App.tsx monolith** | 923 lines (decomposed from 1905), state management extracted to hooks. |
| **server.ts route organization** | 15+ routes in a single `handle()` function. Adding middleware is painful. |
| **Variant cache duplication** | `codex-variants.ts` and `opencode-variants.ts` are near-identical. |
| **No request logging** | Zero logging of HTTP requests or responses. |

---

## 6. Test Coverage Analysis

### Coverage Gaps

| Area | Impact |
|------|--------|
| OS signal handling | 18 tests covering AbortSignal propagation, SIGKILL fallback, CLI interrupt pattern, process cleanup |

### Test Quality Concerns

| Issue | Files |
|-------|-------|
| Timing-dependent assertions | `tests/workflow-engine.test.ts:116-126` |
| Global registry mutation | `tests/commands.test.ts:528-541` |
| `reducer-build.test.ts` runs esbuild | Build artifact verification, not unit test |

---

## 7. Security Audit

(all findings fixed)

---

## 8. Performance Analysis

| Issue | File | Impact | Status |
|-------|------|--------|--------|
| `LineBuffer` O(n²) concatenation | `line-buffer.ts` | Large outputs cause quadratic allocation | |

---

## 9. Recommendations Summary

### Next Sprint

1. ~~**Add OS signal handling tests** (C7) — verify clean shutdown~~ ✅ Done

### Long-Term

2. **Introduce route table** in `server.ts` — enable middleware composition
3. **Add structured logging** — replace `console.warn`/`console.assert` with logger
4. **Document threat model** — config file trust, loopback-only assumption

---

*Generated by MIMO-CODE-2.5 Principal Engineer Review Agent*
*Review date: 2026-06-27*
*Files reviewed: 80+ source files, 65 test files, 5 build configs*
