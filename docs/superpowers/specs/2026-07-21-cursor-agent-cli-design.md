# Cursor Agent CLI adapter — design

**Date:** 2026-07-21  
**Status:** Approved (design)

## Goal

Add first-class steamtrain support for the Cursor Agent CLI (`agent` command) as a new provider `cursor`, at feature parity with existing adapters (especially Claude and Codex): headless streaming, session resume, model catalog (static + live), doctor preflight, interactive takeover resume, and the shared `AgentAdapter` contract.

## Decisions (locked)

| Topic | Choice |
|---|---|
| Provider id | `cursor` |
| Default binary | `agent` |
| Headless permissions | Hardcode `--force` and `--trust` |
| Effort | When `effort` is set, append `[effort=<value>]` to the `--model` argument |
| Model catalog | Static list + live refresh from `agent --list-models` when doctor is ok |
| Interactive takeover | Resume with `agent --resume <sessionId>` when a session id exists |
| Integration style | New first-class adapter (not a Claude fork, not a stub) |

## Non-goals

- Cursor SDK (`@cursor/sdk`) integration - steamtrain talks to agent CLIs only.
- First-class flags for `--mode plan|ask`, `--sandbox`, `--worktree`, `--approve-mcps`, `--auto-review`, `--add-dir`, `--plugin-dir`. These remain available via per-instance / per-step `extraArgs`.
- Changing the shared `AgentAdapter` interface beyond what this provider needs.

## Architecture

Follow the existing per-provider pattern:

```
workflow step agent: "cursor"
  → resolveAgentInstance → createAdapter("cursor", binary)
  → CursorAgentAdapter.run(opts)
  → buildCursorRunArgs + runAgentProcess (NDJSON → mapper → AgentEvent)
```

### Adapter surface

```ts
class CursorAgentAdapter implements AgentAdapter {
  readonly id = "cursor";
  readonly binary; // default "agent"
  readonly defaultModel = "composer-2.5";
  readonly supportsResume = true;
  run(opts): AsyncIterable<AgentEvent>;
}
```

`composer-2.5` is Cursor's current Composer default in `--list-models`; users may select `auto` or any other listed id. The adapter remains the single source of truth for `defaultModel`.

### Headless argv

```
agent \
  --print \
  --output-format stream-json \
  --stream-partial-output \
  --force \
  --trust \
  --model <resolvedModel> \
  [--resume <sessionId>] \
  [...extraArgs] \
  <prompt>
```

