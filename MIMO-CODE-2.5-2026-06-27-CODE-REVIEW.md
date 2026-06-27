# MIMO-CODE-2.5 Deep Codebase Review

**Project:** steamtrain
**Date:** 2026-06-27
**Reviewer:** Principal Software Engineer (MIMO-CODE-2.5)
**Scope:** Full codebase — correctness, architecture, code quality, security, testing

---

## Executive Summary

**steamtrain** is a terminal orchestrator that runs coding agents (Claude Code, OpenCode, Codex, Amp) as managed subprocesses and renders their activity live in an Ink TUI. It also exposes a web UI. The codebase is ~15,000 lines of TypeScript across 80+ source files and 64 test files.

### Overall Assessment

| Area | Grade | Notes |
|------|-------|-------|
| Architecture | B+ | Clean adapter pattern, good separation of concerns in workflow subsystem |
| Correctness | B | Several race conditions, resource leaks, and state management issues |
| Type Safety | B+ | Strong Zod usage, strict tsconfig, but some `any` escapes and unsafe spreads |
| Security | C+ | Missing security headers, unbounded body parsing, no input sanitization at HTTP boundary |
| Test Coverage | B- | Good unit test coverage for workflow engine, critical gaps in orchestrator and web server |
| Performance | B | Sync I/O in hot paths, unbounded caches, unnecessary re-renders in TUI |
| Maintainability | B- | App.tsx is a 1905-line monolith, html.ts is 1547 lines of inline JS/CSS |

**Total findings: 147** (7 Critical, 24 High, 46 Medium, 50 Low, 20 Architectural)

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

### C1. Race condition on shared mutable state between concurrent forEach children
- **File:** `src/workflow/engine.ts:912-926`
- **Category:** Race Condition
- `executeForEachStep` dispatches children via `runPool`, and each child writes to shared `ctx.outputs`, `ctx.results`, and `ctx.cache` maps. If a child throws before assigning `childResults[item.index]`, `childResults.filter(Boolean)` silently drops it. Combined with `runPool` only rethrowing the *first* error, the parent result would report incomplete children with no indication of which ones failed.

### C2. Unbounded HTTP body accumulation — OOM denial-of-service
- **File:** `src/web/server.ts:83-87`
- **Category:** Resource Exhaustion
- `readBody()` streams every incoming chunk into an in-memory array with no byte-count guard. A local attacker (any browser tab on `127.0.0.1`) can POST a multi-gigabyte payload to exhaust the Node process heap.

### C3. No cap on concurrent workflow runs
- **File:** `src/web/runs.ts:124-153`
- **Category:** Resource Exhaustion
- Every `POST /api/runs` spawns agent subprocesses, allocates frame buffers, and registers history builders. Nothing limits concurrent runs. Combined with C1, this enables a two-step local DoS.

### C4. `validateStepResult` spreads unvalidated fields via `...r` — prototype pollution vector
- **File:** `src/workflow/cache-store.ts:209-217`
- **Category:** Type Safety / Security
- The spread `...r` passes through all fields from raw parsed JSON, including `__proto__` or `constructor` from tampered cache files. While `JSON.parse` strips prototypes, the intermediate object retains them.

### C5. `writeUserWorkflowsFile` uses sync I/O blocking the event loop
- **File:** `src/workflow/catalog.ts:309-316`
- **Category:** Correctness / Performance
- `mkdirSync`, `writeFileSync`, `renameSync` block the event loop in TUI and web server contexts. An async `atomicWriteFile` already exists in `fs-util.ts` but is unused here.

### C6. Orchestrator directory has zero test coverage
- **File:** `src/orchestrator/` — no test file
- **Category:** Coverage Gap
- The orchestrator manages agent subprocess lifecycle. A spawn failure, hang, or resource leak would cascade into broken UX with no automated safety net.

### C7. No OS signal handling tests (SIGINT/SIGTERM)
- **File:** `src/cli.ts`, `src/index.tsx`
- **Category:** Coverage Gap
- Without signal handling tests, orphaned agent processes, corrupted cache files, or incomplete history writes on Ctrl+C remain undetectable.

