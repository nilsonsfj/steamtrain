# steamtrain — feature roadmap

Date: 2026-07-02

A prioritized roadmap of next features and improvements, in three parts:

- **Part 1 — Platform & product:** ranked by perceived real-world value for
  people running workflows day to day.
- **Part 2 — Workflow engine, steps & UI:** gaps in the workflow language,
  step model, and run/authoring experience, compared against well-known
  orchestrators (GitHub Actions, Airflow/Dagster, Temporal, n8n,
  LangGraph/CrewAI) where the comparison is instructive.
- **Part 3 — Additional ideas:** a shorter grab bag worth tracking.

Context this roadmap assumes (already shipped): declarative workflows with
distributor / processor / consolidator / gate blocks, `forEach` fan-out,
loop-back gates (`loopTo` + bounded iterations), auto-retry on transient
failures, on-disk step cache + resume, run history with re-run / retry-failed,
per-step git-worktree isolation, an LLM workflow drafter, and a unified
TUI / web UI / CLI over one shared authoring core.

---

# Part 1 — Platform & product

The ranking weighs three things: does it unblock a whole class of use (not
just polish), does it protect the user's time/money/repo, and does it build on
machinery that already exists (worktrees, history, the shared authoring core)
so the cost is proportionate.

## 1.1 Worktree diff review and merge-back

**The gap:** agent steps already run in isolated git worktrees, and the step
result records the worktree path and branch — but nothing helps the user *use*
those changes. After an `implement`-style workflow succeeds, the edits are
stranded in `.git/worktrees/...`; harvesting them means manual `git diff` /
`cherry-pick` archaeology across N step worktrees.

**The feature:**
- Per-step **diff view** in the TUI, web UI, and CLI (`steamtrain workflow
  history show <id> --diff <step>`): files changed, +/- stats, full patch.
- **Apply/merge** actions: apply one step's changes to the main tree, or pick
  among competing steps' changes (natural fit for multi-agent "two
  implementations, pick the winner" workflows).
- Record applied/discarded status in run history; prune worktrees on discard.

**Why #1:** this is the last mile for every workflow that writes code — today
the tool orchestrates the work but drops the deliverable on the floor. It also
compounds the value of everything else on this list (approval gates review a
diff; CI mode posts a diff).

## 1.2 Human-in-the-loop approval gates

**The gap:** gates are purely mechanical (`contains` / `matches` / `equals` /
`ok`). Real-world workflows that spend money or mutate a repo need a "show me
what you've got before continuing" checkpoint — e.g. approve the synthesized
plan before the implement phase, or approve verified findings before a fix
phase runs.

**The feature:** a `"kind": "approval"` step (or `gate` with
`"condition": {"human": true}`) that pauses the run, surfaces the referenced
step's output (and, with 1.1, its diff), and waits: interactive prompt in the
TUI, an Approve/Reject card in the web UI, and `--approve-all` /
`--on-approval fail|stop` flags for headless CI runs. Approval decisions land
in run history; a paused run survives process exit via the existing cache/rerun
machinery (resume = re-run, cached steps replay, gate re-asks).

**Why it matters:** it converts steamtrain from "fire and hope" into something
people trust with larger, more expensive, more destructive workflows — the
whole point of a workflow orchestrator.

## 1.3 Structured step outputs (typed data flow)

**The gap:** every step's output is a text blob; agent-backed distributors
split on lines; gates can only substring/regex the text. That makes multi-step
data flow brittle — a reviewer step that emits "no P0 issues found, but P0
handling looks odd" trips a `contains: "P0"` gate.