- Prompt is a trailing positional argument (Cursor's documented headless form). Do not also pipe stdin.
- `resolvedModel` = `opts.model`, or if `opts.effort` is set: `${opts.model}[effort=${opts.effort}]`.
- If `opts.model` already contains `[...]` brackets and `effort` is also set, still append a second `[effort=…]` suffix only when the model string does **not** already contain `effort=` (avoid double-encoding). Preferred rule: if `opts.model` includes `[` and `effort=`, leave model unchanged and ignore `opts.effort`; otherwise append `[effort=…]` when effort is present.
- `extraArgs` are inserted before the prompt, after the fixed flags (same convention as other adapters).

### Interactive takeover

Extend `INTERACTIVE_RESUME_ARGS` in `src/workflow/takeover.ts`:

```ts
cursor: (sessionId) => ["--resume", sessionId],
```

## Event mapping

Source of truth: Cursor docs for `stream-json` + `--stream-partial-output`.

| Cursor NDJSON | steamtrain `AgentEvent` |
|---|---|
| `system` + `subtype: "init"` | `session_start` with `sessionId`, `model`; `tools` if present |
| `assistant` with `timestamp_ms` present and `model_call_id` absent | `text_delta` — concatenate `message.content[].text` for `type: "text"` |
| Other `assistant` forms | skip (buffered duplicates) |
| `tool_call` + `subtype: "started"` | `tool_use` — `id = call_id`, name/input derived from `readToolCall` / `writeToolCall` / `function` |
| `tool_call` + `subtype: "completed"` | `tool_result` — stringify success/error payload |
| `user` | ignore (echo of our prompt) |
| `result` | `result` — `isError` from `is_error`, `durationMs` from `duration_ms`, text from `result`; attach usage/cost only if present |
| Unrecognized / failed parse | `unknown` passthrough |

Notes:

- Thinking events are suppressed in Cursor print mode; do not expect `thinking` deltas.
- Tool name derivation: `read` / `write` for the typed tool shapes; for `function`, use `function.name` and parse `arguments` when JSON.
- Mapper may be stateful only if needed to correlate start/complete; prefer per-line mapping keyed by `call_id` like other adapters.

## Registration & config

Add `"cursor"` everywhere `AgentProviderId` is enumerated:

- `src/types/events.ts` — `AgentProviderId` union
- `src/agents/config.ts` — `DEFAULT_AGENT_BINARY.cursor = "agent"`
- `src/agents/index.ts` — `createAdapter` case
- `src/agents/models.ts` — `AGENT_IDS`, `modelsForProvider`, `PROVIDER_ADAPTERS`, `refreshAgentCatalogCaches`
- Config zod enums for `provider` and `binaries` keys
- Doctor `installHint` / `authHint`
- Docs: README, `docs/agent-configuration.md`, `docs/workflow-spec.md` (resume table)

### Doctor hints

- Install: `curl https://cursor.com/install -fsS | bash` (ensure `agent` on PATH)
- Auth: `agent login`, or set `CURSOR_API_KEY`

Doctor continues to use `<binary> --version` like other providers.

## Model catalog

### Static fallback

Ship a curated static list covering common ids from `agent --list-models`, including at least:

- `auto`
- `composer-2.5`, `composer-2.5-fast`
- A small set of Claude / GPT / Grok Cursor slugs (not the entire live list)

Exact entries can track a snapshot of `--list-models` at implementation time; live refresh is the authority when available.

### Live refresh

Mirror Codex/OpenCode variant cache pattern in `src/agents/cursor-variants.ts` (or equivalent):

1. When doctor reports `provider === "cursor"` and `status === "ok"`, run `agent --list-models` (or `agent models` if that proves more stable) with a timeout.
2. Parse lines of the form `id - Display Name` after the header.
3. Cache with TTL (~1h); expose `listCursorCachedAgentModels()` / `refreshCursorVariantCache(binary)`.
4. Hook into `refreshAgentCatalogCaches`.

Effort catalog: Cursor often bakes effort into the model slug (`…-high`, `…-thinking-xhigh`). Steamtrain's separate `effort` field still works via the `[effort=…]` model suffix for parameterized models. Do not invent a separate Cursor efforts CLI probe unless `--list-models` exposes structured effort metadata (it currently does not).

## Files to add

| Path | Role |
|---|---|
| `src/agents/cursor.ts` | Adapter, `buildCursorRunArgs`, mapper, static `CURSOR_MODELS` |
| `src/agents/cursor-variants.ts` | Live `--list-models` parse + cache |
| `src/types/raw-cursor.ts` | Zod schemas for Cursor NDJSON envelopes |
| `tests/cursor-adapter.test.ts` | Mapper + argv builders (force/trust/resume/effort/model/prompt) |
| `tests/cursor-variants.test.ts` | Parser + cache behavior |

## Files to update (representative)

- `src/types/events.ts`, `src/agents/{index,config,models,agent-meta}.ts`
- `src/config/types.ts` (and any zod schemas for provider/binaries)
- `src/doctor/doctor.ts`
- `src/workflow/takeover.ts`
- Docs listed above
- Any exhaustive `switch` / `Record<AgentProviderId, …>` that TypeScript will flag

## Testing strategy

- Unit tests only; no live Cursor API calls in CI.
- Fixture NDJSON lines covering: init, streaming assistant delta, duplicate assistant flushes, read/write tool start+complete, function tool, success result, error result, unknown.
- Argv tests: base flags, resume, effort append, effort skipped when model already has `effort=`, extraArgs placement, prompt as final arg.
- Existing doctor/models tests updated for the new provider enum where they assert full lists.

## Error handling

- Spawn / non-zero exit / empty stream: handled by shared `runAgentProcess` → `error` events (unchanged).
- Auth failures that still produce NDJSON `result` with `is_error: true`: map to `result` with `isError: true`.
- Auth failures that only print to stderr and exit non-zero: shared process error path.

## Success criteria

1. A workflow step with `"agent": "cursor"` resolves, passes doctor when `agent` is installed/authenticated, and streams normalized events.
2. `session: continue:<stepId>` resumes via `--resume` when a prior `session_start.sessionId` exists.
3. Interactive takeover resumes the same chat when a session id is available.
4. `/model` (and web/TUI pickers) show Cursor models from static list, upgrading to live list after successful doctor.
5. Lint, typecheck, and unit tests pass.
`}