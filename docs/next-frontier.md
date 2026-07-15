# steamtrain — the next frontier

Date: 2026-07-07

A second-generation idea set, deliberately **disjoint** from
[`feature-roadmap.md`](feature-roadmap.md): items here are not on that
roadmap (parts 1–3), the dry-run follow-ups, or the release-readiness
checklist. Several entries below are **partially or fully shipped** — those
are marked inline. Where an item is adjacent to a roadmap entry, the
difference is called out explicitly.

The organizing observation: most shipped work and most of the existing
roadmap still treat a workflow run as a **batch job** — you author it, fire
it, and inspect the wreckage or the trophy afterward. World-class
orchestration of *agents* (as opposed to containers or shell scripts) needs
three more pillars:

1. **The run as a live collaboration** — steer, answer, take over, rewind
   (items 1–4).
2. **Right-sized primitives** — not every LLM touch should cost a full
   coding-agent boot; not every prompt should be hand-packed context
   (items 5–6).
3. **Workflows that learn** — memory across runs, measurable quality, and
   self-repair (items 7–9), plus the trust plumbing that team use demands
   (item 10).

Ordered roughly by leverage-per-effort.

---

## 1. Lightweight `llm` step kind (direct API inference)

**The gap:** steamtrain has a deterministic primitive (`command`) and a
heavyweight nondeterministic one (a full coding-agent subprocess) — and
nothing in between. Every judge/classify/summarize/route touch boots an entire
`claude`/`opencode` CLI session with a tool harness, repo access, and
multi-second startup, just to turn one prompt into one completion. The bundled
workflows are full of these: consolidators that merge text, gates fed by
verdict steps, distributors that split a request into a list. None of them
need tools; all of them pay for tools.

**The feature:** `"kind": "llm"` — a single stateless API call (Anthropic /
OpenAI / any OpenAI-compatible endpoint, key from env), with `model`,
`prompt`, optional `system`, optional `output` schema (reusing the shipped
structured-output machinery, which gets *more* reliable here since JSON mode /
tool-forcing is available at the API level). No worktree, no doctor
dependency, near-zero startup, exact token accounting. Bundled workflows adopt
it for their consolidate/judge/split steps.

**Why it matters:** it makes the median workflow dramatically faster and
cheaper without changing its meaning, and it decouples "steamtrain needs an
agent CLI installed and authenticated" from "steamtrain needs an API key" —
which quietly fixes the CI story too. This is the `BashOperator` /
`PythonOperator` split every mature orchestrator converges on: the engine
provides primitives at every cost tier, and the author picks.

> **Shipped (2026-07-08):** `"kind": "llm"` — Anthropic + any OpenAI-compatible
> endpoint, key from env, `system`, structured `output` with API-level JSON
> mode where available, `itemsPath` splitting, `forEach` fan-out, always-safe
> auto-retry, exact token accounting (plus exact `costUsd` via per-step
> `pricing`). The bundled `quick-triage` workflow is built entirely on it; the
> agent-backed bundled workflows deliberately keep their zero-API-key free-tier
> models. See `docs/workflow-spec.md` → "Llm (direct API inference)".
>
> **Shipped (2026-07-08, follow-up):** configurable **API instances** — named
> endpoints under `apis` in the global/project config, referenced from steps
> via `api: <id>`, with the same treatment agents get everywhere: manageable
> in every UI (`/api` + `/apis` in the TUI, the web config page), readiness in
> the status bar / health chips / `GET /api/doctor`, pre-dispatch gating, and
> `api/model` cost attribution. See `docs/api-configuration.md`.

## 2. Mid-run steering: pause, rewind, edit, replay

**The gap:** once a run starts, the only verbs are *watch* and *cancel*
(approval gates add *consent*, at pre-declared checkpoints only). When step 7
of 9 goes sideways — wrong interpretation, degenerate output, a prompt typo
you spot in the stream — the whole run is a write-off. Re-run `--from` replays
a *finished* run verbatim; `--retry-failed` re-runs failures unchanged.
There is no "that step went wrong, fix it and continue."

**The feature:** run-level time travel, built on machinery that already
exists (the step cache, the session-override layer, the reducer):

