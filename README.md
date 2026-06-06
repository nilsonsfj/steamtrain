# steamtrain 🚂

A workflow-first terminal orchestrator that runs coding agents — **Claude Code**
and **OpenCode** — as managed subprocesses and renders their activity live in a
rich [Ink](https://github.com/vadimdemedes/ink) TUI.

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
`claude` and `opencode` are installed and runnable, then the workflow picker:

```
┌ steamtrain  ● claude ready   ● opencode ready ───────── idle  cfg: steamtrain.json ┐
┌ workflows ───────────────────────────────────────── ↑/↓ select · Enter run ───────┐
│▶ multi-plan  4 phases · 5 steps                                                    │
│  distributor:1 · worker:2 · consolidator:2                                         │
│  Draft a plan from independent angles, stress-test it, then synthesize...          │
└────────────────────────────────────────────────────────────────────────────────────┘
 mode  workflow  plan  implement  review  (Tab to switch)        → workflow: multi-plan
┌ ❯ describe the task, then Enter to dispatch ─────────────────────────────────────┐
└──────────────────────────────────────────────────────────────────────────────────┘
 ↑/↓ pick · Enter run · Tab switch mode · Ctrl+C quit
```

**Keys:** `Enter` run · `↑/↓` pick workflow or inspect steps · `Tab` cycle mode ·
`Esc` cancel/back · `Ctrl+C` quit.

`steamtrain` opens on **workflow** mode. `Tab` cycles to one-shot `plan`,
`implement`, and `review` task modes.

### Workflow CLI

```bash
steamtrain workflow list
steamtrain workflow validate [name]
steamtrain workflow run multi-plan --input "design the cache migration"
steamtrain workflow run bug-hunt --stdin --json
steamtrain workflow run multi-plan --input "design the cache migration" --fresh
steamtrain workflow cache clear
```

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
├─ workflow/      Declarative multi-agent workflows: spec + zod schema, a bounded-
│                 parallel engine, on-disk step cache (`.steamtrain/cache/`), and
│                 bundled specs (the layer above orchestrator)
├─ docs/          Workflow guides: overview, examples, language spec
└─ tui/           Ink components (banner, status bar, streams, workflow view, input)
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

## Configuration: workflows and task defaults

steamtrain is centered on workflows, but still ships one-shot task defaults for
`plan`, `implement`, and `review`. Defaults live in `src/config/defaults.ts`;
override any subset with a `steamtrain.json` in the working directory:

```jsonc
{
  "tasks": {
    "plan":      { "agent": "claude",   "model": "claude-sonnet-4-6" },
    "implement": { "agent": "opencode", "model": "openai/gpt-5.4-mini" },
    "review":    { "agent": "claude",   "model": "claude-opus-4-8" }
  },
  "binaries": { "opencode": "/opt/homebrew/bin/opencode" }, // optional path overrides
  "timeoutMs": 300000,                                      // per-task (and per-step) kill timeout
  "maxConcurrency": 3                                       // parallel steps per workflow phase (≤ 16)
  // "workflows": { … }                                     // see “Workflows” below
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

## Workflows

A **workflow** is steamtrain's central unit: a declarative sequence of **phases**
made from standard building blocks. Phases run in order; the **steps** inside a
phase run in **parallel**. Distributors can produce many work items, processors
can dynamically fan out to one generated agent run per item, and later steps can
gate or consolidate the aggregate output.

The TUI starts in workflow mode. Pick one with `↑/↓`, type the input, and
**Enter** to launch. The phase -> step tree streams live; `↑/↓` drills into a
step's output. `Esc` cancels a run (and, once stopped, backs out to the picker).
Re-running **resumes**: completed steps replay from `.steamtrain/cache/` (and an
in-session cache) instead of running again. Use `steamtrain workflow run … --fresh`
to ignore the on-disk cache, or `steamtrain workflow cache clear` to delete it.

Workflow documentation:

- [`docs/workflow-overview.md`](docs/workflow-overview.md) — mental model, diagrams, execution behavior
- [`docs/workflow-examples.md`](docs/workflow-examples.md) — patterns and bundled workflow walkthroughs
- [`docs/workflow-spec.md`](docs/workflow-spec.md) — language reference

### Bundled workflows

| name         | what it does                                                                                                                         |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `multi-plan` | Distributes planning lenses, drafts from two independent angles (claude + opencode), critiques both, then synthesizes the strongest merged plan. |
| `bug-hunt`   | Sweeps a scope for logic / error-handling / security bugs in parallel across three models, cross-checks to drop false positives, gates verified findings, then reports them. |
| `target-sweep` | Distributes a request into target areas, dynamically creates one processor run per item, then consolidates the generated outputs. |

### Defining your own

Add a `workflows` map (keyed by launch name) to `steamtrain.json`. Your workflows
merge over the bundled ones; a same-named entry overrides a bundled one.

```jsonc
{
  "maxConcurrency": 3,                 // parallel steps per phase (≤ 16, default 3)
  "workflows": {
    "audit": {
      "description": "Audit each service for missing auth checks.",
      "phases": [
        {
          "id": "split",
          "title": "Split audit targets",
          "steps": [
            { "id": "targets", "kind": "distributor",
              "items": ["api: {{input}}", "web: {{input}}"] }
          ]
        },
        {
          "id": "scan",
          "title": "Scan each target",
          "steps": [
            { "id": "audit-each", "kind": "processor", "agent": "claude", "model": "claude-sonnet-4-6",
              "dependsOn": ["targets"], "forEach": "steps.targets.items",
              "prompt": "Audit target {{item.index}}:\n{{item}}" }
          ]
        },
        {
          "id": "gate",
          "title": "Only report successful scans",
          "steps": [
            { "id": "scans-ready", "kind": "gate", "dependsOn": ["audit-each"],
              "condition": { "step": "audit-each", "ok": true }, "target": "ready", "onFalse": "fail" }
          ]
        },
        {
          "id": "report",
          "title": "Combine findings",
          "steps": [
            { "id": "report", "kind": "consolidator", "agent": "claude", "model": "claude-opus-4-8",
              "dependsOn": ["audit-each", "scans-ready"],
              "prompt": "Merge these findings:\n{{steps.audit-each.output}}" }
          ]
        }
      ]
    }
  }
}
```

- **Step kinds:** `worker` / `processor`, `distributor`, `consolidator`, and
  `gate`. Existing steps without `kind` are workers.
- **Agent-backed fields:** `agent` (`claude` | `opencode`), `model`, `prompt`,
  plus optional `cwd` (the **target** dir; relative paths resolve against the
  launch cwd), `env` (extra vars), and `extraArgs` (extra CLI flags).
- **Dynamic fan-out:** add `forEach: "steps.<id>.items"` to a worker/processor
  to create one generated child agent run per distributor item. Use `{{item}}`,
  `{{item.index}}`, and `{{item.sourceStepId}}` in that prompt.
- **Dependencies:** `dependsOn` may reference only steps in *earlier* phases.
- **Prompt templates:** `{{input}}` / `{{args}}` expand to what you typed;
  `{{steps.<id>.output}}`, `{{steps.<id>.items}}`, `{{steps.<id>.ok}}`,
  `{{steps.<id>.error}}`, and `{{steps.<id>.target}}` expose earlier results.
- **Limits:** ≤ 16 parallel steps per phase and 1000 steps per run. Every step is a
  full agent run only when it is agent-backed, so costs add up for worker and
  agent-backed distributor/consolidator blocks.

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
- **`tests/workflow-*.test.ts`** — the workflow layer: the bounded-concurrency
  pool + channel, prompt templating, spec/dependency validation, the reducer that
  builds the live tree, and the engine end-to-end (phase ordering, parallel
  fan-out, cross-phase templating, failures, abort, and in-session resume — all
  against an injected fake adapter, no real CLIs).

---

## License

MIT