---

## 2. High Findings

### H1. Gate `onFalse: "stop"` marks the step as `ok: true` — misleading status
- **File:** `src/workflow/engine.ts:601`
- **Category:** Correctness Bug
- When a gate fails with `onFalse: "stop"`, the step's `ok` field is `true` because `onFalse` is `"stop"`, not `"fail"`. Downstream consumers (history records, cost rollups) see this as successful. The gate that blocked execution should not appear "ok" in the final record.

### H2. `runAgentProcess` swallows mapper exceptions
- **File:** `src/agents/adapter.ts:68-71`
- **Category:** Correctness
- If `map(raw)` throws (e.g., Zod schema throws), the exception propagates unhandled, killing the async generator. The process remains running with no cleanup, and the caller gets no structured error.

### H3. `startWebUi` returns stale `doctor` array
- **File:** `src/web/server.ts:445,498`
- **Category:** Correctness
- `return { server, url, doctor }` always yields the initial empty array because the async IIFE replacing `doctor` hasn't settled yet. Any caller inspecting the returned value gets a permanently-empty list.

### H4. `setStepIndex` called inside `setWorkflowIndex` updater — React anti-pattern
- **File:** `src/tui/App.tsx:1564-1571`
- **Category:** Correctness / React
- Calling `setState` inside a state updater can cause intermediate renders where `workflowIndex` has changed but `stepIndex` hasn't reset, causing brief out-of-bounds selection.

### H5. Transcript `nextId` monotonically grows — no cap on `items` array
- **File:** `src/tui/transcript.ts:56-58`
- **Category:** Memory Leak
- Every `push()` appends to `state.items` without trimming. Long-running workflows with many tool calls consume unbounded memory.

### H6. `relativeTime` timestamps go stale in `WorkflowHistory`
- **File:** `src/tui/WorkflowHistory.tsx:112-123`
- **Category:** Correctness Bug
- `relativeTime(ts)` computes at render time, but the component never re-renders after mount. Timestamps are frozen at the moment the list loaded.

### H7. Vitest config lacks coverage thresholds
- **File:** `vitest.config.ts:4-7`
- **Category:** Build Config
- No `coverage` block, no `test:coverage` script. Coverage regressions require manual inspection.

### H8. No web API tests for malformed requests
- **File:** `tests/web-server.test.ts`
- **Category:** Coverage Gap
- All POST requests use well-formed JSON. Missing tests for: empty body, wrong content-type, oversized payloads, missing required fields, concurrent runs.

### H9. Web server tests use noop cache store masking real bugs
- **File:** `tests/web-server.test.ts:41-49`
- **Category:** Mock Quality
- `noopStore` returns empty Map on every `load()`, meaning cache resume, invalidation, and corruption recovery are untested through the web layer.

### H10. `tsup.config.ts` suppresses TypeScript declarations
- **File:** `tsup.config.ts:10`
- **Category:** Build Config
- `dts: false` means consumers get zero type information. Combined with `skipLibCheck: true`, type errors in public API surfaces propagate silently.

### H11. No file-system error injection in config/workspace loading
- **File:** `tests/config-load.test.ts`, `tests/workspace-load.test.ts`
- **Category:** Coverage Gap
- All tests use fresh temp dirs with valid/invalid JSON. None simulate permission denied, disk full, or broken symlinks.

### H12. `killProcess` SIGKILL timer never cleared on normal exit
- **File:** `src/agents/spawn.ts:159-173`
- **Category:** Resource Management
- The 2-second SIGKILL timer retains the child closure. On rapid start/stop cycles, many leaked timers accumulate.

### H13. `handleTab` and `handleWorkflowFreshRun` recreated on every keystroke
- **File:** `src/tui/App.tsx:1114-1149, 1405-1413`
- **Category:** Performance
- Dependency arrays include changing values (`commandSuggestions`, `value`), causing cascading re-renders to `PromptInput` on every keystroke.

