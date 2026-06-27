# MIMO-CODE-2.5 Deep Codebase Review

**Project:** steamtrain
**Date:** 2026-06-27
**Reviewer:** Principal Software Engineer (MIMO-CODE-2.5)
**Scope:** Full codebase — correctness, architecture, code quality, security, testing
**Last updated:** 2026-06-27 — items resolved in PR #23 (37 commits) removed

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

**Remaining findings: 108** (1 Critical, 2 High, 40 Medium, 50 Low, 15 Architectural + test gaps)

**Resolved in PR #23: 39 findings** (6 Critical, 22 High, 11 Medium)

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

### M3. `codex-efforts-fallback.ts` — GPT 5.4/5.3 use GPT_55_EFFORTS
- **File:** `src/agents/codex-efforts-fallback.ts:13-15`
- **Category:** Correctness
- GPT 5.4, 5.3, 5.2 all use `GPT_55_EFFORTS` instead of their own. May artificially restrict available effort levels.

### M4. `opencode-efforts-fallback.ts` maps `qwen` to Anthropic efforts
- **File:** `src/agents/opencode-efforts-fallback.ts:46-48`
- **Category:** Correctness
- Qwen models on OpenCode Zen get Anthropic's effort levels (`["high", "max"]`). Likely a copy-paste error.

### M5. Prompt-as-positional-arg pattern is fragile across all adapters
- **File:** `src/agents/codex.ts:285-299`, `claude.ts:227`, `opencode.ts:244`
- **Category:** Correctness / Security
- Prompt as last positional arg conflicts with CLI flag grammar changes. Consider stdin piping or `--prompt` flag.

### M6. `Orchestrator.run()` doesn't pass `defaultModelForAgent` when model is undefined
- **File:** `src/orchestrator/orchestrator.ts:103-110`
- **Category:** Edge Case
- If `entry.model` is undefined, adapter passes `--model undefined` to CLI, causing errors.

### M7. `parseStepStatus` silently normalizes unknown statuses to `"pending"`
- **File:** `src/workflow/reducer.ts:159-164`
- **Category:** Error Swallowing
- Corrupt history record with `status: "running"` for finalized run displays as spinning step.

### M8. `workflowStateFromRecord` does not populate `results` array
- **File:** `src/workflow/reducer.ts:133-157`
- **Category:** State Management
- Sets `results: []`. Any downstream code reading `state.results` gets empty data.

### M9. `runRecordSummary` has no compile-time type sync guarantee
- **File:** `src/workflow/history.ts:101-104`
- **Category:** Type Safety
- Rest-spread drops `phases` correctly, but no compile-time guarantee `RunRecordSummary` stays in sync with `RunRecord`.

### M10. `extractWorkflowSpec` uses `console.warn` in library code
- **File:** `src/workflow/generate.ts:305-309`
- **Category:** Architecture
- Library code should not write to stdout. Bypasses structured logging.

### M11. No concurrency limit on LLM generation endpoint
- **File:** `src/web/server.ts:158-165`
- **Category:** Resource Exhaustion
- `POST /api/workflows/generate` spawns subprocesses without throttling. Can exhaust credits and file descriptors.

### M12. Workflow name unsanitized at HTTP boundary
- **File:** `src/web/server.ts:167-169`
- **Category:** Input Validation
- Names with control characters, null bytes, or extreme length flow into map lookups and error messages.

### M13. PUT `/api/workflows/:name` casts spec without layer-0 validation
- **File:** `src/web/server.ts:194-203`
- **Category:** Input Validation
- Checks `typeof parsed.spec !== "object"` but passes `as WorkflowSpec` without Zod validation at the HTTP layer.

### M14. SSE stream not closed promptly on client disconnect
- **File:** `src/web/server.ts:318-377`
- **Category:** Resource Leak
- After `await author.generate()`, no check for `controller.signal.aborted`. Server continues processing after client is gone.