- **Pause** a live run (finish in-flight steps, schedule nothing new) and
  **resume** — TUI keybind, web button, and a queued-pause API.
- **Rewind & replay:** select any step in a live-but-paused *or* finished run,
  edit its prompt (or hand-edit its recorded output — "the reviewer was 90%
  right, fix the one wrong finding"), and re-execute from that point.
  Upstream steps replay free from cache; downstream invalidates
  automatically, exactly like the existing spec-edit invalidation.
- Every intervention lands in the run record, so a steered run is still an
  honest, auditable record.

**Why it matters:** agent steps fail *interestingly*, unlike container steps.
The orchestrators steamtrain is benchmarked against never needed this because
`npm test` doesn't misunderstand you. For an AI workflow manager this is the
single biggest practicality unlock: it converts "restart the 40-minute run
and pray" into a 30-second correction, and it makes iterating on a new
workflow feel like debugging with a REPL instead of punch cards.

> **Shipped (2026-07-11, pause/edit/resume):** the steering half — **pause** a
> live run (in-flight steps finish, nothing new schedules; loop workflows
> pause at the phase boundary), **edit** any step that hasn't started yet
> (prompt / `cmd` / model / effort, validated by the engine against the live
> spec, stale cache entries dropped so the edit really runs), and **resume**.
> Surfaced everywhere: TUI (`p` pause, `e` edit the selected pending step),
> web UI (Pause/Resume button + per-card "Edit step" while paused), CLI
> (`workflow pause|resume|edit-step`), and HTTP — all cross-process through
> the live-run store, so any surface can steer any process's run. Every
> intervention is recorded (`run_paused`/`run_resumed`/`step_edited` events,
> an `interventions` list in history, `✎ edited` badges). **Rewind & replay
> of already-completed steps was deliberately dropped** from the scope — steps
> that ran keep their results; editing targets only the run's future. See
> `docs/mid-run-steering.md`.

## 3. Human-as-a-step: `kind: "human"` + agent clarifying questions

**The gap:** approval gates made the human a binary comparator — approve or
reject. But real pipelines need human *output*, not just human consent: paste
the incident timeline, choose which of three proposed designs to implement,
answer the one question the agent is stuck on. Today that means splitting one
workflow into two and hand-carrying text between them.

**The feature:**
- `"kind": "human"` — a step whose output a person supplies. Fields: a
  templated `prompt` shown to the human (which can interpolate earlier step
  outputs), optional `choices` (rendering as pick-one), optional `output`
  schema (a generated form, reusing the typed-inputs form machinery from both
  UIs). Downstream steps consume `{{steps.<id>.output}}` like any other step.
  Headless runs use `--human <stepId>=<value|@file>` or fail fast with a clear
  message.
- **Agent clarifying questions** (opt-in per step: `canAsk: true`): the
  adapter injects a protocol line telling the agent it may emit a
  `QUESTION: …` marker instead of guessing; the engine pauses the step,
  surfaces the question through the same human-input UI, and resumes the
  session with the answer. Bounded (one question per step by default).

**Why it matters:** the best answer to "the agent guessed wrong" is often
"let it ask." This is the piece that makes long, expensive workflows *converge*
instead of confidently diverging — and no workflow tool in the comparison set
(Actions, Airflow, Temporal, n8n) can offer it, because their steps can't
formulate questions. It's steamtrain-native differentiation.

## 4. Interactive takeover: drop into a step's session

**The gap:** a step gets 90% of the way there and stalls, or a run finishes
and you want to nudge the result. Your options today are re-prompting through
another step or abandoning the orchestrator to start a fresh agent session
from zero — losing the step's conversation context and its worktree state.

**The feature:** `steamtrain workflow takeover <runId> <stepId>` (and a
"Take over" action on step detail in the TUI/web): suspend orchestration and
exec the agent's *interactive* CLI inside the step's worktree, resuming the
step's recorded session (`claude --resume <sessionId>`; the adapters already
capture session ids from `system/init`). You finish the job by hand with the
agent's full context. On exit, steamtrain reconciles: the worktree's final
state flows into the existing merge/diff machinery, and the takeover is
recorded in run history.