**The feature:**
- Optional per-step `output` JSON schema; the agent is prompted to emit JSON
  matching it, and the engine parses/validates (with one bounded "fix your
  JSON" retry).
- Template access to fields: `{{steps.review.json.verdict}}`,
  `{{steps.split.json.targets[2]}}`.
- Gate conditions on fields: `{ "step": "review", "path": "verdict",
  "equals": "pass" }`.
- Distributors can fan out over a JSON array instead of line-splitting.

**Why it matters:** every non-trivial workflow eventually needs a reliable
verdict/list/score to route on. This turns gates and loops from heuristics into
contracts, and it's the foundation for honest CI pass/fail (1.4).

## 1.4 CI / headless integration (GitHub Action + machine-readable results)

**The gap:** headless runs print a nice status summary, but there's no
first-class CI story: no exit-code contract documented for gate outcomes, no
artifact a pipeline can consume, no turnkey way to run `bug-hunt` on every PR.

**The feature:**
- A published **GitHub Action** (`steamtrain/run-workflow@v1`): checkout, run a
  named workflow with the PR diff/description as input, post the consolidated
  report as a PR comment or check run.
- `--report json|markdown|junit --output <file>` on `workflow run`, plus a
  documented exit-code contract (0 = success, distinct codes for gate-fail vs.
  step-fail vs. timeout).
- Doctor support for non-interactive auth environments (API-key mode) with
  clear failure messages.

**Why it matters:** CI is where workflows run *repeatedly* — it's the highest-
leverage distribution channel for the whole tool, and `bug-hunt`-on-every-PR is
the demo that sells itself.

## 1.5 Cost budgets and cost analytics

**The gap:** steamtrain already tracks per-step and per-run cost, but only
*reports* it after the fact. A fan-out with `forEach` over 30 items on an Opus
model, inside a loop-back gate, can quietly burn real money.

**The feature:**
- `maxCostUsd` at workflow and step level: the engine stops scheduling new
  steps when the budget is hit (existing steps finish; run is marked
  `budget-exceeded`, resumable after raising the cap — the cache makes this
  cheap).
- A live cost ticker in the TUI status bar / web header during a run.
- `steamtrain workflow costs`: aggregate spend from history by workflow, step,
  agent, and model — "which step is eating the budget?"

**Why it matters:** cost anxiety is the #1 practical brake on running big
parallel workflows. A hard cap plus visibility removes the fear that keeps
`maxConcurrency` at 2.

## 1.6 Per-step tool permissions and sandbox profiles

**The gap:** every agent step runs with whatever the underlying CLI allows by
default. A "review" step has the same write powers as an "implement" step;
`extraArgs` lets a determined user hand-craft `--allowedTools`, but nothing in
the spec expresses intent, and nothing is enforced across agents.

**The feature:** a per-step `permissions` field with cross-agent profiles —
`read-only`, `edit`, `full` — mapped by each adapter to the native flags
(Claude Code: `--allowedTools`/`--permission-mode`; OpenCode equivalents),
plus explicit allow/deny lists for power users. Bundled workflows adopt it
(review/critique steps become read-only). Doctor warns when an agent can't
honor a requested profile.

**Why it matters:** it's the difference between "I'll run this workflow on a
scratch clone" and "I'll run this on my actual repo." Worktree isolation
protects the tree; this protects everything else (shell, network, files
outside the repo).

## 1.7 Detached runs and a run queue (reattach from any UI)

**The gap:** a run is tied to the TUI/web session that started it. Long
workflows (15-minute step timeouts × phases) hold a terminal hostage; closing
the laptop lid kills the run; you can't kick off two workflows and check back.

**The feature:**
- `steamtrain workflow run … --detach` → runs under a lightweight daemon (or
  double-forked process) that keeps writing events to the existing history
  store.
- `steamtrain workflow attach <runId>` and TUI `/attach` replay the record so
  far, then tail live events; the web UI lists in-flight runs alongside
  history.
- A simple queue: runs beyond a concurrency limit wait rather than colliding
  over the cache/worktrees.

**Why it matters:** real workflows are long. Fire-and-return is how people
actually want to use an orchestrator, and the history store + shared reducer
mean 80% of the machinery (persist events, fold them into a view) already
exists.

## 1.8 Notifications on run completion / approval needed

**The gap:** once runs are long (and especially once they're detached, 1.7, or
waiting on a human, 1.2), the user needs to be pinged rather than poll a
terminal.

**The feature:** a `notify` config block — terminal bell + OS desktop
notification out of the box, plus a generic webhook (covers Slack/Discord/
ntfy without bespoke integrations) — fired on run completion, failure,
budget-exceeded, and approval-pending, with workflow name, status line, total
cost, and a deep link to the web-UI run page.

**Why it matters:** small feature, outsized quality-of-life. It's also the
glue that makes 1.2 and 1.7 usable rather than just possible.

## 1.9 Workflow sharing: import/export and a community catalog

**The gap:** workflows live in `steamtrain.json` (project) or the user layer;
the only way to share one is copy-paste JSON. The bundled catalog (4 workflows)
is the entire out-of-box library.

**The feature:**
- `steamtrain workflow export <name>` → a single self-describing file;
  `steamtrain workflow import <path|url>` → validate (schema + template refs +
  a doctor check that required agents/models exist), preview, then save to a
  chosen scope. Prompt-injection warning surface on import: show every prompt
  before saving.
- A `community-workflows` repo/registry with `steamtrain workflow search`.

**Why it matters:** the workflow language is the product; a library of proven
recipes (release checklist, dependency-upgrade sweep, incident postmortem,
docs audit) is what makes new users productive in minutes instead of an
authoring session. Ecosystem features also compound over time.

## 1.10 Web UI hardening for shared/remote use

**The gap:** the web server binds happily to `0.0.0.0` with no authentication;
anyone who can reach the port can run agents *with the host user's
credentials and repo write access*. The public-release readiness review
already flagged the security posture.

**The feature:** a bearer token by default (printed/QR'd at startup, embedded
in the launch URL), an explicit `--insecure-no-auth` opt-out for localhost,
CSRF protection on mutating endpoints, and docs for putting it behind a
reverse proxy with TLS. Optional read-only mode for sharing a run view with
teammates.

**Why it matters:** the web UI is the natural team surface (watch a run,
approve a gate from your phone), but it can't be recommended beyond
`127.0.0.1` until this lands — and it's a prerequisite for 1.7/1.8 deep links
being safe to share.

---

# Part 2 — Workflow engine, steps & UI

Gaps in the workflow language and run experience specifically, with
comparisons to established orchestrators. Roughly ranked; the first three are
the ones users will hit within their first week of writing real workflows.

## 2.1 Deterministic command steps (`kind: "command"`)

**The gap:** every executable step is an agent run. There is no way to express
"run the test suite", "run the linter", or "grep for TODOs" as a cheap,
deterministic step — today you must ask an LLM to run the command for you,
which costs money, takes seconds-to-minutes, and can misreport results.

**The feature:** a `command` step kind: `cmd` + optional `cwd`/`env`/
`timeoutSec`, capturing stdout/stderr as `{{steps.x.output}}` and exposing
`{{steps.x.exitCode}}` / `ok` for gates. Runs inside the same worktree
machinery as agent steps. Bundled workflows adopt it — `review-loop` gates on
`npm test` actually passing instead of an agent claiming "DONE".

**Comparison:** this is the bread and butter of every orchestrator — GitHub
Actions' `run:`, Airflow's `BashOperator`, n8n's Execute Command node.
steamtrain is unusual in *not* having it, and it's the single cheapest way to
make workflows trustworthy: let deterministic tools verify what
non-deterministic agents produce.

## 2.2 File/artifact handoff between steps

**The gap:** the only thing that flows between steps is **text output**. Each
agent step gets its *own* worktree snapshotted from the original checkout's
HEAD + dirty state — so in an implement → review pipeline, the reviewer
**cannot see the implementer's edits at all**; it reviews prose about the
changes, not the changes. Loop-back fix iterations have the same blindness.

**The feature:**
- `workspace: "inherit:<stepId>"` on a step: start its worktree from a
  dependency's final worktree state instead of the original checkout, giving
  sequential steps a real shared filesystem lineage (still isolated from the
  user's tree).
- Declared **artifacts**: a step lists output paths (`"artifacts":
  ["report.md", "coverage/"]`); the engine snapshots them into the run record
  and templates can reference them (`{{steps.build.artifacts.report}}` injects
  a path the next agent can read).

**Comparison:** GitHub Actions has `upload-artifact`/`download-artifact`
between jobs precisely because isolated executors need explicit file handoff;
Temporal passes typed payloads between activities; Dagster's assets make
outputs first-class. steamtrain's worktree isolation is a strength — this
keeps it while fixing the "steps are blind to each other's work" hole, and it
pairs directly with Part 1's diff/merge-back (1.1).

## 2.3 True DAG scheduling and per-step conditions

**The gap:** phases are hard barriers — a step cannot start until *every* step
in all earlier phases finished, even when its `dependsOn` completed long ago.
A slow "web review" step blocks an unrelated "api fix" step in the next phase.
And there is no per-step `if`: conditional behavior requires contorting
workflows around gate steps with `onFalse: stop/fail`, which can only stop
*the whole run*, not skip a branch.

**The feature:**
- Schedule by `dependsOn` alone (phases stay as presentation/grouping and as
  the default dependency when `dependsOn` is omitted — existing workflows keep
  their exact behavior).
- A per-step `when` condition reusing the existing gate-condition schema
  (`{"step": "triage", "contains": "frontend"}`) so steps can be skipped
  individually, and downstream consolidators treat skipped inputs as absent
  rather than failed.

**Comparison:** GitHub Actions runs jobs the moment their `needs` are met and
gives every step an `if:`; Airflow/Dagster are pure dependency DAGs with
trigger rules; Temporal expresses conditions in code. The phase model is a
nice authoring simplification — it just shouldn't also be the scheduler's
straitjacket.

## 2.4 Named, typed workflow inputs (parameters)

**The gap:** a workflow takes exactly one anonymous text blob (`{{input}}`).
A "release checklist" workflow that needs a version, a branch, and a
dry-run flag has to parse them back out of prose — unreliable, undocumented,
and unpromptable in the UI.

**The feature:** an `inputs` map on the workflow (`{"version": {"type":
"string", "required": true}, "dryRun": {"type": "boolean", "default":
false}}`), referenced as `{{inputs.version}}`; supplied via
`--param version=1.2.0` on the CLI, a generated form in the web UI's run
modal, and sequential prompts in the TUI. `workflow validate` checks that
referenced inputs are declared. `{{input}}` remains as the single free-text
default so existing workflows are untouched.

**Comparison:** GitHub Actions' `workflow_dispatch.inputs` (typed, with
defaults and choice enums) is the model to copy; n8n generates run forms from
declared fields; Temporal workflows take typed arguments. This is also what
makes shared/imported workflows (1.9) self-documenting: the input schema *is*
the usage doc.

## 2.5 Sub-workflows and reusable step templates

**The gap:** workflows can't compose. The `bug-hunt` sweep can't be embedded
as one stage of a bigger release pipeline; a well-tuned "review step" (agent +
model + effort + prompt scaffold) must be copy-pasted between workflows and
drifts apart.

**The feature:**
- A `"kind": "workflow"` step: `"workflow": "bug-hunt"` + an input template;
  the child run renders nested in the step tree, records into the same run
  history, and its consolidated output becomes the step output. Recursion
  depth capped; the existing ≤1000-step budget applies to the expanded tree.
- Step templates: a top-level `stepDefaults`/`templates` block that named
  steps can `extends`, so shared agent/model/effort/prompt scaffolds live in
  one place.

**Comparison:** GitHub Actions has reusable workflows + composite actions;
Temporal has child workflows; Airflow has TaskGroups; CrewAI composes crews.
Composition is what lets a catalog of small, proven workflows scale into big
pipelines instead of monoliths — it multiplies the value of the community
catalog (1.9).

## 2.6 Agent session continuity across steps and loop iterations

**The gap:** every step (and every loop iteration) spawns a fresh agent with
an empty context; all "memory" must be squeezed through prompt templates. In
`review-loop`, the fix iteration re-reads the repo from scratch each time —
slower, more expensive, and it loses the reviewer's unstated context.

**The feature:** an opt-in `"session": "continue:<stepId>"` field. The Claude
adapter already captures `session_id` from `system/init`; chaining is
`claude --resume <sessionId>` with the next prompt (OpenCode has an
equivalent). Natural fits: loop-back gates resuming the *same* fixer session
each iteration, and plan → implement pairs where the implementer inherits the
planning conversation. Session ids land in run history; cache keys include
the session lineage so resume stays correct; steps without the field keep
today's clean-room behavior (which is often what you want for independent
critique).