### M15. `deleteProjectWorkflow` skips schema validation before write
- **File:** `src/config/project-workflows.ts:108-123`
- **Category:** Correctness
- `saveProjectWorkflow` validates against `configFileSchema`, but `deleteProjectWorkflow` writes directly.

### M16. CLI and web runner lack wall-clock timeout on workflow execution
- **File:** `src/cli.ts:499-511`, `src/web/runs.ts:210-303`
- **Category:** Resource Exhaustion
- `config.timeoutMs` defined but never enforced with `setTimeout`. Hung agent subprocesses block forever.

### M17. `runVersion` pipes stderr/stdout without size limits
- **File:** `src/doctor/doctor.ts:66-101`
- **Category:** Resource Exhaustion
- Broken binary writing gigabytes to stdout within 8-second timeout could OOM the doctor check.

### M18. `applyWorkflowStepOverrides` can overwrite gate-specific fields
- **File:** `src/workflow/overrides.ts:7-22`
- **Category:** Edge Case
- `isAgentBackedStep` returns true for distributor/consolidator steps with `agent` field. Spread could overwrite `condition` with agent fields.

### M19. `findJsonObject` doesn't handle `{` in explanatory text
- **File:** `src/workflow/generate.ts:434-459`
- **Category:** Edge Case
- When no fenced block exists, `{` in explanatory text could match first, causing balanced-brace scan to fail silently.

### M21. `atomicWriteFile` temp naming uses `process.pid`
- **File:** `src/workflow/fs-util.ts:18-22`
- **Category:** Edge Case
- Same PID in test suites could collide. `crypto.randomUUID()` would be safer.

### M22. `parseSlashInput` doesn't handle escaped quotes
- **File:** `src/commands/parse.ts:13`
- **Category:** Edge Case
- `"hello \"world\""` splits at inner escaped quote.

### M23. `extractWorkflowScope` silently ignores missing `--scope` value
- **File:** `src/commands/workflow-scope.ts:18-23`
- **Category:** Edge Case
- `--scope` as last argument has `undefined` value, silently ignored instead of erroring.

### M25. `orchestrator` memo depends on `doctor ?? []` creating new orchestrator on load
- **File:** `src/tui/App.tsx:259-262`
- **Category:** Performance
- `doctor` starts null, `??` creates new `[]` reference, cascading recreation of `authoringHost`, `author`, etc.

### M26. `WorkflowPicker` does not virtualize — all rows rendered
- **File:** `src/tui/WorkflowPicker.tsx:46-77`
- **Category:** Performance
- Unlike `WorkflowView` and `WorkflowPreview`, renders ALL entries. 50+ workflows slow rendering.

### M27. `orchestrator.workflowSource()` called inline in JSX
- **File:** `src/tui/App.tsx:1647,1669`
- **Category:** Performance
- Called during render without memoization. Should use `useMemo`.

### M28. `handleWorkflowFreshRun` recreated on every keystroke (value dependency)
- **File:** `src/tui/App.tsx:1405-1413`
- **Category:** Performance
- `value` in deps causes re-creation every keystroke, cascading re-renders to `PromptInput`.

### M30. `CommandSuggestionMenu` uses array index as key
- **File:** `src/tui/CommandSuggestionMenu.tsx:153`
- **Category:** Correctness
- Same suggestion at different indices could collide. Changing suggestions cause unnecessary re-mounts.

### M31. `EventRow` `summarizeInput` uses unsafe type assertion
- **File:** `src/tui/EventRow.tsx:157-158`
- **Category:** Type Safety
- `as Record<string, unknown>` on `typeof input === "object"` without Array check.

### M35. Doctor IIFE silently swallows all errors
- **File:** `src/web/server.ts:481-496`
- **Category:** Error Handling
- `/api/doctor` permanently returns `[]` if any error occurs. No mechanism for UI to know doctor failed.

