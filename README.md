# steamtrain 🚂

**Orchestrate your coding agents like a build pipeline — not a chat window.**

steamtrain runs **Claude Code, OpenCode, Codex, Cursor, and Amp** as managed
subprocesses and drives them through declarative, parallel **workflows**: fan a
task out across models, cross-check the results, gate on what passed, and merge
the verified changes back into your checkout — all streamed live in a terminal
UI (or a local web UI), with real dollar and token costs on every step.

One task, many agents, in parallel, with a receipt. No copy-pasting between
terminals.

---

## Get started

**Prerequisites:** [Bun 1+](https://bun.sh) for the development/build toolchain and Node.js 20+ to run the bundled CLI.

```bash
git clone https://github.com/nilsonsfj/steamtrain.git
cd steamtrain
npm run install:local        # builds, then links `steamtrain` onto your PATH
steamtrain --version
```

`install:local` installs dependencies with Bun, builds `dist/index.js`, and
symlinks a `steamtrain` command into `~/.local/bin` — **no sudo**. It prints how
to add that dir to your PATH if needed. (Details and custom install locations
are [below the fold](#install-as-a-system-binary).)

**Now take a lap — no agent, no API key, no credit required.** Launch the
web UI (`steamtrain --web-ui`) and take the free tour from the Station, or run
the bundled agentless `tour` from the CLI: a distributor fans out, command
cars run in parallel, a `when` condition skips a step, a gate loops the train
three times around the track, and a consolidator prints the arrival report.

```bash
steamtrain --web-ui                                 # Station → tour in the browser
steamtrain workflow run tour --input "all aboard"   # $0, ~0.1s from the CLI
```

**Wire it to your repo.** `init` checks which agents are ready (with copy-paste
fixes), detects this repo's real test/lint commands, and writes starter
workflows built around them to `./steamtrain.json`:

```bash
steamtrain init
```

**Then launch the workflow-first TUI:**

```bash
steamtrain            # the terminal UI
steamtrain --web-ui   # …or the same engine behind http://127.0.0.1:4317
```

Prefer not to install anything on your PATH yet? You can run straight from
source with `bun src/index.tsx` (see [Development](#development)).

---

## Why steamtrain

A tour of what it does and why it's useful — not an exhaustive spec (that's
[below the fold](#below-the-fold-technical-reference)).

### Run every major coding agent through one interface

steamtrain spawns the real `claude`, `opencode`, `codex`, `agent` (Cursor), `agy`
(Antigravity), `kimi` (Kimi Code), and `amp` CLIs (no stubs) and maps each one's streaming output onto a single
normalized event model. Whichever agent produced a line — assistant text, a
tool call, a result, an error — it renders in the same unified, color-coded
stream. Mix agents freely in one workflow; steamtrain speaks all of them.

### Compose work as declarative, parallel workflows

A **workflow** is a sequence of **phases** built from a few standard blocks:
`distributor` (fan a task into work items), `worker`/`processor` (run an agent,
optionally once per item), `consolidator` (merge results), and `gate` (branch,
loop, or stop on a condition). Steps are **dependency-scheduled** — each starts
the moment its inputs are ready, in parallel with everything unrelated — so
"draft from three angles, critique each, synthesize the best" is a few lines of
JSON, not a morning of babysitting terminals. Bundled examples:

| workflow | what it does |
| --- | --- |
| `tour` | The $0 agentless demo above — the whole engine, zero credentials. |
| `multi-plan` | Drafts a plan from two independent angles (claude + opencode), critiques both, synthesizes the strongest merge. |
| `bug-hunt` | Sweeps a scope for logic / error-handling / security bugs across three models in parallel, cross-checks to drop false positives, gates verified findings, reports. |
| `review-loop` | Implements, then reviews-and-fixes in a bounded loop until the review says "DONE". |
| `quick-triage` | Splits a request into concerns and gates on a typed verdict — built entirely on direct-API `llm` steps, no agent CLI needed. |
| `mainline` | Plans independent execution streams, implements+reviews+fixes+tests each in parallel worktrees, merges them, reviews the merge, opens a PR, files every out-of-scope finding as an issue. See [docs/mainline-pipeline.md](docs/mainline-pipeline.md). |
| `mainline-stream` | The per-stream unit `mainline` fans out to a plain implement→review→fix→test loop; also runs standalone. |

### One prompt in, one reviewed PR out

`mainline` is the pipeline you reach for when a task is too big for one
agent call but you still want ONE reviewed pull request out the other end,
not a pile of half-finished branches to babysit. A planner splits your
prompt into independent streams; each stream is implemented and
review/fix/test-looped **in its own worktree, in parallel**; an agent merges
the streams; the merged result gets one more review/fix/test pass; a PR
opens. Every out-of-scope bug anyone noticed along the way — implementer,
reviewer, planner — gets filed as a GitHub issue instead of silently
dropped or scope-creeping the task. Model tiers are `--param`s, not forks of
the spec: run it keyless on free models to see the shape, then point
`coderModel`/`reviewerModel`/`plannerModel` at whatever your budget allows.
See [docs/mainline-pipeline.md](docs/mainline-pipeline.md) for the full
walkthrough and a premium/balanced/budget model-tier table.

### Skip the CLIs entirely with direct-API `llm` steps

Not every step needs a full coding agent. An `llm` step calls a model's HTTP API
directly — cheaper, faster, no CLI to install. It works out of the box with
`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, and ships with built-in **OpenRouter**
and **OpenCode Zen** gateways — just set `"api": "openrouter"` (or point it at
**any OpenAI-compatible endpoint**: a corporate gateway, Groq, a local Ollama).
OpenCode Zen even runs its free models **keyless**, so you can try an `llm`
workflow with no API key at all. Great for routing, triage, and synthesis glue
between the heavyweight agent steps.

### Let agents edit safely, then merge back on purpose

Every agent step runs in its **own isolated git worktree**, so parallel agents
never trample each other or your working copy. When a run is done, you decide
what lands: end the workflow with a declarative `merge` step to harvest edits
automatically, or review after the fact — `history show <id> --diff` shows what
each step changed, and `history apply <id>` merges those changes into your
checkout as uncommitted edits. Apply is pre-checked and all-or-nothing; the merge
happens in a throwaway staging worktree, so a failure never damages your repo.

### Tell a reviewer it *cannot* write

Isolation protects your checkout; permissions protect everything else. Any agent
step can declare a sandbox profile — `read-only`, `edit`, or `full` — and the
engine makes it stick three ways: it translates the profile into the CLI's native
flags (`claude --permission-mode` + tool allow/deny lists, `codex --sandbox`,
opencode's read-only `plan` agent), it **refuses to launch** a restricted step on
an agent that cannot enforce it, and after every `read-only` step it compares the
workspace against a fingerprint taken before the agent started — failing the step,
with the offending paths, if anything changed. Declare it once at the workflow
level (or repo-wide in `steamtrain.json`) and every step is read-only until it
says otherwise. `bug-hunt`, `multi-plan`, and `target-sweep` ship read-only end to
end; `/permissions read-only --all` locks down someone else's workflow before you
run it. See [docs/permissions.md](docs/permissions.md).

### Know exactly what it cost

steamtrain normalizes every agent's usage into one token model (input, output,
cache read/write, reasoning) and prices it in USD. A live `$cost · N tok` ticker
runs during the TUI; the workflow view breaks it down per model. Set
`maxCostUsd` on a workflow (or a fan-out step) and the engine **stops scheduling
new steps once the cap is hit**, records the run as budget-exceeded, and keeps
the cache — so raising the cap and re-running just resumes. Afterward,
`workflow costs` aggregates spend across your history to answer "which step is
eating the budget?"

### Every run is recorded and repeatable

Each run (TUI, web UI, or CLI) is saved to `.steamtrain/history/` as one JSON
record — the full phase → step tree with status, output, duration, cost, and
gate results. Re-running **resumes** from an on-disk cache instead of paying for
completed steps again. Re-run any past run fresh (`run --from <id>`), or replay
only what failed (`--retry-failed`).

### Stay in control of unattended runs

Workflows can pause at **human approval checkpoints**. Attended, you approve in
the UI; unattended, `--approve-all` waves everything through or
`--on-approval fail|stop` rejects cleanly — so the same workflow is safe to wire
into CI. Headless runs end with a one-line-per-step **status summary** and an
honest exit code.

### Put a human in the loop — deliberately

Beyond consent, a run can ask for **data**: a `human` step's output is typed
by a person (free text, pick-one choices, or schema-validated JSON), and a
`canAsk: true` agent step may pause to ask **one clarifying question** instead
of guessing — answered from any surface, resuming the agent's session with
full context. Every workflow wears an **autonomy label** (`▸ autonomous`,
`✋ approvals`, `✎ interactive`) in every list and preview, so you know what a
run will need from you before launching it; a `notify` config block (bell /
desktop / webhook) pings you when one is waiting. And when a step needs hands,
`workflow takeover` drops you into its recorded agent session inside its
worktree. See [docs/human-in-the-loop.md](docs/human-in-the-loop.md).

### Steer a run without restarting it

A live run isn't a batch job you can only watch or kill. **Pause** it
(in-flight steps finish; nothing new starts), **edit** any step that hasn't
run yet — fix the prompt you mistyped, swap the model, tweak a `command` —
then **resume**, and the run continues with your corrections. Works from every
surface (`p`/`e` in the TUI, Pause + per-card Edit in the web UI,
`workflow pause|edit-step|resume` in the CLI) on runs owned by any process,
and every intervention is recorded in the run history, so a steered run is
still an honest record. See
[docs/mid-run-steering.md](docs/mid-run-steering.md).

### Fire it off, come back later

Long workflows shouldn't hold a terminal hostage. `workflow run --detach`
executes under a background process that survives your session; **attach from
any UI** — CLI (`workflow attach`), TUI (`/attach`), or the web UI's Active
runs panel — to replay the record so far and tail it live. Already started a
run in the TUI or web UI and need to step away? **Detach it mid-flight** —
press `d` in the TUI or click **Detach** in the web UI: the run finishes its
in-flight steps, hands off to a background process under the same id, and keeps
going after you close the UI (the view re-attaches so you keep watching). A
shared **run queue** (`maxParallelRuns`) keeps concurrent runs from colliding
over the cache and worktrees, and cancel/approve work cross-process: decide a
detached run's approval checkpoint from whichever surface is handy. See
[docs/detached-runs.md](docs/detached-runs.md).

### See it in the terminal or the browser

The **TUI** opens on a workflow picker and streams the phase → step tree live;
`Enter` runs, `↑/↓` inspects a step's output, `Tab` cycles workspace presets,
`Esc` cancels. The **web UI** (`--web-ui`) pairs the picker with a vertical
pipeline visualization — phases stacked top-to-bottom, parallel steps as live
cards colored by block kind, each streaming output, duration, and cost over SSE —
backed by the exact same runner, cache, and doctor gating.

### It tells you when something's wrong before you spend a cent

A preflight **doctor** resolves each agent binary on your PATH, runs
`--version`, and classifies readiness (`ok` / `binary_missing` /
`not_authenticated` / `unknown_error`). The status bar shows a green/amber/red
dot per agent, and dispatch is **blocked** for any step whose agent isn't ready —
with a copy-paste fix.

**Or just run with what you have.** When a workflow is blocked only because a
pinned agent isn't installed, you don't have to install it: re-route the
blocked steps onto a ready agent for that run. On the CLI, `workflow run
<name> --agent <id>` (the blocked error also prints the exact re-run command);
in the TUI, `/reroute` on the blocked preview; in the web UI, the sidebar shows
`↷ via <agent>` and **Run** re-routes automatically. Only the blocked steps
move, only for that run — `llm` steps and steps already on a ready agent are
left untouched, and the workflow on disk is unchanged.

---

## Below the fold: technical reference

### Workflow CLI

```bash
steamtrain workflow list
steamtrain workflow validate [name]
steamtrain workflow plan <name> --input "…"                     # dry-run: resolve the plan without running
                                                                # (includes avg cost/duration from recorded runs)
steamtrain workflow run multi-plan --input "design the cache migration"
steamtrain workflow run multi-plan --input "…" --dry-run        # same as plan: print and exit, run nothing
steamtrain workflow run bug-hunt --stdin --json
steamtrain workflow run multi-plan --input "…" --fresh          # ignore the on-disk cache
steamtrain workflow run bug-hunt --input "…" --agent claude     # re-route steps whose pinned agent isn't ready (this run only)
steamtrain workflow plan bug-hunt --input "…" --agent claude    # preview that re-routed run without running it
steamtrain workflow cache clear

# Unattended approval handling
steamtrain workflow run review-loop --input "…" --approve-all
steamtrain workflow run review-loop --input "…" --on-approval fail

# Human-in-the-loop input (docs/human-in-the-loop.md)
steamtrain workflow run incident-review --input "…" --human timeline=@notes.txt
steamtrain workflow answer <runId> [--step <stepId>] --value "…"  # answer a parked human step / agent question
steamtrain workflow takeover <runId> <stepId>  # resume a step's agent session interactively in its worktree

# Detached runs & the run queue (docs/detached-runs.md)
steamtrain workflow run bug-hunt --input "…" --detach   # fire and return; survives this terminal
steamtrain workflow runs                       # in-flight runs across every UI (--all, --json)
steamtrain workflow attach <runId>             # replay + live tail; Ctrl+C detaches
steamtrain workflow cancel <runId>             # stop a run owned by any process
steamtrain workflow approve <runId> [--reject] # decide a parked approval checkpoint

# Mid-run steering (docs/mid-run-steering.md): pause, fix a pending step, resume
steamtrain workflow pause <runId>              # in-flight steps finish; nothing new starts
steamtrain workflow edit-step <runId> <stepId> --prompt "corrected prompt"  # or --cmd/--model/--effort
steamtrain workflow resume <runId>

# Inspect past runs (recorded automatically to .steamtrain/history/)
steamtrain workflow history                    # list recent runs (newest first)
steamtrain workflow history show <id>          # full phase → step breakdown
steamtrain workflow history show <id> --diff   # what each step changed (--stat, --step <id>)
steamtrain workflow history apply <id>         # merge a run's edits into your checkout
steamtrain workflow history prune <id>         # discard a run's worktrees and branches
steamtrain workflow history clear [<id>]       # delete one run, or all of them

# Act on a past run (workflow + input come from the record)
steamtrain workflow run --from <runId>                 # re-run it fresh
steamtrain workflow run --from <runId> --retry-failed  # re-run only failed/not-run steps

# Cost analytics across history
steamtrain workflow costs [--workflow <name>] [--json]

# Draft a brand-new workflow from a description (LLM delegation), then save it
steamtrain workflow create --input "review a PR from three angles then merge findings"
steamtrain workflow create --input "audit the auth module" --agent claude --model claude-sonnet-4-6 --save
steamtrain workflow create --input "team release checklist" --name release-check --save --scope project
```

Global options (TUI and workflow commands):

```
  -v, --version              Print the steamtrain version and exit
      --project-dir <path>   Operate on this project directory instead of cwd
                             (alias: --cwd). Loads <dir>/steamtrain.json, writes
                             .steamtrain/ state there, and runs agents as if
                             launched from that directory.
  -w, --workspace <path>     Load workspace presets from a custom workspace.json
      --config-file <path>   Load project config from a custom steamtrain.json
                             (state and agents still use --project-dir / cwd)
      --web-ui               Serve the browser UI instead of the TUI
      --port <n>             Web UI port (default 4317)
      --host <host>          Web UI bind host (default 127.0.0.1)
      --auth-token <token>   Require this token for web UI access
                             (or set STEAMTRAIN_AUTH_TOKEN; non-local binds
                             auto-generate a token when neither is given)
      --read-token <token>   Second web UI credential that mints a read-only
                             session (view only; or set STEAMTRAIN_READ_TOKEN)
      --read-only            Force every web UI session into read-only capability
      --no-auth              Serve a non-local web UI bind without auth (unsafe)
      --trust-proxy          Honor X-Forwarded-* headers (only behind a proxy
                             you run; required for correct https/Secure cookies)
```

The TUI status bar and web header always show the current project name and
directory, so you can tell at a glance which checkout steamtrain (and its
agents) are operating on. Set an optional `"name"` in `steamtrain.json` to
override the display name (otherwise package.json `name`, then the folder
basename).
`init` reports each agent's readiness with copy-paste fixes, detects this repo's
real test/lint commands, and offers starter workflows written to
`./steamtrain.json`:

- **`verify`** — every detected check as a parallel `command` step plus a
  combined report. Agentless, $0, and an honest exit code for CI.
- **`implement-verified`** — an agent implements the task in an isolated
  worktree, your test command re-runs against those edits, a gate blocks
  failures, and a `merge` step applies only verified changes to your checkout.
  (Offered when an agent is ready and a test command is detected.)

In a git repo, `init` also offers to add `.steamtrain/` to your `.gitignore`
so run history (which records every step's full output), caches, and live-run
state never land in commits.

Pass `--yes` to accept all offers. In a non-interactive session (piped stdin,
CI), `init` lists offers but writes nothing unless `--yes` is given.

More: [`docs/web-ui.md`](docs/web-ui.md),
[`docs/workflow-creation.md`](docs/workflow-creation.md),
[`docs/cost-and-budgets.md`](docs/cost-and-budgets.md).

### The TUI

`steamtrain` opens on **workflow** mode with a preflight doctor panel:

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
```

**Keys:** `Enter` run · `↑/↓` pick workflow or inspect steps · `Tab` cycle
workspace preset (`plan`, `implement`, `review`) · `Esc` cancel/back ·
`Ctrl+C` quit. Type `/help` for every key and slash command, `/history` to
open the run browser, `/create-workflow` to draft one from a description.
A typo'd `/command` never dispatches as input — you get a
"did you mean …?" instead of an accidental run.

### Install as a system binary

> **Alpha install.** steamtrain isn't published to a registry yet, so you
> install it from a checkout. macOS and Linux are supported.

`npm run install:local` is a thin wrapper over
[`scripts/install.sh`](scripts/install.sh) that:

1. verifies Bun 1+ and Node.js 20+, installs dependencies with Bun, and builds
   `dist/index.js`,
2. symlinks a `steamtrain` command into `~/.local/bin` — **no sudo required** —
   and prints how to add that directory to your PATH if it isn't already there.

The link points back at `dist/index.js` in this checkout (runtime deps stay in
its `node_modules`), so **keep the repo where it is**. After a `git pull`, re-run
`npm run install:local` to rebuild and refresh the linked binary.

**Custom location** (e.g. a shared, already-on-PATH dir):

```bash
STEAMTRAIN_BIN_DIR=/usr/local/bin bash scripts/install.sh
```

**Link only** (skip dependency installation and the build if `dist/` is already
current; only Node.js is required for this mode):

```bash
bash scripts/install.sh --no-build
```

**Uninstall** — removes only the launcher, not your checkout or `~/.steamtrain`
config:

```bash
npm run uninstall:local
```

Prefer the Node toolchain's own linker? With Bun installed, `npm run build && npm link` also works.

### Build a standalone bundle

```bash
bun install
npm run build          # tsup → dist/index.js (with shebang)
node dist/index.js     # run the built entrypoint directly
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

steamtrain splits configuration across scopes that merge as
**defaults → global → project**:

| File | Scope | Contents |
| ---- | ----- | -------- |
| `~/.steamtrain/workspace.json` | user (global) | One-shot **workspace presets** — Tab modes like `plan`, `implement`, `review` |
| `~/.steamtrain/config.json` | user (global) | Global agent/API instances, binaries, timeouts |
| `~/.steamtrain/workflows.json` | user (global) | Your saved workflows |
| `./steamtrain.json` | project (cwd) | Workflows, agent/API instances, binary paths, timeouts, concurrency |

### Workspace presets (`~/.steamtrain/workspace.json`)

Built-in defaults live in `src/workspace/defaults.ts` (`plan`, `implement`,
`review`). Override or extend them:

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

Entries merge by `id` onto the built-in defaults. A missing or invalid file
falls back to built-in defaults with a warning in the stream.

> **Migration:** older `steamtrain.json` files used a `"tasks"` key for these
> presets. That key is no longer supported — move them to
> `~/.steamtrain/workspace.json`.

### Project config (`steamtrain.json`)

Override any subset in the working directory:

```jsonc
{
  "binaries": { "opencode": "/opt/homebrew/bin/opencode" }, // optional path overrides
  "stepTimeoutSec": 900,                                    // per-agent subprocess limit (default 15m = 900)
  "workflowTimeoutSec": 1800,                               // optional whole-run cap; omit = (loop-aware) steps × stepTimeoutSec
  "maxConcurrency": 5,                                      // parallel steps per run (≤ 16, default 5)
  "permissions": "read-only"                                // repo-wide sandbox default for agent steps — see docs/permissions.md
  // "agents": [ … ]      // extra agent instances — see docs/agent-configuration.md
  // "apis": [ … ]        // API endpoints for llm steps — see docs/api-configuration.md
  // "workflows": { … }   // see “Workflows” below
}
```

- **claude** models are aliases/ids like `claude-sonnet-4-6`, `haiku`, `claude-opus-4-8`.
- **opencode** models are `provider/model` and must be a provider you've
  authenticated (`opencode auth login`).

A missing/invalid `steamtrain.json` falls back to built-in defaults (with a
warning); only the keys you specify are overridden.

### Agent & API instances

Beyond the five built-in agents, you can register additional **agent instances**
(a provider adapter plus a custom binary/env/args — e.g. a fork) and **API
instances** (an HTTP endpoint for `llm` steps: dialect, base URL, key env var,
default model, pricing). Both configure at global or project scope and merge by
`id`. Built-in `anthropic`, `openai`, `openrouter`, and `opencode-zen` API
instances exist with zero config; customize one, point it at a gateway, or
define new ones (Groq, etc.) under `apis`. See
[`docs/agent-configuration.md`](docs/agent-configuration.md) and
[`docs/api-configuration.md`](docs/api-configuration.md).

---

## Workflows

A **workflow** is steamtrain's central unit: a declarative sequence of **phases**
made from standard building blocks. Steps are **dependency-scheduled**: each
step starts as soon as the steps it references have finished, in parallel with
anything unrelated. A step without `dependsOn` waits for all earlier phases, so
phases still act as barriers for it. Distributors can produce many work items,
processors can dynamically fan out to one generated agent run per item, and
later steps can gate or consolidate the aggregate output.

Re-running **resumes**: completed steps replay from `.steamtrain/cache/` (and an
in-session cache) instead of running again. The cache is keyed by workflow spec,
input, and cwd — editing a workflow invalidates stale entries automatically.
Use `--fresh` to ignore the on-disk cache, or `workflow cache clear` to delete it.

Agent steps **auto-retry transient failures** (a crash or transport/spawn error
before the agent completed a turn) with exponential backoff — on by default,
configurable via a workflow-level or per-step `retry` policy. A step that ran to
completion and reported an error is never auto-retried (it may have made changes).

Workflow documentation:

- [`docs/workflow-overview.md`](docs/workflow-overview.md) — mental model, diagrams, execution behavior
- [`docs/workflow-examples.md`](docs/workflow-examples.md) — patterns and bundled workflow walkthroughs
- [`docs/workflow-spec.md`](docs/workflow-spec.md) — language reference
- [`docs/permissions.md`](docs/permissions.md) — per-step tool permissions and sandbox profiles
- [`docs/worktree-merge-back.md`](docs/worktree-merge-back.md) — worktree isolation and the `merge` step

### Bundled workflows

| name         | what it does                                                                                                                         |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `tour`       | A $0, agentless guided ride through the engine: fan-out, parallel command cars, a `when` skip, a loop-back gate, and a consolidated arrival report. Runs with zero credentials. |
| `multi-plan` | Distributes planning lenses, drafts from two independent angles (claude + opencode), critiques both, then synthesizes the strongest merged plan. Fully `read-only`. |
| `bug-hunt`   | Sweeps a scope for logic / error-handling / security bugs in parallel across three models, cross-checks to drop false positives, gates verified findings, then reports them. Fully `read-only`: it reports bugs, it cannot touch the repo. |
| `target-sweep` | Distributes a request into target areas, dynamically creates one processor run per item, then consolidates the generated outputs. Fully `read-only`. |
| `review-loop` | Implements, then reviews and fixes in a bounded loop-back gate until the review reports "DONE" (or the iteration cap is hit). The review step is `read-only` — it cannot edit the code it is reviewing. |
| `quick-triage` | Splits a request into concerns, assesses each in parallel, and gates on a typed verdict — built entirely on direct-API `llm` steps: no agent CLI needed, just `ANTHROPIC_API_KEY`. |
| `mainline` | Plans independent execution streams, fans each out to `mainline-stream` in its own worktree, merges via `mode: "worktree"` with agent conflict resolution, runs one final review/fix/test loop on the merge, opens a PR (or leaves a branch), and files out-of-scope findings as GitHub issues (or a report). See [docs/mainline-pipeline.md](docs/mainline-pipeline.md). |
| `mainline-stream` | The per-stream pipeline `mainline` fans out to: implement in a worktree, then loop review → fix → test (via `workspace: "attach:"`, so each iteration sees the previous one's fixes) until clean. Standalone-runnable. |
| `babysit-pr` | Prepare one open GitHub PR (rebase, review comments), then deterministically wait for every CI/status check - including non-required external reviews - and merge only when green. Agents never merge or delete the remote branch. |
| `babysit-all-prs` | List every open PR and fan each out to `babysit-pr` in parallel, then summarize. |

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

- **Step kinds:** `worker` / `processor`, `distributor`, `consolidator`, `gate`,
  `llm` (direct-API inference), `command` (run a shell check), and `merge`
  (harvest worktree edits). Existing steps without `kind` are workers.
- **Agent-backed fields:** a **model binding** plus `prompt`. Bind with
  `agent` + `model` (classic pin), `model` alone (auto-picks the best ready
  agent — reference preferred), or `modelClass`
  (`thinker` | `ultrathinker` | `implementer` | `reviewer` | `deep-reviewer` |
  `simple` | `balanced`). Optional
  `fallbackModels` lists failover queries; optional `modelFailover` configures
  mid-flight re-routing on quota / rate-limit errors. Workflow `inputs` may use
  `type: "model"` / `"agent"` / `"enum"` for catalog autocomplete, and a
  model input's own `fallbackModels` are inherited by steps that reference it
  via `{{inputs.<key>}}`. See
  [`docs/model-binding.md`](docs/model-binding.md) and
  [`docs/workflow-spec.md#workflow-inputs`](docs/workflow-spec.md#workflow-inputs).
  Agents:
  `claude` | `opencode` | `codex` | `cursor` | `antigravity` | `amp` | `kiro` | `mimo` | `kimi`.
  Also optional: `cwd` (the **target** dir; relative paths resolve against the
  launch cwd), `env` (extra vars), and `extraArgs` (extra CLI flags).
- **Dynamic fan-out:** add `forEach: "steps.<id>.items"` to a worker/processor
  to create one generated child agent run per distributor item. Use `{{item}}`,
  `{{item.index}}`, and `{{item.sourceStepId}}` in that prompt.
- **Dependencies:** `dependsOn` may reference only steps in *earlier* phases.
  Steps are scheduled by these dependencies; a step without `dependsOn` waits
  for every step in all earlier phases.
- **Conditions:** any step may set `when` (gate-condition schema) to run only
  when it matches — otherwise the step is *skipped* (not failed), skips cascade
  to dependents, and consolidators treat skipped inputs as absent.
- **Prompt templates:** `{{input}}` / `{{args}}` expand to what you typed;
  `{{steps.<id>.output}}`, `{{steps.<id>.items}}`, `{{steps.<id>.ok}}`,
  `{{steps.<id>.error}}`, `{{steps.<id>.target}}`, and worktree paths
  (`{{steps.<id>.worktree.root}}` / `.branch` / `.cwd`) expose earlier results.
- **Budgets:** set `maxCostUsd` on a workflow (or a `forEach` step) to cap spend
  — the engine stops scheduling new steps at the cap, records the run as
  budget-exceeded, and leaves the cache intact so raising the cap resumes it.
- **Limits:** ≤ 16 parallel steps per run and 1000 steps per run. Only
  agent-backed steps cost money.
- **Loops:** a gate can set `loopTo` to jump back to an earlier phase (with an
  optional `maxIterations`) for bounded "review until clean" cycles.

---

## Doctor (preflight)

At startup, before any dispatch, steamtrain checks each agent:

1. resolve the absolute binary on `PATH` (→ `binary_missing` with an install hint if absent),
2. run `<binary> --version` to confirm it executes,
3. classify readiness as `ok | binary_missing | not_authenticated | unknown_error`
   from exit code + stderr.

The status bar shows a green/amber/red dot per agent, and **dispatch is blocked**
for any task whose agent isn't `ok`, with a fix-it message. When the only thing
missing is an uninstalled agent, you can re-route the blocked steps onto a ready
one instead of installing it — `--agent <id>` on the CLI, `/reroute` in the TUI,
or the web UI's `↷ via <agent>` Run (see "run with what you have" above).

> `claude --version` returns success even when logged out, so the doctor can show
> claude as `ready` while a dispatch later surfaces "Not logged in" as an `error`
> event. Run `claude` → `/login` to authenticate.

---

## Development

```bash
bun install
bun src/index.tsx     # run the TUI directly from source
npm run dev           # regenerate browser assets, then run the TUI with Bun
npm test              # regenerate browser assets, then run the full Vitest suite
npm run typecheck     # tsc --noEmit (strict, noUncheckedIndexedAccess)
npm run lint          # biome
npm run build         # tsup → dist/
```

### Tests

The highest-risk areas are covered first:

- **`tests/line-buffer.test.ts`** — NDJSON reassembly with events split across
  arbitrary chunk boundaries, CRLF, blank lines, and trailing partials.
- **`tests/claude-adapter.test.ts`** / **`tests/opencode-adapter.test.ts`** —
  the raw→normalized mapping for each CLI, using real sample event lines.
- **`tests/workflow-*.test.ts`** — the workflow layer: the bounded-concurrency
  pool + channel, prompt templating, spec/dependency validation, the reducer that
  builds the live tree, and the engine end-to-end (phase ordering, parallel
  fan-out, cross-phase templating, failures, abort, and in-session resume — all
  against an injected fake adapter, no real CLIs).

---

## License

MIT
