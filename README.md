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

`steamtrain` opens on **workflow** mode. `Tab` cycles through your configured
workspace presets (defaults: `plan`, `implement`, `review`).

### Web UI

Prefer a browser? Launch the same workflow engine behind a local web UI:

```bash
steamtrain --web-ui                 # serves http://127.0.0.1:4317
steamtrain --web-ui --port 8080     # custom port
steamtrain --web-ui --host 0.0.0.0  # listen on all interfaces
```

It pairs the workflow picker with a **vertical pipeline visualization**: phases
stack top-to-bottom, parallel steps render as live cards (colored by block kind),
each showing status, agent/model, data-flow inputs, a streamed output tail, and
per-step duration/cost — backed by the same runner, on-disk cache, and doctor
gating as the TUI and CLI. Runs stream over SSE; cancel a run from the browser.
See [`docs/web-ui.md`](docs/web-ui.md).

### Workflow CLI

```bash
steamtrain workflow list
steamtrain workflow validate [name]
steamtrain workflow run multi-plan --input "design the cache migration"
steamtrain workflow run bug-hunt --stdin --json
steamtrain workflow run multi-plan --input "design the cache migration" --fresh
steamtrain workflow cache clear

# Inspect past runs (recorded automatically to .steamtrain/history/)
steamtrain workflow history              # list recent runs (newest first)
steamtrain workflow history show <id>    # full phase → step breakdown of one run
steamtrain workflow history clear [<id>] # delete one run, or all of them

# Act on a past run (workflow + input come from the record)
steamtrain workflow run --from <runId>                 # re-run it fresh
steamtrain workflow run --from <runId> --retry-failed  # re-run only failed/not-run steps

# Draft a brand-new workflow from a description (LLM delegation), then save it.
steamtrain workflow create --input "review a PR from three angles then merge findings"
steamtrain workflow create --input "audit the auth module" --agent claude --model claude-sonnet-4-6 --save
# Save into the project's ./steamtrain.json so it can be committed and shared.
steamtrain workflow create --input "team release checklist" --name release-check --save --scope project
```

Every headless run ends with a **status summary** — one line per step (status,
duration, gate result, cost) plus run totals — so a CI log shows exactly what
happened. Agentless workflows (only distributors / consolidators / gates) run
without any agent installed, which makes them ideal smoke tests.

### Run history

Every workflow run (TUI, web UI, or CLI) is recorded to `.steamtrain/history/`
as one JSON record — the full phase → step tree with each step's status, output,
duration, cost, gate result, and any error. The newest 100 runs are kept; older
records are pruned automatically.

- **TUI:** type `/history` to open the run browser. `↑/↓` pick a run, `Enter`
  inspect it (the same phase → step view a live run uses), `→` drills into a
  step's output, `Esc` backs out.
- **Web UI:** click **⏱ History** in the header to list past runs; click one to
  see its pipeline, per-step output, and run summary.
- **CLI:** `steamtrain workflow history` (see above).

See [`docs/workflow-creation.md`](docs/workflow-creation.md) for the creation flow
(CLI `workflow create` and the TUI `/create-workflow` command).

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
├─ config/        Project config: workflows, binaries, timeouts (steamtrain.json)
├─ workspace/     User workspace presets: { id, agent, model } (~/.steamtrain/workspace.json)
├─ doctor/        Preflight: resolve binary, run --version, classify readiness
├─ orchestrator/  Routes workspace ids and workflows to adapters; gates on health
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

## Configuration

steamtrain splits configuration across two files:

| File | Scope | Contents |
| ---- | ----- | -------- |
| `~/.steamtrain/workspace.json` | user (global) | One-shot **workspace presets** — Tab modes like `plan`, `implement`, `review` |
| `./steamtrain.json` | project (cwd) | Workflows, binary paths, timeouts, concurrency |

### Workspace presets (`~/.steamtrain/workspace.json`)

Built-in defaults live in `src/workspace/defaults.ts` (`plan`, `implement`,
`review`). Override or extend them in your home directory:

```jsonc
{
  "workspaces": [
    { "id": "plan",      "agent": "claude",   "model": "claude-sonnet-4-6" },
    { "id": "implement", "agent": "opencode", "model": "openai/gpt-5.4-mini" },
    { "id": "review",    "agent": "claude",   "model": "claude-opus-4-8" },
    { "id": "debug",     "label": "Debug", "agent": "opencode", "model": "openai/gpt-5.4-mini" }
  ]
}
```

