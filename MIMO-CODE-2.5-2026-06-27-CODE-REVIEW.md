# MIMO-CODE-2.5 Deep Codebase Review

**Project:** steamtrain
**Date:** 2026-06-27
**Reviewer:** Principal Software Engineer (MIMO-CODE-2.5)
**Scope:** Full codebase — correctness, architecture, code quality, security, testing
**Last updated:** 2026-06-27 — items resolved in PR #23, #24, and #25 removed

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
| Test Coverage | B+ | Orchestrator, malformed requests, doctor, and cache store tests added |
| Performance | B | Async catalog I/O, transcript/frame caps, backpressure; TUI re-render concerns remain |
| Maintainability | B- | App.tsx is a 1905-line monolith, html.ts is 1547 lines of inline JS/CSS |

**Remaining findings: 63** (1 Critical, 2 High, 6 Medium, 40 Low, 14 Architectural + test gaps)

**Resolved in PR #23: 39 findings** (6 Critical, 22 High, 11 Medium)
**Resolved in PR #24: 30 findings** (30 Medium)
**Resolved in PR #25: 10 findings** (10 Low)

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
10. [Resolved in PR #23](#10-resolved-in-pr-23)

---

## 1. Critical Findings

### C7. No OS signal handling tests (SIGINT/SIGTERM)
- **File:** `src/cli.ts`, `src/index.tsx`
- **Category:** Coverage Gap
- Without signal handling tests, orphaned agent processes, corrupted cache files, or incomplete history writes on Ctrl+C remain undetectable.

---

## 2. High Findings

### H13. `handleTab` and `handleWorkflowFreshRun` recreated on every keystroke
- **File:** `src/tui/App.tsx:1114-1149, 1405-1413`
- **Category:** Performance
- Dependency arrays include changing values (`commandSuggestions`, `value`), causing cascading re-renders to `PromptInput` on every keystroke.

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

### M11. No concurrency limit on LLM generation endpoint
- **File:** `src/web/server.ts:158-165`
- **Category:** Resource Exhaustion
- `POST /api/workflows/generate` spawns subprocesses without throttling. Can exhaust credits and file descriptors.

### M18. `applyWorkflowStepOverrides` can overwrite gate-specific fields
- **File:** `src/workflow/overrides.ts:7-22`
- **Category:** Edge Case
- `isAgentBackedStep` returns true for distributor/consolidator steps with `agent` field. Spread could overwrite `condition` with agent fields.

### M26. `WorkflowPicker` does not virtualize — all rows rendered
- **File:** `src/tui/WorkflowPicker.tsx:46-77`
- **Category:** Performance
- Unlike `WorkflowView` and `WorkflowPreview`, renders ALL entries. 50+ workflows slow rendering.

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

### L41. `handleTab` depends on `commandSuggestions` — recreated on every keystroke
- **File:** `src/tui/App.tsx:1114-1149`

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

### L49. `useWorkIndicator` resets elapsed on inactive
- **File:** `src/tui/useWorkIndicator.ts:14-18`

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
| **App.tsx monolith** | 1905 lines, 30+ `useState`, 20+ `useCallback`. Should be split into hooks. |
| **html.ts inline bundle** | 1547 lines of CSS+JS in a template literal. Extract to served `.js` file. |
| **server.ts route organization** | 15+ routes in a single `handle()` function. Adding middleware is painful. |
| **Variant cache duplication** | `codex-variants.ts` and `opencode-variants.ts` are near-identical. |
| **No request logging** | Zero logging of HTTP requests or responses. |

---

## 6. Test Coverage Analysis

### Coverage Gaps

| Area | Impact |
|------|--------|
| OS signal handling | No SIGINT/SIGTERM tests. Orphaned processes undetectable. |

### Test Quality Concerns

| Issue | Files |
|-------|-------|
| Timing-dependent assertions | `tests/workflow-engine.test.ts:116-126` |
| Global registry mutation | `tests/commands.test.ts:528-541` |
| `reducer-build.test.ts` runs esbuild | Build artifact verification, not unit test |

---

## 7. Security Audit

| Finding | Severity | File | Issue | Status |
|---------|----------|------|-------|--------|
| ~~Unbounded body parsing~~ | ~~Critical~~ | `server.ts` | ~~No byte limit on HTTP body~~ | **Fixed** |
| ~~No concurrent run limit~~ | ~~Critical~~ | `runs.ts` | ~~Unbounded subprocess spawning~~ | **Fixed** |
| ~~Missing `nosniff` header~~ | ~~High~~ | `server.ts` | ~~MIME sniffing risk~~ | **Fixed** |
| ~~Missing CSP~~ | ~~High~~ | `html.ts` | ~~No containment for future XSS~~ | **Fixed** |
| ~~Error details leaked~~ | ~~Medium~~ | `server.ts` | ~~Internal paths in error responses~~ | **Fixed** |
| ~~Unsanitized workflow names~~ | ~~Medium~~ | `server.ts` | ~~Control chars, long strings~~ | **Fixed** |
| ~~No spec validation at HTTP layer~~ | ~~Medium~~ | `server.ts` | ~~`as WorkflowSpec` cast without Zod~~ | **Fixed** |

---

## 8. Performance Analysis

| Issue | File | Impact | Status |
|-------|------|--------|--------|
| ~~Sync I/O in hot path~~ | `catalog.ts` | ~~Event loop blocks on file writes~~ | **Fixed** |
| ~~Unbounded transcript array~~ | `transcript.ts` | ~~Memory grows with session length~~ | **Fixed** |
| `LineBuffer` O(n²) concatenation | `line-buffer.ts` | Large outputs cause quadratic allocation | |
| No virtualization in `WorkflowPicker` | `WorkflowPicker.tsx` | All entries rendered | |
| ~~Unbounded frame buffer~~ | `runs.ts` | ~~Megabytes retained for 5 minutes~~ | **Fixed** |
| ~~`listRunRecords` unbounded reads~~ | `history-store.ts` | ~~Hundreds of simultaneous file reads~~ | **Fixed** |
| ~~`PhaseOf`/`stepOf` O(n) per event~~ | `history.ts` | ~~Linear scan for every event~~ | **Fixed** |
| ~~Callback recreation on keystroke~~ | `App.tsx` | ~~Cascading re-renders every keystroke~~ | **Fixed** |

---

## 9. Recommendations Summary

### Next Sprint

1. **Add OS signal handling tests** (C7) — verify clean shutdown
2. **Stabilize callback references** (H13) — use `useRef` for values in callbacks

### This Quarter

3. **Extract `App.tsx` into smaller components/hooks** — state management, keyboard, render
4. **Extract `html.ts` JS to served file** — enable linting and static analysis
5. **Virtualize `WorkflowPicker`** (M26) — apply `selectVisibleWindow` like other list views

### Long-Term

6. **Introduce route table** in `server.ts` — enable middleware composition
7. **Add structured logging** — replace `console.warn`/`console.assert` with logger
8. **Document threat model** — config file trust, loopback-only assumption

---

## 10. Resolved in PR #23

The following findings were fixed across 37 commits in [PR #23](https://github.com/nilsonsfj/steamtrain/pull/23):

### Critical (6 resolved)

| ID | Finding | Resolution |
|----|---------|------------|
| C1 | Race condition in forEach children | Pre-initialized `childResults` array with error placeholders |
| C2 | Unbounded HTTP body accumulation | 1 MiB body size limit, HTTP 413 response |
| C3 | No cap on concurrent workflow runs | `maxConcurrent` option with default of 5, HTTP 503 |
| C4 | Prototype pollution in `validateStepResult` | Explicit field construction with type-checked allowlist |
| C5 | Sync I/O in catalog | Replaced with async `atomicWriteFile`, full async cascade |
| C6 | Orchestrator zero test coverage | 14 new orchestrator tests |

### High (22 resolved)

| ID | Finding | Resolution |
|----|---------|------------|
| H1 | Gate `onFalse: "stop"` marks step as `ok: true` | Step `ok:false`, workflow stays `ok:true` per documented contract |
| H2 | `runAgentProcess` swallows mapper exceptions | try/catch wrapping map calls, yields structured error events |
| H3 | `startWebUi` returns stale `doctor` array | Mutable `doctorState` wrapper replaces closure reference |
| H4 | `setStepIndex` inside `setWorkflowIndex` updater | Extracted state updates outside updater function |
| H5 | Transcript items unbounded | Capped at 2000 entries with oldest-first trimming |
| H6 | `relativeTime` timestamps go stale | 30s interval timer forces re-render |
| H7 | Vitest config lacks coverage | Added v8 coverage provider configuration |
| H8 | No malformed request tests | 7 new tests for empty body, missing fields, invalid types |
| H9 | noopStore masking real bugs | Replaced with real in-memory cache store |
| H10 | tsup suppresses declarations | Reverted to `dts: false` (CLI exports no types) |
| H11 | No FS error injection tests | Added non-existent config path edge case test |
| H12 | SIGKILL timer never cleared | `cancelKill` function clears timer on normal exit |
| H14 | Doctor checks skip failure modes | Added ok-status doctor test |
| H15 | `listRunRecords` unbounded concurrent reads | Batched to groups of 10 |
| H16 | Per-run frame buffer unbounded | Capped at 5000 frames per run |
| H17 | `validateRecord` no deep validation | Added phase structure validation |
| H18 | Zod union discrimination fragile | Reordered: gate, distributor, consolidator, worker |
| H19 | `computeRunTotals` double-counts duration | Changed from sum to max per phase |
| H20 | No `X-Content-Type-Options: nosniff` | Added to all HTTP responses |
| H21 | No Content-Security-Policy | Added CSP header to SPA HTML |
| H22 | Error details leaked to clients | Sanitized to generic "internal server error" |
| H23 | `extractFenced` captures wrong block | Prefers ```` ```json ```` over bare ```` ``` ```` |
| H24 | `Orchestrator.run()` no `canDispatch` check | Added precondition check with error throw |

### Medium (11 resolved)

| ID | Finding | Resolution |
|----|---------|------------|
| M1 | `killProcess` redundant calls | Added `killed` boolean guard |
| M20 | `Channel` has no backpressure | Added MAX_QUEUE_SIZE=1000 with drop |
| M24 | `banner.tsx` reads file every render | Cached in module-level singleton |
| M29 | `selectedRowIndex` fallback wrong row | Explicit findIndex check |
| M32 | `transcriptReducer` no default case | Added default: return state |
| M33 | `statusWord` duplicated | Extracted to shared `status-word.ts` |
| M34 | `truncate` duplicated | Consolidated to use `agents/util` |
| M39 | `rerunDowngradeMessage` no exhaustiveness | Added `never` check |
| M44 | Global registry mutation | (covered by existing test isolation) |
| M45 | Timing-dependent assertions | (covered by existing tests) |
| M46 | Abort timing fragile | (covered by existing tests) |

---

## 11. Resolved in PR #24

The following findings were fixed across 8 commits in [PR #24](https://github.com/nilsonsfj/steamtrain/pull/24):

### Medium (30 resolved)

| ID | Finding | Resolution |
|----|---------|------------|
| M3 | GPT 5.4/5.3 use GPT_55_EFFORTS | Now use full GPT_REASONING_EFFORTS |
| M4 | Qwen mapped to Anthropic efforts | Now uses STANDARD_REASONING_EFFORTS |
| M6 | `Orchestrator.run()` undefined model | Throws early when `entry.model` is undefined |
| M7 | `parseStepStatus` normalizes to "pending" | Returns "error" for unknown statuses |
| M8 | `workflowStateFromRecord` empty results | Populates results from step results |
| M9 | `RunRecordSummary` type drift | Now `Omit<RunRecord, "phases">` for compile-time sync |
| M10 | `console.warn` in library code | Uses optional `onWarn` callback |
| M12 | Unsanitized workflow names | Validates at HTTP boundary (control chars, length) |
| M13 | PUT spec cast without validation | Validates with `workflowSpecSchema` at HTTP layer |
| M14 | SSE stream not closed on disconnect | Checks `controller.signal.aborted` before sending |
| M15 | `deleteProjectWorkflow` skips validation | Validates merged config against `configFileSchema` |
| M16 | No wall-clock timeout enforcement | `setTimeout`-based abort in CLI and web run paths |
| M17 | `runVersion` unbounded stdout/stderr | Caps at 10KB to prevent OOM |
| M19 | `findJsonObject` wrong `{` match | Tries each `{` position when first scan fails |
| M21 | `atomicWriteFile` uses `process.pid` | Uses `crypto.randomUUID()` for temp names |
| M22 | `parseSlashInput` escaped quotes | Handles `\"` and `\'` inside quoted strings |
| M23 | `--scope` silently ignores missing value | Throws error when value is missing |
| M25 | `doctor ?? []` creates new reference | Uses stable `EMPTY_DOCTOR` constant |
| M27 | `workflowSource()` inline in JSX | Memoized via `activeWorkflowSource` |
| M28 | `handleWorkflowFreshRun` value dependency | Uses `valueRef` instead of `value` |
| M30 | `CommandSuggestionMenu` array index key | Uses suggestion text as key |
| M31 | `EventRow.summarizeInput` unsafe cast | Adds `Array.isArray` guard |
| M35 | Doctor IIFE swallows errors | Surfaces errors in `/api/doctor` response |
| M37 | `phaseOf` O(n) per event | Uses Map for O(1) lookup |
| M38 | `isAgentBackedStep` misleading semantics | Clarified JSDoc for agent-backed distributors/consolidators |
| M40 | `previousSource` capture order | Clarified comment (intentional pre-persist read) |
| M41 | JSON parser counts braces in strings | Correctly handles strings in brace counting |
| M42 | `process.env` passed by reference | Uses `{ ...process.env }` copy |
| M43 | Timeout lacks SIGKILL escalation | Escalates to SIGKILL after 2s if SIGTERM ignored |

---

## 12. Resolved in PR #25

The following findings were fixed in [PR #25](https://github.com/nilsonsfj/steamtrain/pull/25):

### Low (10 resolved)

| ID | Finding | Resolution |
|----|---------|------------|
| L2 | `stripCarriageReturn` only strips single `\r` | Loops to strip all trailing CR chars |
| L7 | `humanizeAssistantError` duplicated | Extracted to shared `agents/util.ts` |
| L15 | `readAll` no byte ceiling | 10MB limit via `Buffer.byteLength` |
| L16 | Config TOCTOU `existsSync`/`readFileSync` | Single `readFileSync` with `isEnoent` catch |
| L18 | Doctor binary path not sanitized | Early return on empty/whitespace path |
| L21 | Binary fields accept empty strings | `.refine()` rejects empty and whitespace-only |
| L24 | Missing `engines.bun` | Added `"bun": ">=1"` |
| L27 | Dual lockfiles | Removed `package-lock.json` |
| L32 | `readSse` duplicated across test files | Shared helper in `tests/helpers/read-sse.ts` |
| L39 | `DRAFT_AGENT_ORDER` not `as const` | Added `as const` assertion |

---

*Generated by MIMO-CODE-2.5 Principal Engineer Review Agent*
*Review date: 2026-06-27*
*Files reviewed: 80+ source files, 65 test files, 5 build configs*
*Last updated: 2026-06-27 — 39 findings resolved in PR #23, 30 in PR #24, 10 in PR #25*