### M36. No CORS headers on any endpoint
- **File:** `src/web/server.ts`
- **Category:** HTTP Handling
- Acceptable for loopback binding, but `--host 0.0.0.0` exposes server on network.

### M37. `runRecordBuilder.phaseOf` is O(n) per event
- **File:** `src/workflow/history.ts:350-358`
- **Category:** Performance
- Linear scan for every event. `Map<string, Map>` lookup would be O(1).

### M38. `isAgentBackedStep` returns true for distributor/consolidator with `agent`
- **File:** `src/workflow/types.ts:378-380`
- **Category:** Type Safety
- Semantically misleading — consolidator with `agent` is not a "worker step with agent."

### M40. `WorkflowAuthor.save` captures `previousSource` before `persist`
- **File:** `src/workflow/authoring.ts:189-228`
- **Category:** Edge Case
- If `persist` triggers `reload()` changing source mapping, captured `previousSource` may be stale.

### M41. `codex-variants.ts` parser counts braces inside JSON strings
- **File:** `src/agents/opencode-variants.ts:38-48`
- **Category:** Correctness
- JSON block parser counts `{`/`}` without skipping strings. Strings containing braces cause miscounting.

### M42. `process.env` passed by reference to spawned processes
- **File:** `src/agents/codex-variants.ts:64-66`, `src/agents/opencode-variants.ts:69-71`
- **Category:** Correctness
- `env: process.env` shares parent's env object. `spawn.ts` correctly uses `{...process.env}`.

### M43. `codex-variants.ts` and `opencode-variants.ts` timeout lacks SIGKILL escalation
- **File:** `src/agents/codex-variants.ts:71-74`, `src/agents/opencode-variants.ts:76-79`
- **Category:** Resource Management
- Only sends SIGTERM on timeout. Process could hang forever if it ignores SIGTERM. `spawn.ts` has 2s SIGKILL fallback.

### M44. `commands.test.ts` mutates global slash command registry
- **File:** `tests/commands.test.ts:528-541`
- **Category:** Test Isolation
- Overrides built-in `version` command without `beforeEach`/`afterEach` guard. Parallel test bleed risk.

### M45. Timing-dependent concurrency assertions
- **File:** `tests/workflow-engine.test.ts:116-126`
- **Category:** Flakiness Risk
- `delayMs: 20` with `peak === 3` assertion relies on cooperative scheduling. Heavily loaded CI may fail.

### M46. Abort timing in retry test is fragile
- **File:** `tests/retry-engine.test.ts:196-208`
- **Category:** Flakiness Risk
- `setTimeout(() => controller.abort(), 50)` during 5000ms backoff. Slow machines may land abort during run phase.

---

## 4. Low Findings

### L1. `LineBuffer.push` uses O(n²) string concatenation
- **File:** `src/agents/line-buffer.ts:15`

### L2. `LineBuffer.stripCarriageReturn` only strips single trailing `\r`
- **File:** `src/agents/line-buffer.ts:44-46`

### L3. `stringifyContent` doesn't handle circular references gracefully
- **File:** `src/agents/util.ts:4,26-32`

### L4. `codex-efforts-fallback.ts` GPT 5.4/5.3/5.2 all use GPT_55_EFFORTS
- **File:** `src/agents/codex-efforts-fallback.ts:13-15`

### L5. `opencode-efforts-fallback.ts` maps Qwen to Anthropic efforts
- **File:** `src/agents/opencode-efforts-fallback.ts:46-48`

### L6. `codex-variants.ts` and `opencode-variants.ts` share duplicated interfaces
- **File:** `src/agents/codex-variants.ts:8-11`, `src/agents/opencode-variants.ts:8-11`

### L7. `humanizeAssistantError` duplicated between `claude.ts` and `amp.ts`
- **File:** `src/agents/claude.ts:200-205`, `src/agents/amp.ts:142-147`

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

### L15. `readAll` in CLI has no byte ceiling
- **File:** `src/cli.ts:918-928`