- **`id`** — stable key used for dispatch; shown in the mode bar unless `label` is set.
- **`label`** — optional display name in the mode bar.
- **`agent`** / **`model`** — same formats as workflow steps (see below).
- The id `workflow` is reserved for the built-in workflow mode.

Entries merge by `id` onto the built-in defaults (override in place, append new
ids). A missing or invalid file falls back to built-in workspace defaults with a
warning in the stream.

> **Migration:** older `steamtrain.json` files used a `"tasks"` key for these
> presets. That key is no longer supported — move them to
> `~/.steamtrain/workspace.json`. steamtrain warns if `"tasks"` is still present.

### Project config (`steamtrain.json`)

Override any subset in the working directory:

```jsonc
{
  "binaries": { "opencode": "/opt/homebrew/bin/opencode" }, // optional path overrides
  "stepTimeoutSec": 900,                                    // per-agent subprocess limit in seconds (default 15m = 900)
  "workflowTimeoutSec": 1800,                               // optional whole-run cap in seconds; omit = (loop-aware) steps × stepTimeoutSec
  "maxConcurrency": 5                                       // parallel steps per run (≤ 16, default 5)
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
made from standard building blocks. Steps are **dependency-scheduled**: each
step starts as soon as the steps it references have finished, in parallel with
anything unrelated. A step without `dependsOn` waits for all earlier phases, so
phases still act as barriers for it. Distributors can produce many work items,
processors can dynamically fan out to one generated agent run per item, and
later steps can gate or consolidate the aggregate output.

The TUI starts in workflow mode. Pick one with `↑/↓`, type the input, and
**Enter** to launch. The phase -> step tree streams live; `↑/↓` drills into a
step's output. `Esc` cancels a run (and, once stopped, backs out to the picker).
Re-running **resumes**: completed steps replay from `.steamtrain/cache/` (and an
in-session cache) instead of running again. The cache is keyed by workflow spec,
input, and cwd — editing a workflow invalidates stale entries automatically.
Use `steamtrain workflow run … --fresh` to ignore the on-disk cache, or
`steamtrain workflow cache clear` to delete it.

Agent steps **auto-retry transient failures** (a crash or transport/spawn error
before the agent completed a turn) with exponential backoff — on by default,
configurable via a workflow-level or per-step `retry` policy. A step that ran to
completion and reported an error is never auto-retried (it may have made changes).
See [docs/workflow-spec.md](docs/workflow-spec.md#auto-retry-on-transient-failures).

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
| `review-loop` | Implements, then reviews and fixes in a bounded loop-back gate until the review reports "DONE" (or the iteration cap is hit). |

### Defining your own

Add a `workflows` map (keyed by launch name) to `steamtrain.json`. Your workflows
merge over the bundled ones; a same-named entry overrides a bundled one.

```jsonc
{
  "maxConcurrency": 5,                 // parallel steps per run (≤ 16, default 5)
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
- **Agent-backed fields:** `agent` (`claude` | `opencode` | `codex` | `amp`), `model`, `prompt`,
  plus optional `cwd` (the **target** dir; relative paths resolve against the
  launch cwd), `env` (extra vars), and `extraArgs` (extra CLI flags).
- **Dynamic fan-out:** add `forEach: "steps.<id>.items"` to a worker/processor
  to create one generated child agent run per distributor item. Use `{{item}}`,
  `{{item.index}}`, and `{{item.sourceStepId}}` in that prompt.
- **Dependencies:** `dependsOn` may reference only steps in *earlier* phases.
  Steps are scheduled by these dependencies; a step without `dependsOn` waits
  for every step in all earlier phases.
- **Conditions:** any step may set `when` (gate-condition schema) to run only
  when it matches — otherwise the step is *skipped* (not failed), skips cascade
  to dependents, and consolidators treat skipped inputs as absent. See
  [docs/workflow-spec.md](docs/workflow-spec.md#per-step-conditions-when).
- **Prompt templates:** `{{input}}` / `{{args}}` expand to what you typed;
  `{{steps.<id>.output}}`, `{{steps.<id>.items}}`, `{{steps.<id>.ok}}`,
  `{{steps.<id>.error}}`, and `{{steps.<id>.target}}` expose earlier results.
- **Limits:** ≤ 16 parallel steps per run and 1000 steps per run. Every step is a
  full agent run only when it is agent-backed, so costs add up for worker and
  agent-backed distributor/consolidator blocks.
- **Loops:** a gate can set `loopTo` to jump back to an earlier phase (with an
  optional `maxIterations`) for bounded "review until clean" cycles — see the
  bundled `review-loop` workflow and
  [docs/workflow-creation.md#loops](docs/workflow-creation.md#loops).

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