**Comparison:** LangGraph's checkpointed threads and CrewAI/AutoGen's shared
conversation memory exist precisely because multi-step agent pipelines bleed
context otherwise. steamtrain's clean-room default is the right *default* —
but it's currently the only option, and the underlying CLIs already support
resumption.

## 2.7 Matrix fan-out and fan-out controls

**The gap:** `forEach` fans out over one distributor's items, once. There's no
way to say "run this review across {sonnet, opus, gpt-5.4} × {each target
area}" without hand-writing every combination as separate steps — which is
exactly what `bug-hunt` does today with three hard-coded per-model steps. And
a fan-out has no local controls: no per-step parallelism cap, no fail-fast,
no "tolerate N failures".

**The feature:**
- A `matrix` field on worker/processor steps (`{"model":
  ["claude-sonnet-4-6", "claude-opus-4-8"], "item": "steps.areas.items"}`)
  producing the cross-product as generated children, with `{{matrix.model}}`
  available in templates and step fields.
- Fan-out controls: `maxParallel` (per step, under the global cap),
  `failFast: true|false`, and `minSuccess` so a consolidator can proceed when
  e.g. 8/10 children succeeded instead of all-or-nothing `ok`.

**Comparison:** lifted straight from GitHub Actions' `strategy.matrix` +
`max-parallel` + `fail-fast`, which proved this is the right shape for
"same job, many variants." For an LLM orchestrator it's even more valuable:
cross-model comparison is a core multi-agent pattern, not an edge case.

