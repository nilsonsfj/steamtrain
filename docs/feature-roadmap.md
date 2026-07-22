# steamtrain — feature roadmap

Date: 2026-07-15 (pending-work refresh)

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
TUI / web UI / CLI over one shared authoring core — plus worktree diff
review and merge-back (merge step kind, `history apply/prune`, `--diff`),
worktree lifecycle closure (`cleanup: true`, `workflow worktrees` GC, harvest
actions in both UIs — see [`worktree-lifecycle.md`](worktree-lifecycle.md)),
human-in-the-loop approval gates (`approval` step kind, `gate` with
`human` condition, `--approve-all`/`--on-approval`), structured step
outputs (per-step JSON schemas, `json.<path>` templates, gate `path`
conditions), `command` step kind, workspace inheritance and artifacts,
true DAG scheduling with per-step `when` conditions, typed workflow
inputs, sub-workflows (`kind: "workflow"` step), template reference
linting (`lintTemplateRefs`), dry-run/plan preview (`planWorkflow`),
cost budgets (`maxCostUsd`), per-step cost/token tracking, cost analytics
CLI, live cost/token ticker in the TUI status bar and web header,
mid-run steering (pause / edit pending steps / resume — see
[`mid-run-steering.md`](mid-run-steering.md)), and web UI security
hardening (`--auth-token`, cookie session auth, CSRF validation, login
rate limiting, `--no-auth` opt-out, reverse-proxy guidance — see
[`web-ui.md`](web-ui.md)).

---

# Part 1 — Platform & product

The ranking weighs three things: does it unblock a whole class of use (not
just polish), does it protect the user's time/money/repo, and does it build on
machinery that already exists (worktrees, history, the shared authoring core)
so the cost is proportionate.

## 1.1 Graphical diff panels in TUI/web UI

> Partially shipped. Per-step **diffstat** and worktree harvest actions are in
> both UIs via `GET /api/history/:id/worktrees` (web "Worktree changes" section;
> TUI history detail). CLI `history show --diff` and `workflow history apply`
> remain the full-patch surfaces. See [`worktree-lifecycle.md`](worktree-lifecycle.md)
> and [`worktree-merge-back.md`](worktree-merge-back.md).

**What remains:**
- Graphical **full patch** panes in the TUI and web UI — +/- stats are there;
  inline unified diffs consuming the same data as `history show --diff` are not.

## 1.2 CI / headless integration (GitHub Action + machine-readable results)

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

## 1.3 Per-step tool permissions and sandbox profiles

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

## 1.4 Detached runs and a run queue (reattach from any UI)

> Shipped — see [`detached-runs.md`](detached-runs.md). `workflow run
> --detach` runs under a background process; `workflow
> attach/runs/cancel/approve`, TUI `/attach` + the run browser, and the web
> UI's Active runs panel all attach/cancel/approve any process's runs through
> the shared `.steamtrain/runs/` registry; `maxParallelRuns` queues excess
> runs across processes.