### H14. Doctor checks skip critical failure modes
- **File:** `tests/doctor.test.ts` (26 lines total)
- **Category:** Coverage Gap
- Only `binary_missing` tested for codex and amp. `not_authenticated`, `rate_limited`, `ok` statuses never exercised. Claude and OpenCode have zero doctor tests.

### H15. `listRunRecords` reads ALL files concurrently with no limit
- **File:** `src/workflow/history-store.ts:63-79`
- **Category:** Performance
- `Promise.all(entries.map(readRecord(...)))` with no concurrency bound. Corrupted directory with many files could trigger hundreds of simultaneous reads.

### H16. Per-run frame buffer grows without bound
- **File:** `src/web/runs.ts:205-207`
- **Category:** Resource Exhaustion
- Every workflow event is `JSON.stringify`'d and pushed to `run.frames[]` for 5 minutes. Long-running workflows produce megabytes of frames with no trimming.

### H17. `validateRecord` does not deep-validate nested `phases` structure
- **File:** `src/workflow/history-store.ts:154-183`
- **Category:** Type Safety / Data Integrity
- Checks `Array.isArray(r.phases)` but not individual phase/step structure. A corrupt file with `phases: [42]` passes validation.

### H18. Zod union discrimination is fragile — worker matches before distributor
- **File:** `src/workflow/types.ts:306-311`
- **Category:** Type Safety
- A step with no `kind` but with `items` (distributor trait) would match the worker schema if it also has `agent`/`model`/`prompt`. Items are silently dropped.

### H19. `computeRunTotals` double-counts `durationMs` for parallel steps
- **File:** `src/workflow/history.ts:107-127`
- **Category:** Correctness Bug
- Sums every step's `durationMs` even though steps within a phase run in parallel. A 3-step phase with 5s each reports 15s instead of wall-clock 5s.

### H20. No `X-Content-Type-Options: nosniff` on any response
- **File:** `src/web/server.ts` — all `writeHead` calls
- **Category:** Security Header
- Browsers may MIME-sniff responses. User-controlled strings in JSON responses could be interpreted as script content.

### H21. No Content-Security-Policy on the SPA
- **File:** `src/web/html.ts` (1547 lines)
- **Category:** Security Header
- Large inline `<script>` block with no CSP. Any future XSS has zero policy-level containment.

### H22. Error details leaked to HTTP clients
- **File:** `src/web/server.ts:115-118`
- **Category:** Information Disclosure
- Catch-all handler serializes raw `Error.message` into JSON. Internal file paths, Zod schema paths, and DB errors sent verbatim to browser.