## 2.8 Template validation and expressions

**The gap:** unknown placeholders are **left unchanged** — a typo like
`{{steps.reviw.output}}` ships literally to the agent as line noise, no
warning, and the run "succeeds". Beyond that, templates are pure
substitution: no way to truncate a huge output before re-prompting, no
fallback when a step was skipped, no light conditionals.

**The feature:**
- **Strict reference validation** in `validateWorkflow` and at save time in
  both UIs: any `{{steps.<id>…}}` naming an unknown id or field is an error;
  unknown *forms* warn. (Highest value-to-effort item on this list.)
- A tiny filter set — `{{steps.x.output | head:2000}}`, `| tail:50`,
  `| jsonpath:$.verdict}}` (pairs with 1.3), `| default:"(skipped)"}}` — and
  nothing more; stop well short of a programming language.

**Comparison:** GitHub Actions expressions and Airflow's Jinja show both the
value and the trap — Jinja-in-YAML gets unreadable fast. The lint half is
uncontroversial and copies what every mature system does: fail on dangling
references at *validation* time, not mid-run after three phases of paid agent
work.

## 2.9 Dry-run / plan preview with cost estimate

**The gap:** `workflow validate` checks the schema, but there's no way to see
what a run *will do* before spending money: which steps expand from the
matrix/forEach, what the rendered prompts look like with real input, what the
worst-case step count and rough cost are. Authoring iteration today means
paying for a live run per tweak.

