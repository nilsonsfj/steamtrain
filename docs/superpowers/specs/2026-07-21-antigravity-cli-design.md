# Antigravity CLI (`agy`) adapter — design

**Date:** 2026-07-21  
**Status:** Approved (design; decisions locked by request for completeness)

## Goal

Add first-class steamtrain support for Google's Antigravity CLI (`agy`) as provider `antigravity`, at the fullest parity the CLI currently allows: headless print runs, session resume, model catalog (static + live), doctor preflight, interactive takeover resume, and the shared `AgentAdapter` contract.

## Decisions (locked)

| Topic | Choice |
|---|---|
| Provider id | `antigravity` |
| Default binary | `agy` |
| Default model | `Gemini 3.1 Pro (High)` |
| Headless permissions | Hardcode `--dangerously-skip-permissions` and `--mode accept-edits` |
| Output contract | Plain-text `--print` (no `stream-json` yet on agy 1.1.x) |
| Prompt delivery | `--print <prompt>` as the **last** two argv tokens (agy treats `--print` as a value flag) |
| Stdin | Closed / ignored (open inherited stdin can hang print mode) |
| Resume | `--conversation <id>`; `supportsResume = true` |
| Session id source | Parse stderr (`Created conversation …`, `conversation=…`, `Stream completed for …`); fallback `cache/last_conversations.json` keyed by cwd |
| Empty stdout recovery | Read `brain/<id>/.system_generated/logs/transcript.jsonl` last `PLANNER_RESPONSE` when stdout is empty but a conversation id is known |
| Effort | When set and model has no `(Low\|Medium\|High\|Thinking)` suffix, append ` (<Label>)` |
| Model catalog | Static list + live refresh from `agy models` |
| Interactive takeover | `agy --conversation <sessionId>` |
| Auth hints | Interactive Google sign-in via `agy`, or `GEMINI_API_KEY` / `ANTIGRAVITY_API_KEY` |
| Install hint | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` |

## Non-goals

- Waiting on upstream `--output-format stream-json` (open feature request).
- First-class flags for `--sandbox`, `--add-dir`, `--project`, `--agent` (custom agents) — available via `extraArgs`.
- PTY wrapping via `node-pty` (prefer pipe + transcript fallback; agy 1.1.4 emits stdout on macOS when stdin is closed).

## Architecture

```
workflow step agent: "antigravity"
  → resolveAgentInstance → createAdapter("antigravity", binary)
  → AntigravityAdapter.run(opts)
  → buildAntigravityRunArgs + runAntigravityProcess (plain text + stderr session parse → AgentEvent)
```

Unlike Claude/Cursor, Antigravity does **not** use `runAgentProcess` (NDJSON). It uses a dedicated plain-text runner built on `runProcessLines`.

### Headless argv

```
agy \
  --model <resolvedModel> \
  --dangerously-skip-permissions \
  --mode accept-edits \
  [--conversation <sessionId>] \
  [--print-timeout <Ns>] \
  [...extraArgs] \
  --print \
  <prompt>
```

### Event mapping (synthetic)

| Source | steamtrain `AgentEvent` |
|---|---|
| First discovered conversation id | `session_start` |
| Each non-empty stdout line | `text_delta` |
| Successful exit with text (stdout or transcript) | `result` with `text`, `durationMs` |
| Non-zero exit / spawn failure / timeout / empty after fallback | `error` (+ `result` with `isError` when we have partial text) |

Tool call streaming is not available without structured output; do not invent fake tool events.

## Success criteria

1. `"agent": "antigravity"` resolves, passes doctor when `agy` is installed, and streams normalized text events.
2. `session: continue:<stepId>` resumes via `--conversation` when a prior `session_start.sessionId` exists.
3. Interactive takeover resumes with `--conversation`.
4. Model pickers show static Antigravity models, upgrading to live `agy models` after successful doctor.
5. Lint, typecheck, and unit tests pass.