**Follow-up shipped:** detaching an *already-started* TUI/web run into a
background process — TUI `d`, web **Detach**, `POST /api/runs/:id/detach`. The
run quiesces (in-flight steps finish and cache), then hands off under the same
id and keeps running after the UI closes. See
[`detached-runs.md`](detached-runs.md#detaching-a-running-run).

## 1.5 Notifications on run completion / approval needed

**The gap:** once runs are long (and especially once they're detached, 1.4, or
waiting on a human), the user needs to be pinged rather than poll a terminal.

**The feature:** a `notify` config block — terminal bell + OS desktop
notification out of the box, plus a generic webhook (covers Slack/Discord/
ntfy without bespoke integrations) — fired on run completion, failure,
budget-exceeded, and approval-pending, with workflow name, status line, total
cost, and a deep link to the web-UI run page.

**Why it matters:** small feature, outsized quality-of-life. It's also the
glue that makes approval gates and detached runs usable rather than just
possible.

> **Shipped:** the `notify` config block — `bell` (terminal BEL), `desktop`
> (`notify-send` / `osascript`), `webhook` (JSON POST), with an `events`
> allowlist over run-completed / run-failed / budget-exceeded /
> approval-pending / input-pending. Fired by whichever process owns the run
> (CLI, TUI, web server; web notifications deep-link to the run page), never
> by attached viewers. See
> [`human-in-the-loop.md`](human-in-the-loop.md#notifications-notify).

## 1.6 Workflow sharing: import/export and a community catalog

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

## 1.7 Web UI follow-ups

> Core auth/CSRF hardening shipped (PR #82): `--auth-token`, cookie-based
> session auth, Origin/Referer CSRF validation, login form, localhost bind
> without auth, `--no-auth` opt-out for trusted networks, login rate limiting,
> reverse-proxy + `--trust-proxy` guidance in [`web-ui.md`](web-ui.md).
>
> **Shipped:** read-only / share mode — `--read-token` /
> `STEAMTRAIN_READ_TOKEN` mints viewer sessions (GET + logout only; every other
> write returns `403`); `--read-only` forces every session (and the no-auth
> localhost path) into viewer capability; `GET /api/session` and the login
> response expose `capability` so the SPA hides Run / authoring / harvest /
> approval / input controls. See [`web-ui.md`](web-ui.md#scope--security).

**Remaining follow-ups:**

- Session expiry mid-run has no auto-re-login flow — the user must start a new run

---

# Part 2 — Workflow engine, steps & UI

Gaps in the workflow language and run experience specifically, with
comparisons to established orchestrators. Roughly ranked; the first three are
the ones users will hit within their first week of writing real workflows.

## 2.1 Agent session continuity across steps and loop iterations

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

> **Shipped:** `"session": "continue:<stepId>"` on worker/processor steps
> (including the self form for loop fixers), with adapter resume for
> claude/opencode/codex, session ids + lineage (`resumedSessionId`) in run
> history and the step cache, and lineage-checked cache replay. See
> [Session continuity](workflow-spec.md#session-continuity-session).

**Comparison:** LangGraph's checkpointed threads and CrewAI/AutoGen's shared
conversation memory exist precisely because multi-step agent pipelines bleed
context otherwise. steamtrain's clean-room default is the right *default* —
but it's currently the only option, and the underlying CLIs already support
resumption.

## 2.2 Matrix fan-out and fan-out controls

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

## 2.3 Template expressions and filters

> Template reference linting (`lintTemplateRefs`) shipped — unknown refs,
> undeclared inputs, wrong-context `{{item}}`/`{{iteration}}` all produce
> validation warnings. What remains is the filter/expression layer.

**The feature:**
- A tiny filter set — `{{steps.x.output | head:2000}}`, `| tail:50`,
  `| jsonpath:$.verdict}}`, `| default:"(skipped)"}}` — and nothing more;
  stop well short of a programming language. Truncation before re-prompting,
  fallback when a step was skipped, light conditionals.

**Comparison:** GitHub Actions expressions and Airflow's Jinja show both the
value and the trap — Jinja-in-YAML gets unreadable fast. The lint half is
already shipped and uncontroversial; the filters are the follow-up that pairs
with structured outputs.

## 2.4 Reusable step templates (`stepDefaults`/`extends`)

> Sub-workflows (`kind: "workflow"` step) shipped — child workflows compose,
> render nested in the step tree, and record into run history. What remains
> is the authoring-sugar half.

**The feature:**
- A top-level `stepDefaults`/`templates` block that named steps can
  `extends`, so shared agent/model/effort/prompt scaffolds live in
  one place and don't drift between workflows.

**Comparison:** GitHub Actions has composite actions for exactly this —
shared configuration that multiple steps or workflows reference. This
multiplies the value of the community catalog (1.6).

## 2.5 Run-inspection and authoring UX upgrades

**The gap:** a bundle of smaller UI gaps that together cap how deeply users
can work with runs:

- Step output is a streamed tail; there's no **search** across a run's
  outputs, no **export** ("give me this run as one markdown transcript"). The
  web step drawer has one-click **copy**; the TUI has no copy-step-output
  shortcut yet.
- Token counts are surfaced in the TUI header and per-step details, but
  there's no signal when a step is nearing context limits — the usual silent
  killer of long consolidator steps.
- The web UI has the vertical pipeline; the TUI has a workflow **preview**
  (phase → step list) but no compact graph/tree topology view.
- Prompt history is in both UIs (TUI per-mode history; web localStorage-backed
  ↑/↓ on the run input). Per-mode unsent drafts remain TUI-stronger (web
  restores the draft only while browsing history).
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
  once detached runs (1.4) exist; compare Airflow's scheduler and GitHub
  Actions `on: schedule`.
- **Workflow testing framework:** a mock-agent mode (scripted step outputs
  from fixtures) so workflow authors can unit-test routing — gates, loops,
  `forEach` — without spending tokens; snapshot-test rendered prompts. The
  engine already supports agentless smoke runs; this generalizes it.
- **Model failover:** per-step / workflow / config `fallbackModels` plus
  configurable `modelFailover` so provider outages, hard rate-limits, and
  **quota / billing exhaustion** re-route mid-flight to a sibling agent/model
  instead of failing the run — see [`model-binding.md`](model-binding.md).
  Complements auto-retry, which walks the same failover chain between attempts.
- **MCP server mode:** `steamtrain mcp serve` exposing each workflow as an MCP
  tool, so Claude Code (or any MCP client) can *invoke* steamtrain workflows —
  inverting the current relationship and slotting steamtrain into the growing
  agent ecosystem.
- **OpenTelemetry traces:** emit one span per run/phase/step (attributes:
  agent, model, cost, tokens, cache-hit) so teams can watch workflow health in
  their existing observability stack; pairs with CI usage (1.2).
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

- **Trust track (protects users):** 1.3 permissions → 1.7 web follow-ups.
  Each is small-to-medium and independent.
- **Capability track (unlocks use cases):** 1.1 full graphical diffs → 1.2 CI
  action — builds directly on the shipped merge/diff machinery.
- **Language track (workflow authoring power):** 2.3 template filters and 2.4
  step templates first (small, high leverage), then 2.1 session continuity
  and 2.2 matrix fan-out; 2.5 run-inspection UX follows as demand dictates.

1.4 detached runs, 1.5 notifications, and 1.6 sharing slot in whenever
bandwidth allows (1.5 should land with or right after 1.4; Part 3's
scheduled runs after 1.4).