**The feature:** `steamtrain workflow run <name> --dry-run` (and a "Preview"
button in both UIs): render the full expanded step tree with resolved
agents/models/efforts, show each step's rendered prompt (template placeholders
that depend on runtime output shown symbolically), and a cost band from
history (1.5's per-step averages for this workflow) or model list prices.
Loop gates show their iteration budget.

**Comparison:** `terraform plan` is the canonical proof that "show me before
you spend" builds trust; Airflow has `tasks render` for exactly this
prompt-inspection purpose; GitHub Actions' lack of a good local dry-run (hence
the third-party `act`) is one of its most-complained-about gaps — an
opportunity to do better, and cheap since validation + templating + the
reducer already exist.

## 2.10 Run-inspection and authoring UX upgrades

**The gap:** a bundle of smaller UI gaps that together cap how deeply users
can work with runs:

- Step output is a streamed tail; there's no **search** across a run's
  outputs, no **export** ("give me this run as one markdown transcript"), no
  copy-step-output shortcut in the TUI.
- Token counts aren't surfaced (only duration + cost), so there's no signal
  when a step is nearing context limits — the usual silent killer of long
  consolidator steps.
- The web UI has the vertical pipeline; the TUI has no compact **graph/tree
  overview** of phase → step topology before running.
- Prompt history/drafts exist in the TUI only (the one remaining parity gap
  in the unification doc).