### L16. Config TOCTOU: `existsSync` before `readFileSync`
- **File:** `src/config/project-workflows.ts:132-140`

### L17. `homeRelativePath` follows symlinks
- **File:** `src/paths.ts:6-7`

### L18. Doctor binary path from config not sanitized
- **File:** `src/doctor/doctor.ts:66-70`

### L19. Client-side `getElementById` lacks null guards
- **File:** `src/web/html.ts`

### L20. Port 0 accepted without notification
- **File:** `src/cli.ts:88-95`

### L21. `configFileSchema` binary fields accept empty strings
- **File:** `src/config/types.ts:28-33`

### L22. EventSource auto-reconnect after run completion
- **File:** `src/web/html.ts:976-996`

### L23. Temp directory cleanup inconsistency in tests
- **File:** ~15 test files

### L24. `package.json` lacks `engines.bun` constraint
- **File:** `package.json:12`

### L25. No test timeout configuration
- **File:** `vitest.config.ts`

### L26. `biome.json` disables `useImportType`
- **File:** `biome.json:37`

### L27. Dual lockfiles (`bun.lock` and `package-lock.json`)
- **Files:** `bun.lock`, `package-lock.json`

### L28. SSE reader doesn't handle partial `data:` lines
- **File:** `tests/web-server.test.ts:132-158`

### L29. `reducer-build.test.ts` runs esbuild inside a test
- **File:** `tests/reducer-build.test.ts:10-41`

### L30. Hardcoded `/tmp` in many test specs
- **File:** `tests/workflow-engine.test.ts:77`

### L31. `codex-efforts.test.ts` uses `beforeEach` but `models.test.ts` doesn't
- **File:** `tests/codex-efforts.test.ts:25-27`

### L32. `readSse` helper duplicated across 3 test files
- **Files:** `tests/web-server.test.ts`, `tests/web-loops.test.ts`, `tests/workflow-authoring.test.ts`

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

### L39. `DRAFT_AGENT_ORDER` not `as const`
- **File:** `src/tui/draft-model.ts:16`

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
| **Duplicate functions** | `humanizeAssistantError` in `claude.ts`/`amp.ts`. |
| **No request logging** | Zero logging of HTTP requests or responses. |
| **Dead config** | `config.timeoutMs` defined but never enforced in CLI or web run paths. |

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
| Unsanitized workflow names | Medium | `server.ts:167-169` | Control chars, long strings | |
| No spec validation at HTTP layer | Medium | `server.ts:194-203` | `as WorkflowSpec` cast without Zod | |

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
| `PhaseOf`/`stepOf` O(n) per event | `history.ts` | Linear scan for every event | |
| Callback recreation on keystroke | `App.tsx` | Cascading re-renders every keystroke | |

---

## 9. Recommendations Summary

### Next Sprint

1. **Add OS signal handling tests** (C7) — verify clean shutdown
2. **Stabilize callback references** (H13) — use `useRef` for values in callbacks
3. **Validate workflow names at HTTP boundary** (M12) — reject control chars, enforce length limit
4. **Enforce `config.timeoutMs` in CLI and web** (M16) — `setTimeout`-based abort

### This Quarter

5. **Extract `App.tsx` into smaller components/hooks** — state management, keyboard, render
6. **Extract `html.ts` JS to served file** — enable linting and static analysis
7. **Virtualize `WorkflowPicker`** — apply `selectVisibleWindow` like other list views

### Long-Term

8. **Introduce route table** in `server.ts` — enable middleware composition
9. **Add structured logging** — replace `console.warn`/`console.assert` with logger
10. **Document threat model** — config file trust, loopback-only assumption

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

*Generated by MIMO-CODE-2.5 Principal Engineer Review Agent*
*Review date: 2026-06-27*
*Files reviewed: 80+ source files, 65 test files, 5 build configs*
*Last updated: 2026-06-27 — 39 findings resolved in PR #23 (37 commits)*
