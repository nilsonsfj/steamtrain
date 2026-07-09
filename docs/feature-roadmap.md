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
TUI / web UI / CLI over one shared authoring core — plus worktree diff
review and merge-back (merge step kind, `history apply/prune`, `--diff`),
human-in-the-loop approval gates (`approval` step kind, `gate` with
`human` condition, `--approve-all`/`--on-approval`), structured step
outputs (per-step JSON schemas, `json.<path>` templates, gate `path`
conditions), `command` step kind, workspace inheritance and artifacts,
true DAG scheduling with per-step `when` conditions, typed workflow
inputs, sub-workflows (`kind: "workflow"` step), template reference
linting (`lintTemplateRefs`), dry-run/plan preview (`planWorkflow`),
cost budgets (`maxCostUsd`), per-step cost/token tracking, cost analytics
CLI, and web UI hardening (`--auth-token`, CSRF, login form).

---

# Part 1 — Platform & product

The ranking weighs three things: does it unblock a whole class of use (not
just polish), does it protect the user's time/money/repo, and does it build on
machinery that already exists (worktrees, history, the shared authoring core)
so the cost is proportionate.

## 1.1 Graphical diff panels in TUI/web UI

> Core merge/diff/apply/prune machinery shipped — see
> [`worktree-merge-back.md`](worktree-merge-back.md). The diff primitives are
> UI-agnostic and ready; what remains is the visual layer.

**The feature:**
- Graphical diff panels in the TUI and web UI showing per-step file changes,
  +/- stats, and full patches — consuming the same diff data the CLI's
  `--diff` flag already produces.

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

## 1.3 Cost analytics UI (live ticker)

> Core budget enforcement and cost analytics CLI shipped — see
> [cost-and-budgets.md](./cost-and-budgets.md). Per-step and per-run cost
> data flows through events.

**The feature:**
- A live cost **and token** ticker widget in the TUI status bar / web UI
  header during a run, with a per-model breakdown line — consuming the cost
  data that already flows through events but currently only renders
  per-event rather than as a persistent running total.

## 1.4 Per-step tool permissions and sandbox profiles

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

## 1.5 Detached runs and a run queue (reattach from any UI)

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

## 1.6 Notifications on run completion / approval needed

**The gap:** once runs are long (and especially once they're detached, 1.5, or
waiting on a human), the user needs to be pinged rather than poll a terminal.

**The feature:** a `notify` config block — terminal bell + OS desktop
notification out of the box, plus a generic webhook (covers Slack/Discord/
ntfy without bespoke integrations) — fired on run completion, failure,
budget-exceeded, and approval-pending, with workflow name, status line, total
cost, and a deep link to the web-UI run page.

**Why it matters:** small feature, outsized quality-of-life. It's also the
glue that makes approval gates and detached runs usable rather than just
possible.

## 1.7 Workflow sharing: import/export and a community catalog

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

## 1.8 Web UI follow-ups

> Core auth/CSRF hardening shipped (`--auth-token`, cookie-based session auth,
> Origin/Referer CSRF validation, login form, public route bypass). Remaining
> follow-ups:

- `--insecure-no-auth` opt-out for localhost (suppress the login form on 127.0.0.1)
- Reverse-proxy + TLS docs for remote deployment
- Read-only mode for sharing a run view with teammates
- Basic rate limiting on `POST /api/auth` (or document that the token should be high-entropy for shared deployments)
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
with structured outputs (1.3 in the original numbering).

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
multiplies the value of the community catalog (1.7).

## 2.5 Run-inspection and authoring UX upgrades

**The gap:** a bundle of smaller UI gaps that together cap how deeply users
can work with runs:

- Step output is a streamed tail; there's no **search** across a run's
  outputs, no **export** ("give me this run as one markdown transcript"), no
  copy-step-output shortcut in the TUI.
- Token counts are surfaced in the TUI header and per-step details, but
  there's no signal when a step is nearing context limits — the usual silent
  killer of long consolidator steps.
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
  once detached runs (1.5) exist; compare Airflow's scheduler and GitHub
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

- **Trust track (protects users):** 1.3 cost ticker → 1.4 permissions → 1.8
  web follow-ups. Each is small-to-medium and independent.
- **Capability track (unlocks use cases):** 1.1 graphical diffs → 1.2 CI
  action — builds directly on the shipped merge/diff machinery.
- **Language track (workflow authoring power):** 2.3 template filters and 2.4
  step templates first (small, high leverage), then 2.1 session continuity
  and 2.2 matrix fan-out; 2.5 run-inspection UX follows as demand dictates.

1.5 detached runs, 1.6 notifications, and 1.7 sharing slot in whenever
bandwidth allows (1.6 should land with or right after 1.5; Part 3's
scheduled runs after 1.5).