- Authoring is JSON-or-LLM; a middle tier — a form-based step editor in the
  web UI (add phase, add step, pick kind/agent/model from the existing meta
  view-model) — would cover the "I just want to tweak one step" case without
  round-tripping through an LLM draft.

**Comparison:** n8n's execution inspector and visual editor set user
expectations for workflow tools with a web UI; LangSmith/Langfuse traces do
the same for token-level inspection of LLM pipelines. None of these need new
engine work — they're views over data steamtrain already records.

---

# Part 3 — Additional ideas

Shorter list, less rigorously ranked — worth tracking, not necessarily next:

- **Scheduled runs:** `steamtrain workflow schedule <name> --cron "0 7 * * 1"`
  for recurring jobs (dependency-upgrade sweep, weekly docs audit) — natural
  once detached runs (1.7) exist; compare Airflow's scheduler and GitHub
  Actions `on: schedule`.
- **Workflow testing framework:** a mock-agent mode (scripted step outputs
  from fixtures) so workflow authors can unit-test routing — gates, loops,
  `forEach` — without spending tokens; snapshot-test rendered prompts. The
  engine already supports agentless smoke runs; this generalizes it.
- **Model failover:** per-step `fallbackModel` (or agent-level chains) so a
  provider outage or hard rate-limit degrades to a sibling model instead of
  failing the run — complements auto-retry, which today can only re-try the
  same model.
- **MCP server mode:** `steamtrain mcp serve` exposing each workflow as an MCP
  tool, so Claude Code (or any MCP client) can *invoke* steamtrain workflows —
  inverting the current relationship and slotting steamtrain into the growing
  agent ecosystem.
- **OpenTelemetry traces:** emit one span per run/phase/step (attributes:
  agent, model, cost, tokens, cache-hit) so teams can watch workflow health in
  their existing observability stack; pairs with CI usage (1.4).
- **More agent adapters:** the adapter seam is proven (claude, opencode,
  codex, amp already in-tree) — Gemini CLI and other emerging agent CLIs widen
  the cross-model workflows that are steamtrain's signature.
- **Config schema + editor support:** publish a JSON Schema for
  `steamtrain.json` (and `$schema` support) so VS Code autocompletes and
  validates workflow definitions as users type — the cheapest possible
  authoring-UX win.

---

# Suggested sequencing

Three tracks can proceed largely in parallel:

- **Trust track (protects users):** 1.5 budgets → 1.6 permissions → 1.10 web
  hardening. Each is small-to-medium and independent.
- **Capability track (unlocks use cases):** 1.1 diff/merge → 1.2 approval
  gates → 1.3 structured outputs → 1.4 CI action, in that order — each builds
  directly on the previous one.
- **Language track (workflow authoring power):** 2.8's lint half and 2.1
  command steps first (small, high leverage), then 2.2 artifacts/worktree
  inheritance, 2.4 typed inputs, and 2.3 DAG scheduling; 2.5–2.7 and 2.9–2.10
  follow as demand dictates.

1.7 detached runs, 1.8 notifications, and 1.9 sharing slot in whenever
bandwidth allows (1.8 should land with or right after 1.2/1.7; Part 3's
scheduled runs after 1.7).
