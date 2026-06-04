# steamtrain 🚂

A terminal orchestrator that runs coding agents — **Claude Code** and **OpenCode** —
as managed subprocesses and renders their activity live in a rich [Ink](https://github.com/vadimdemedes/ink) TUI.

steamtrain spawns the real `claude` and `opencode` CLIs (no stubs), parses their
streaming JSON through a shared normalization layer, and shows a unified,
color-coded event stream regardless of which agent produced it.

---

## Quick start

```bash
# 1. install deps (bun is the dev toolchain; npm also works)
bun install

# 2. run the TUI straight from source (no build step)
bun src/index.tsx
```

You'll see a steam-train banner, then a preflight **doctor** panel checking that
`claude` and `opencode` are installed and runnable, then the live UI:

```
┌ steamtrain  ● claude ready   ● opencode ready ───────── idle  cfg: steamtrain.json ┐
┌ event stream ─────────────────────────────── plan · claude/claude-sonnet-4-6 ─────┐
│  ▸ session 4a6e… · claude-haiku-4-5 · 30 tools                                     │
│  hi                                                                                │
│  ■ result  1.5s  · $0.0247                                                         │
└────────────────────────────────────────────────────────────────────────────────────┘
 task  plan  implement  review  (Tab to switch)        → claude · claude-sonnet-4-6
┌ ❯ describe the task, then Enter to dispatch ─────────────────────────────────────┐
└──────────────────────────────────────────────────────────────────────────────────┘
 Enter dispatch · Tab switch task · Esc cancel · Ctrl+C quit
```

**Keys:** `Enter` dispatch · `Tab` cycle task type · `Esc` cancel a running task · `Ctrl+C` quit.

### Build a standalone binary

```bash
bun install
npm run build          # tsup → dist/index.js (with shebang)
node dist/index.js     # or: npm link && steamtrain
```

---

## Architecture

```
src/
├─ types/         Normalized event model + zod schemas for each CLI's raw output
│  ├─ events.ts        AgentEvent discriminated union (the only shape the UI knows)
│  ├─ raw-claude.ts    zod schemas for claude stream-json lines
│  └─ raw-opencode.ts  zod schemas for opencode run --format json events
├─ agents/        Spawning + raw→normalized mapping
│  ├─ line-buffer.ts   NDJSON reassembly across chunk boundaries
│  ├─ spawn.ts         child process → lines + stderr + exit (timeout/abort/kill)
│  ├─ adapter.ts       AgentAdapter interface + shared process→events driver
│  ├─ claude.ts        ClaudeCodeAdapter + createClaudeMapper
│  └─ opencode.ts      OpenCodeAdapter + createOpenCodeMapper
├─ config/        Task-type → { agent, model } map (+ steamtrain.json overrides)
├─ doctor/        Preflight: resolve binary, run --version, classify readiness
├─ orchestrator/  Routes a task type to the right adapter+model; gates on health
└─ tui/           Ink components (banner, status bar, event stream, selector, input)
```

### The normalization layer

Every agent's raw streaming output is mapped onto one discriminated union
(`src/types/events.ts`), discriminated by `kind`:

| kind            | meaning                                              |
| --------------- | ---------------------------------------------------- |
| `session_start` | a turn began (session id, model, tool list)          |
| `text_delta`    | a chunk of assistant text (`thinking: true` for reasoning) |
| `tool_use`      | the agent invoked a tool                             |
| `tool_result`   | a tool returned (or failed)                          |
| `result`        | the turn finished (text, duration, cost, error flag) |
| `error`         | a process/protocol failure (exit≠0, timeout, auth)   |
| `unknown`       | a valid-JSON line whose `type` we don't model — **passed through, never crashes** |

Each adapter parses raw lines with zod schemas at the boundary and tolerates
unrecognized event types by emitting `unknown` instead of throwing — so a CLI
adding new event types degrades gracefully.

**Claude Code** (`claude --print --output-format stream-json --verbose --include-partial-messages --model <model> <prompt>`)
streams text/thinking via `stream_event` deltas; full `assistant` messages are
used only for tool calls (their text would duplicate the streamed deltas).
`result` carries `is_error`, `duration_ms` and `total_cost_usd`. An
`authentication_failed` assistant error (e.g. "Not logged in") surfaces as an
`error` event.

> Note: the spec mentioned a `--bare` flag, but `--bare` bypasses the
> subscription/OAuth credential path and reports "Not logged in". steamtrain
> therefore does **not** pass `--bare`.

**OpenCode** (`opencode run --format json --model <provider/model> <prompt>`)
emits flat JSONL events. Its mapper is **stateful** per run: text/reasoning
parts arrive as cumulative snapshots, so it diffs against the previous value to
emit true deltas; tool parts stream status transitions, so it emits `tool_use`
once on start and `tool_result` once on completion (deduped by call id).

---

## Configuration: task type → model

steamtrain routes three task types — `plan`, `implement`, `review` — to a
specific agent + model. Defaults live in `src/config/defaults.ts`; override any
subset with a `steamtrain.json` in the working directory:

```jsonc
{
  "tasks": {
    "plan":      { "agent": "claude",   "model": "claude-sonnet-4-6" },
    "implement": { "agent": "opencode", "model": "openai/gpt-5.4-mini" },
    "review":    { "agent": "claude",   "model": "claude-opus-4-8" }
  },
  "binaries": { "opencode": "/opt/homebrew/bin/opencode" }, // optional path overrides
  "timeoutMs": 300000                                       // per-task kill timeout
}
```

- **claude** models are aliases/ids like `claude-sonnet-4-6`, `haiku`, `claude-opus-4-8`.
- **opencode** models are `provider/model` and must be a provider you've
  authenticated (`opencode auth login`). The shipped config uses
  `openai/gpt-5.4-mini`; switch to `anthropic/claude-sonnet-4-6` if you add
  Anthropic credentials to OpenCode.

A missing/invalid `steamtrain.json` falls back to built-in defaults (with a
warning in the stream); only the keys you specify are overridden.

---

## Doctor (preflight)

At startup, before any dispatch, steamtrain checks each agent:

1. resolve the absolute binary on `PATH` (→ `binary_missing` with an install hint if absent),
2. run `<binary> --version` to confirm it executes,
3. classify readiness as `ok | binary_missing | not_authenticated | unknown_error`
   from exit code + stderr.

The status bar shows a green/amber/red dot per agent, and **dispatch is blocked**
for any task whose agent isn't `ok`, with a fix-it message.

> `claude --version` returns success even when logged out, so the doctor can show
> claude as `ready` while a dispatch later surfaces "Not logged in" as an `error`
> event. Run `claude` → `/login` to authenticate.

---

## Development

```bash
bun install
bun src/index.tsx     # run the TUI from source
npm run dev           # same, via tsx (if you prefer not to use bun)
npm run test          # vitest: line-buffer + both adapter mappers + a TUI smoke test
npm run typecheck     # tsc --noEmit (strict, noUncheckedIndexedAccess)
npm run lint          # biome
npm run build         # tsup → dist/
```

### Tests

The two highest-risk areas are covered first:

- **`tests/line-buffer.test.ts`** — NDJSON reassembly with events split across
  arbitrary chunk boundaries, CRLF, blank lines, and trailing partials.
- **`tests/claude-adapter.test.ts`** / **`tests/opencode-adapter.test.ts`** —
  the raw→normalized mapping for each CLI, using real sample event lines
  (including the actual `claude` stream-json and the actual `opencode` error event).

---

## License

MIT