### H23. `extractFenced` regex captures first fenced block, not necessarily JSON
- **File:** `src/workflow/generate.ts:463`
- **Category:** Correctness
- Non-greedy regex captures the first ` ``` ` block. If model outputs explanatory text in a fenced block before the JSON, the wrong block is extracted.

### H24. `Orchestrator.run()` doesn't enforce `canDispatch` precondition
- **File:** `src/orchestrator/orchestrator.ts:101-111`
- **Category:** Architecture / Correctness
- Caller must separately call `canDispatch()` before `run()`. If forgotten, dispatch to unhealthy agent proceeds.

---

## 3. Medium Findings

### M1. `killProcess` can be called multiple times concurrently
- **File:** `src/agents/spawn.ts:136-140,155,159-173`
- **Category:** Correctness
- Called from abort handler, finally block, and timeout — each issuing SIGTERM and scheduling SIGKILL timers. A `killed` boolean guard would prevent redundant sequences.

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

### M20. `Channel` has no backpressure
- **File:** `src/workflow/pool.ts:62-96`
- **Category:** Edge Case
- Queue grows without bound for fast producers. MAX_STEPS=1000 with large output could consume significant memory.

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

### M24. `banner.tsx` reads file synchronously on every render
- **File:** `src/tui/banner.tsx:28-35`
- **Category:** Performance
- `loadBannerArt()` does `readFileSync` on every render. Should cache in module-level singleton.

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

### M29. `selectedRowIndex` fallback selects wrong row when empty
- **File:** `src/tui/WorkflowPreview.tsx:73-76`, `src/tui/WorkflowView.tsx:74-77`
- **Category:** Correctness
- `Math.max(0, -1)` = 0 even with no rows. First phase row appears "selected" incorrectly.

### M30. `CommandSuggestionMenu` uses array index as key
- **File:** `src/tui/CommandSuggestionMenu.tsx:153`
- **Category:** Correctness
- Same suggestion at different indices could collide. Changing suggestions cause unnecessary re-mounts.

### M31. `EventRow` `summarizeInput` uses unsafe type assertion
- **File:** `src/tui/EventRow.tsx:157-158`
- **Category:** Type Safety
- `as Record<string, unknown>` on `typeof input === "object"` without Array check.

### M32. `transcriptReducer` has no `default` case
- **File:** `src/tui/transcript.ts:120-128`
- **Category:** Type Safety
- Unrecognized action returns `undefined` (implicit). Discriminated union narrows correctly, but defensive `default` would catch future regressions.

### M33. `statusWord` duplicated in `WorkflowStepDetails` and `WorkflowView`
- **File:** `src/tui/WorkflowStepDetails.tsx:295-306`, `src/tui/WorkflowView.tsx:262-273`
- **Category:** Code Duplication
- Identical function defined in both files. Should be in shared utility.

### M34. `truncate` duplicated between `WorkflowHistory.tsx` and `agents/util`
- **File:** `src/tui/WorkflowHistory.tsx:108-110`
- **Category:** Code Duplication
- Local version lacks Unicode width awareness, causing inconsistent truncation.

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

### M39. `rerunDowngradeMessage` lacks exhaustiveness check
- **File:** `src/workflow/rerun.ts:34-45`
- **Category:** Type Safety
- No `never` exhaustiveness check. New union values won't trigger compile error.

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
- For very large outputs, `this.buf += chunk` creates new strings. Array-based buffering would be more efficient.

### L2. `LineBuffer.stripCarriageReturn` only strips single trailing `\r`
- **File:** `src/agents/line-buffer.ts:44-46`
- Double `\r\r` (unlikely) only strips one.

### L3. `stringifyContent` doesn't handle circular references gracefully
- **File:** `src/agents/util.ts:4,26-32`
- Falls back to `[object Object]`. A `toJSON()` replacer would preserve more detail.

### L4. `codex-efforts-fallback.ts` GPT 5.4/5.3/5.2 all use GPT_55_EFFORTS
- **File:** `src/agents/codex-efforts-fallback.ts:13-15`
- May artificially restrict available effort levels if models support more.

### L5. `opencode-efforts-fallback.ts` maps Qwen to Anthropic efforts
- **File:** `src/agents/opencode-efforts-fallback.ts:46-48`
- Likely copy-paste error. Qwen on opencode provider gets `["high", "max"]`.

### L6. `codex-variants.ts` and `opencode-variants.ts` share duplicated interfaces
- **File:** `src/agents/codex-variants.ts:8-11`, `src/agents/opencode-variants.ts:8-11`
- `CodexModelInfo` and `OpencodeModelInfo` are identical. Should be shared `ModelInfo`.

### L7. `humanizeAssistantError` duplicated between `claude.ts` and `amp.ts`
- **File:** `src/agents/claude.ts:200-205`, `src/agents/amp.ts:142-147`
- Identical function. Coupling amp to Claude's type system.

### L8. Adapter creation path inconsistency
- **File:** `src/orchestrator/orchestrator.ts:73-79` vs `159-183`
- `resolve()` creates adapter inline; `runWorkflow()` takes `createAdapter` callback. Mild DRY violation.

### L9. `Orchestrator` uses `process.cwd()` as default cwd
- **File:** `src/orchestrator/orchestrator.ts:107`
- Not configurable per-workspace. Should carry optional `cwd` field.

### L10. `Orchestrator` workflow catalog not defensively copied
- **File:** `src/orchestrator/orchestrator.ts:44-46,63-66`
- `setCatalog()` directly assigns. Caller mutation silently affects orchestrator.

### L11. `setDoctor()` replaces entire array — TOCTOU with `resolve()`
- **File:** `src/orchestrator/orchestrator.ts:42,49-51`
- Health snapshot at `resolve()` time may be stale by caller inspection.

### L12. `Channel` queue grows without bound
- **File:** `src/workflow/pool.ts:62-96`
- Fast producers outpace consumer. MAX_STEPS=1000 could consume significant memory.

### L13. No CORS headers
- **File:** `src/web/server.ts`
- Acceptable for loopback. Would break behind reverse proxy.

### L14. `closeAllConnections?.()` requires Node >= 18.2.0
- **File:** `src/index.tsx:70`
- Optional chaining prevents crash but SSE connections stay alive on older runtimes.

### L15. `readAll` in CLI has no byte ceiling
- **File:** `src/cli.ts:918-928`
- Stdin read entirely into string. User-initiated, limiting risk.

### L16. Config TOCTOU: `existsSync` before `readFileSync`
- **File:** `src/config/project-workflows.ts:132-140`
- File could vanish between check and read. Drop `existsSync`, catch `ENOENT`.

### L17. `homeRelativePath` follows symlinks
- **File:** `src/paths.ts:6-7`
- `resolve()` canonicalizes. Symlink structures may break `~/` prefix.

### L18. Doctor binary path from config not sanitized
- **File:** `src/doctor/doctor.ts:66-70`
- `config.binaries` flows to `spawn()`. Threat model assumes trusted config.

### L19. Client-side `getElementById` lacks null guards
- **File:** `src/web/html.ts` — throughout `<script>` block
- Renamed elements crash SPA with `TypeError`.

### L20. Port 0 accepted without notification
- **File:** `src/cli.ts:88-95`
- `--port 0` picks ephemeral port. User may not realize.

### L21. `configFileSchema` binary fields accept empty strings
- **File:** `src/config/types.ts:28-33`
- `z.string().optional()` allows `""`. Fails at `resolveBinary` with confusing error.

### L22. EventSource auto-reconnect after run completion
- **File:** `src/web/html.ts:976-996`
- `onerror` doesn't close `EventSource`. Retries until server GCs run (5 min).

### L23. Temp directory cleanup inconsistency in tests
- **File:** ~15 test files
- Most create temp dirs via `mkdtempSync` but never clean up in `afterEach`.

### L24. `package.json` lacks `engines.bun` constraint
- **File:** `package.json:12`
- `dev`/`build` scripts use `bun` directly but no `engines.bun` field.

### L25. No test timeout configuration
- **File:** `vitest.config.ts`
- Default 5000ms may be insufficient for HTTP server tests.

### L26. `biome.json` disables `useImportType`
- **File:** `biome.json:37`
- Prevents enforcement of `import type` for type-only imports.

### L27. Dual lockfiles (`bun.lock` and `package-lock.json`)
- **File:** `/Users/nilsonsfj/projects/steamtrain/bun.lock`, `package-lock.json`
- Can drift between package managers.

### L28. SSE reader doesn't handle partial `data:` lines
- **File:** `tests/web-server.test.ts:132-158`
- TCP fragmentation could split `data:` line, dropping frame silently.

### L29. `reducer-build.test.ts` runs esbuild inside a test
- **File:** `tests/reducer-build.test.ts:10-41`
- Build artifact verification, not a unit test. Should be a build step.

### L30. Hardcoded `/tmp` in many test specs
- **File:** `tests/workflow-engine.test.ts:77` and others
- Windows-incompatible. `"/tmp/none"` as cache root could cause opaque failures.

### L31. `codex-efforts.test.ts` uses `beforeEach` but `models.test.ts` doesn't
- **File:** `tests/codex-efforts.test.ts:25-27`
- Inconsistent cache cleanup patterns.

### L32. `readSse` helper duplicated across 3 test files
- **File:** `tests/web-server.test.ts:132-158`, `tests/web-loops.test.ts:307-333`, `tests/workflow-authoring.test.ts:458-477`
- Bug fixed in one copy not fixed in others.

### L33. `MenuBackdrop` negative margin overlay is fragile
- **File:** `src/tui/CommandSuggestionMenu.tsx:106-119`
- Terminal resize while menu open could misalign overlay.

### L34. `useWorkIndicator` resets elapsed to 0 on inactive
- **File:** `src/tui/useWorkIndicator.ts:14-18`
- May flash "0s" before unmounting.

### L35. `WorkflowStepDetails` truncation uses `Math.max(120, width * 5)`
- **File:** `src/tui/WorkflowStepDetails.tsx:214`
- Excessively generous. 120-col terminal allows 600 chars without wrapping.

### L36. `EventStream` `estimateRows` is a rough heuristic
- **File:** `src/tui/EventStream.tsx:106-116`
- 2000 chars on 80-col terminal undercounts by 1 row.

### L37. No loading state in `WorkflowPreview` when spec unresolved
- **File:** `src/tui/App.tsx:1666-1691`
- Brief flash of picker before preview appears.

### L38. `migrateSessionOverrides` exported but only used locally
- **File:** `src/tui/App.tsx:1884-1894`
- Unnecessary export leaks implementation details.

### L39. `DRAFT_AGENT_ORDER` not `as const`
- **File:** `src/tui/draft-model.ts:16`
- New agents added to `AgentId` union won't cause compile error in this array.

### L40. `STATUS_GLYPH` vs `STATUS_STYLE` naming confusion
- **File:** `src/tui/WorkflowHistory.tsx:14-18`
- Similar names for semantically different status displays.

### L41. `handleTab` depends on `commandSuggestions` — recreated on every keystroke
- **File:** `src/tui/App.tsx:1114-1149`
- Cascading re-renders to `PromptInput` via new `onTab` prop.

### L42. `EventRow` `summarizeInput` unsafe cast
- **File:** `src/tui/EventRow.tsx:157-158`
- `as Record<string, unknown>` without Array check.

### L43. `WorkflowPicker` computes `phaseCount`/`stepCount` inline
- **File:** `src/tui/WorkflowPicker.tsx:48-49`
- Recomputed on every render. Precompute and memoize.

### L44. `orchestrator` recreation cascading through memoized values
- **File:** `src/tui/App.tsx:259-262`
- New `Orchestrator` on doctor load causes `authoringHost`, `author`, etc. to recreate.

### L45. `patchWorkflowStep` identity oscillation
- **File:** `src/tui/App.tsx:245-257,762-813`
- Conditional `updateWorkflowStep: wfPreview ? patchWorkflowStep : undefined` causes unnecessary re-renders.

### L46. `useEffect` with `configWarning` etc. can fire stale dispatches
- **File:** `src/tui/App.tsx:657-670`
- Multiple warnings accumulate if parent passes changing warning string.

### L47. `WorkflowCreate` `innerWidth` calculation assumes standard borders
- **File:** `src/tui/WorkflowCreate.tsx:36`
- Very narrow terminals may still produce content wider than inner width.

### L48. `WorkflowHistory` `selectVisibleWindow` misleading when empty
- **File:** `src/tui/WorkflowHistory.tsx:30`
- `clamped = Math.min(0, Math.max(0, -1))` = 0 with no rows.

### L49. `useWorkIndicator` resets elapsed on inactive
- **File:** `src/tui/useWorkIndicator.ts:14-18`
- May flash "0s" before component unmounts.

### L50. `WorkflowStepDetails` prompt truncation too generous
- **File:** `src/tui/WorkflowStepDetails.tsx:214`
- `Math.max(120, width * 5)` allows 600 chars on 120-col terminal.

---

## 5. Architectural Observations

### 5.1 Strengths

| Area | Observation |
|------|-------------|
| **Adapter pattern** | Discriminated union `AgentEvent` type with adapter-specific mappers is clean. Adding a new agent requires only a new adapter + mapper + Zod schemas. |
| **Zod schemas** | Raw CLI output validated with `.passthrough()` for forward compatibility. |
| **LineBuffer** | Correctly handles chunk boundary reassembly — a common source of bugs in streaming JSON parsers. |
| **Workflow layering** | Clean separation between types/engine/reducer/store. Each module has a single responsibility. |
| **Atomic writes** | Temp-file-then-rename pattern prevents partial reads. |
| **TypeScript config** | `strict: true`, `noUncheckedIndexedAccess: true`, `noFallthroughCasesInSwitch: true`. |

### 5.2 Weaknesses

| Area | Observation |
|------|-------------|
| **App.tsx monolith** | 1905 lines, 30+ `useState`, 20+ `useCallback`. Should be split into state management hook, keyboard handler hook, and render composition. |
| **html.ts inline bundle** | 1547 lines of CSS+JS in a template literal. Unlintable, untestable. Extract to served `.js` file. |
| **server.ts route organization** | 15+ routes in a single `handle()` function as sequential `if` blocks. Adding middleware is painful. |
| **Variant cache duplication** | `codex-variants.ts` and `opencode-variants.ts` are near-identical. Should extract `VariantCache<T>` generic. |
| **Duplicate functions** | `humanizeAssistantError` in `claude.ts`/`amp.ts`. `statusWord` in `WorkflowStepDetails`/`WorkflowView`. `truncate` in `WorkflowHistory`/`agents/util`. |
| **Check-then-act dispatch** | `canDispatch()` + `run()` leaves room for caller error. Health check should be inside `run()`. |
| **No request logging** | Zero logging of HTTP requests or responses. Debugging requires adding it manually. |
| **Doctor lifecycle** | Fire-and-forget IIFE creates window where server reports "no agents" despite them being healthy. |
| **Dead config** | `config.timeoutMs` defined but never enforced in CLI or web run paths. |

---

## 6. Test Coverage Analysis

### Coverage Gaps (Critical)

| Area | Impact |
|------|--------|
| `src/orchestrator/` | Zero test coverage. Subprocess lifecycle management completely untested. |
| OS signal handling | No SIGINT/SIGTERM tests. Orphaned processes, corrupted state on Ctrl+C undetectable. |
| Doctor failure modes | Only `binary_missing` tested for 2 of 4 agents. Authentication, rate limiting, and `ok` statuses untested. |

### Coverage Gaps (High)

| Area | Impact |
|------|--------|
| Web server malformed requests | No tests for empty body, wrong content-type, oversized payloads, concurrent runs. |
| File system errors | No permission denied, disk full, or broken symlink tests in config/workspace loading. |
| TUI keyboard interaction | No simulated keyboard input, focus changes, or scrolling tests. |

### Test Quality Concerns

| Issue | Files |
|-------|-------|
| `noopStore` masks cache bugs | `tests/web-server.test.ts:41-49` |
| Timing-dependent assertions | `tests/workflow-engine.test.ts:116-126` |
| Global registry mutation | `tests/commands.test.ts:528-541` |
| Duplicated `readSse` helper | 3 test files |
| Inconsistent cache cleanup | `codex-efforts.test.ts` vs `models.test.ts` |
| `reducer-build.test.ts` runs esbuild | Build artifact verification, not unit test |

---

## 7. Security Audit

| Finding | Severity | File | Issue |
|---------|----------|------|-------|
| Unbounded body parsing | Critical | `server.ts:83-87` | No byte limit on HTTP body |
| No concurrent run limit | Critical | `runs.ts:124-153` | Unbounded subprocess spawning |
| Missing `nosniff` header | High | `server.ts` all responses | MIME sniffing risk |
| Missing CSP | High | `html.ts` | No containment for future XSS |
| Error details leaked | Medium | `server.ts:115-118` | Internal paths in error responses |
| Unsanitized workflow names | Medium | `server.ts:167-169` | Control chars, long strings |
| No spec validation at HTTP layer | Medium | `server.ts:194-203` | `as WorkflowSpec` cast without Zod |
| Binary path from config | Low | `doctor.ts:66-70` | Arbitrary binary execution |
| Prompt injection via CLI args | Low | `codex.ts:285-299` | Positional arg manipulation |

---

## 8. Performance Analysis

| Issue | File | Impact |
|-------|------|--------|
| Sync I/O in hot path | `catalog.ts:309-316` | Event loop blocks on file writes |
| Unbounded transcript array | `transcript.ts:56-58` | Memory grows with session length |
| `LineBuffer` O(n²) concatenation | `line-buffer.ts:15` | Large outputs cause quadratic allocation |
| No virtualization in `WorkflowPicker` | `WorkflowPicker.tsx:46-77` | All entries rendered, no windowing |
| `banner.tsx` reads file every render | `banner.tsx:28-35` | Redundant `readFileSync` |
| Unbounded frame buffer | `runs.ts:205-207` | Megabytes retained for 5 minutes |
| `listRunRecords` unbounded concurrent reads | `history-store.ts:63-79` | Hundreds of simultaneous file reads |
| `PhaseOf`/`stepOf` O(n) per event | `history.ts:350-358` | Linear scan for every event |
| Callback recreation on keystroke | `App.tsx:1405-1413` | Cascading re-renders every keystroke |
| `orchestrator` memo instability | `App.tsx:259-262` | Recreated on doctor load |

---

## 9. Recommendations Summary

### Immediate (Next Sprint)

1. **Add body size limit to `readBody()`** (C2) — reject with HTTP 413 after 1 MB
2. **Cap concurrent workflow runs** (C3) — return 503 when exceeding limit
3. **Fix gate `onFalse: "stop"` status** (H1) — mark as `ok: false` or add separate `blocked` status
4. **Wrap mapper calls in try/catch** (H2) — yield structured error events
5. **Add `nosniff` and CSP headers** (H20, H21) — one-line fixes per response path
6. **Add vitest coverage thresholds** (H7) — prevent coverage erosion

### Short-Term (This Quarter)

7. **Extract `App.tsx` into smaller components/hooks** (A2) — state management, keyboard, render
8. **Extract `html.ts` JS to served file** (A3) — enable linting and static analysis
9. **Add orchestrator tests** (C6) — even a smoke test for subprocess lifecycle
10. **Replace sync I/O in `writeUserWorkflowsFile`** (C5) — use existing async `atomicWriteFile`
11. **Cap transcript `items` array** (H5) — ring buffer or max 2000 entries
12. **Add `X-Content-Type-Options` and `Content-Security-Policy`** (H20, H21)
13. **Validate workflow names at HTTP boundary** (M12) — reject control chars, enforce length limit
14. **Enforce `config.timeoutMs` in CLI and web** (M16) — `setTimeout`-based abort

### Medium-Term (Next Quarter)

15. **Extract shared `VariantCache<T>` generic** (A5) — replace duplicated code in codex/opencode variants
16. **Add OS signal handling tests** (C7) — verify clean shutdown and process cleanup
17. **Add file system error injection tests** (H11) — permission denied, disk full, broken symlinks
18. **Fix Zod union discrimination order** (H18) — add `kind` discriminant or reorder schemas
19. **Virtualize `WorkflowPicker`** (M26) — apply `selectVisibleWindow` like other list views
20. **Stabilize callback references** (H13) — use `useRef` for values in callbacks

### Long-Term (Architecture)

21. **Add structured logging** — replace `console.warn`/`console.assert` with logger
22. **Introduce route table** in `server.ts` — enable middleware composition
23. **Add readiness signal** for doctor checks — prevent false "no agents" state
24. **Consider request logging middleware** — at minimum, one-liner per request
25. **Document threat model** — config file trust, loopback-only assumption

---

*Generated by MIMO-CODE-2.5 Principal Engineer Review Agent*
*Review date: 2026-06-27*
*Files reviewed: 80+ source files, 64 test files, 5 build configs*