**Why it matters:** it deletes the false choice between "orchestrated" and
"hands-on." The escape hatch is what makes people willing to route serious
work through workflows at all — you're never trapped behind the abstraction.
(Distinct from roadmap 2.6, which chains sessions *between steps*; this hands
a session to a *person*.)

## 5. Declarative context packs

**The gap:** the only way a step learns anything about the repo is whatever
the agent decides to go read, or whatever the author hand-pastes into a JSON
prompt string. There's no way to say "this review step must see
`docs/architecture.md` and the diff since main" — so authors either over-trust
agent exploration (slow, token-hungry, nondeterministic) or maintain giant
brittle prompts.

**The feature:** a `context` field on agent-backed and `llm` steps — an
ordered list of sources injected into the prompt under labeled headers:

```jsonc
"context": [
  { "file": "docs/architecture.md" },
  { "glob": "src/auth/**/*.ts", "maxTokens": 6000 },
  { "cmd": "git diff main --stat" },
  { "step": "plan", "as": "The approved plan" }
]
```

Each source takes `maxTokens` with head/tail truncation; the engine reports
the assembled context size per step (feeding the token accounting that already
exists), and `workflow plan` renders the resolved pack so authors see exactly
what a step will be given before spending money.

**Why it matters:** context assembly *is* prompt engineering for repo-scale
work, and today it's the workflow author's unpaid job. Making it declarative
makes workflows portable across repos (the pack travels with the spec),
auditable (the dry-run shows it), and cheap (no exploratory tool calls to
rediscover the same three files every run).

## 6. First-run experience: `steamtrain init` + zero-cost demo

**The gap:** a new user's first five minutes assume two authenticated agent
CLIs, hand-written JSON, and a willingness to spend tokens on faith. The
bundled workflows are good demos, but nothing *walks* anyone in, and the
first run of `multi-plan` costs real money before trust exists.

**The feature:**
- `steamtrain init` — an interactive bootstrap: run the doctor, explain
  what's missing with copy-paste fixes, offer starter workflows tuned to the
  detected repo (test runner found → a review-loop wired to the real test
  command via `command` steps), write a commented `steamtrain.json`.
- A bundled `tour` workflow that costs **$0**: distributor/gate/command steps
  plus a scripted mock agent, exercising fan-out, a gate, a loop, and the live
  tree — so the *product* is demonstrable before any credential exists.
- A `--record` flag that captures a run as an asciinema-compatible cast for
  README/social embedding.

**Why it matters:** world-class open source is won in the first session.
steamtrain's depth is currently invisible until after the steepest part of
the curve; this flattens it. (The readiness doc asks for screenshots and
install docs — this is product onboarding, which it doesn't cover.)

## 7. Persistent workflow memory across runs

**The gap:** every run starts amnesiac. A weekly `bug-hunt` re-reports the
finding you triaged as accepted-risk three weeks running; a docs-audit
workflow can't know what it flagged last time; nothing can express "since the
last run." History *stores* the past but nothing *feeds* it forward.

**The feature:** a per-workflow, per-repo memory store
(`.steamtrain/memory/<workflow>.json`) with three faces:

- **Read:** `{{memory.<key>}}` in any template; absent keys render a
  declared default (first run stays coherent).
- **Write:** a `remember` map on any step, templated from that step's
  (structured) output — e.g. the consolidator stores
  `"knownFindings": "{{steps.report.json.acceptedIds}}"` and the next run's
  scan prompt excludes them. Writes commit only when the run succeeds.
- **Curate:** `steamtrain workflow memory <name> [get|set|clear]` plus a
  small editor panel in both UIs, so memory never becomes an invisible
  haunted state.

**Why it matters:** this is what turns recurring workflows from stateless
reports into processes that *converge* — the difference between a linter and
a colleague. It's also the missing half of scheduled runs (roadmap part 3):
a cron that re-discovers the same facts weekly is noise; one that reports
deltas is signal.

## 8. Run comparison and an eval harness

**The gap:** you can rerun a workflow, but you can't *learn* from the pair.
Was the run cheaper after the prompt tweak? Did downgrading the review step
to a cheaper model hurt? Today the answer is "open two history records in two
terminals and squint." (Distinct from the roadmap's mock-agent testing
framework, which verifies *routing* without spending tokens — this measures
*output quality* of real runs.)

