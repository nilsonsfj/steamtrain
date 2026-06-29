# MIMO-CODE-2.5 Deep Codebase Review

**Project:** steamtrain
**Date:** 2026-06-27
**Reviewer:** Principal Software Engineer (MIMO-CODE-2.5)
**Scope:** Full codebase — correctness, architecture, code quality, security, testing
**Last updated:** 2026-06-29

---

## Executive Summary

**steamtrain** is a terminal orchestrator that runs coding agents (Claude Code, OpenCode, Codex, Amp) as managed subprocesses and renders their activity live in an Ink TUI. It also exposes a web UI. The codebase is ~15,000 lines of TypeScript across 80+ source files and 70 test files.

### Overall Assessment

| Area | Grade | Notes |
|------|-------|-------|
| Architecture | B+ | Clean adapter pattern, good separation of concerns in workflow subsystem |
| Correctness | A- | All critical/high/medium issues resolved; minor edge cases remain |
| Type Safety | B+ | Strong Zod usage, strict tsconfig, exhaustiveness checks added |
| Security | A- | Headers, body limits, prototype pollution, and error sanitization all addressed |
| Test Coverage | A- | 654 tests; OS signal handling, orchestrator, malformed requests, doctor, cache store covered |
| Performance | B | Async catalog I/O, transcript/frame caps, backpressure; TUI re-render concerns remain |
| Maintainability | B- | App.tsx monolith (decomposed from 1905), server.ts route organization |

**Remaining findings: 20** (0 Critical, 0 High, 0 Medium, 20 Low)

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

(none remaining)

---

## 2. High Findings

(none remaining)

---

## 3. Medium Findings

(none remaining)

---

## 4. Low Findings

### L1. `LineBuffer.push` uses O(n²) string concatenation
- **File:** `src/agents/line-buffer.ts:15`

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

### L14. `closeAllConnections?.()` requires Node >= 18.2.0
- **File:** `src/index.tsx:70`

### L17. `homeRelativePath` follows symlinks
- **File:** `src/paths.ts:6-7`

### L19. Client-side `getElementById` lacks null guards
- **File:** `src/web/html.ts`

### L20. Port 0 accepted without notification
- **File:** `src/cli.ts:88-95`

### L23. Temp directory cleanup inconsistency in tests
- **File:** ~15 test files

### L28. SSE reader doesn't handle partial `data:` lines
- **File:** `tests/web-server.test.ts:132-158`

### L29. `reducer-build.test.ts` runs esbuild inside a test
- **File:** `tests/reducer-build.test.ts:10-41`

### L33. `MenuBackdrop` negative margin overlay is fragile
- **File:** `src/tui/CommandSuggestionMenu.tsx:106-119`

### L40. `STATUS_GLYPH` vs `STATUS_STYLE` naming confusion
- **File:** `src/tui/WorkflowHistory.tsx:14-18`

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
*Last updated: 2026-06-29*
*Files reviewed: 80+ source files, 70 test files, 5 build configs*