**The feature:**
- `steamtrain workflow compare <runA> <runB>` (+ a two-column web view):
  aligned step-by-step comparison — status, duration, cost, tokens, output
  diff, worktree diffstat — with per-step deltas rolled up to run level.
- `steamtrain workflow eval <name> --variants variants.json --trials N`:
  run a small matrix of spec variants (model/effort/prompt overrides — the
  session-override layer already expresses exactly this) against fixed
  inputs, score each trial with a graded `command` step or an `llm`-judge
  step (item 1), and emit a scoreboard: cost × latency × score per variant.

**Why it matters:** "which model is good enough for this step?" is the
question every serious user asks weekly, and today the tool that has all the
data (history already records cost, tokens, outputs, diffs per step) offers
no way to answer it. An eval harness converts workflow tuning from vibes to
evidence — and it's the kind of feature that gets an OSS tool cited, because
almost nobody in the agent-orchestration space has it.

## 9. Failure postmortem: `history why <runId>` + proposed fix

**The gap:** a failed run hands you a status table and raw step outputs;
the diagnosis is manual archaeology. The failure *taxonomy* is wide — gate
tripped on a phrasing quirk, agent misread a template, timeout too tight,
`forEach` fanned out over garbage — and each has a different fix, usually a
small spec edit. steamtrain has an LLM drafter for *creating* workflows but
nothing for *repairing* them.

**The feature:** `steamtrain workflow history why <runId>` (and a "Diagnose"
button on failed runs in both UIs): feed the run record — spec, rendered
prompts, step outputs/stderr/exit codes, gate evaluations, timings — to one
`llm` call that returns (a) a plain-language root cause, (b) the category
(spec bug / prompt bug / flaky agent / environment), and (c) when the fix is
a spec change, a concrete edit presented as a validated diff you can accept
into the workflow (through the existing authoring/override core, with the
existing lint pass as a guard).

**Why it matters:** it closes the author → run → fail → fix loop inside the
tool, and it's nearly free: every input it needs is already recorded, and
every output path (validate, preview, save) already exists. For newcomers
it doubles as an explainer — the postmortem teaches the workflow language by
annotating real failures.

## 10. First-class secrets and output redaction

**The gap:** steps take arbitrary `env`, agents read whatever the shell
knows, and every step's full output is persisted world-readably to
`.steamtrain/history/`, streamed to the web UI, and (with sharing/export on
the roadmap) increasingly likely to leave the machine. One agent echoing
`process.env` while debugging, and a live token is sitting in a JSON file in
the repo directory forever. Nothing in the codebase knows what a secret is.

**The feature:**
- A `secrets` block in config declaring names sourced from env or OS keychain
  (never values in JSON); steps opt in via `secrets: ["NPM_TOKEN"]`, and
  undeclared secrets never reach a step's environment.
- **Redaction at the recording boundary:** every declared secret's value is
  scrubbed (`«redacted:NPM_TOKEN»`) from step outputs, error text, history
  records, SSE streams, and exports — plus an entropy-based scanner warning
  for high-entropy strings that *look* leaked but weren't declared.
- `.steamtrain/history/` written `0600`, and a doctor check that flags
  history directories not covered by `.gitignore`.

**Why it matters:** this is the trust floor for every team-facing feature
already planned — shared web UI, run export, community workflows, CI logs.
Retrofitting redaction after a public leak incident is how tools earn a bad
reputation; shipping it early is how they earn the "safe to run at work"
label. (The readiness doc covers web *transport* security; this is data
hygiene, which nothing covers.)

---

## Sequencing sketch

- **Do first, small and compounding:** 1 (`llm` steps) and 5 (context packs)
  — both are pure engine features that every other item then builds on
  (8 and 9 want cheap judge calls; 6's starter workflows want context packs).
- **The differentiators:** 2 (steer/rewind) then 3 (human steps) then 4
  (takeover) — one arc, "the run becomes a collaboration," each step reusing
  the pause/resume plumbing of the previous.
- **The compounding tail:** 7 (memory) and 8 (eval) once recurring/scheduled
  use exists; 9 (postmortem) any time after 1; 10 (secrets) before any
  sharing/export feature ships; 6 (init/demo) before the public launch.
