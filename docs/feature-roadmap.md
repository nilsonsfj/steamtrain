# steamtrain — next features roadmap

Date: 2026-07-02

A prioritized list of the next features and improvements, ranked by perceived
real-world value for people actually running workflows day to day. The ranking
weighs three things: does it unblock a whole class of use (not just polish),
does it protect the user's time/money/repo, and does it build on machinery that
already exists (worktrees, history, the shared authoring core) so the cost is
proportionate.

Context this list assumes (already shipped): declarative workflows with
distributor / processor / consolidator / gate blocks, `forEach` fan-out,
loop-back gates, auto-retry on transient failures, on-disk step cache + resume,
run history with re-run / retry-failed, per-step git-worktree isolation, an LLM
workflow drafter, and a unified TUI / web UI / CLI over one shared core.

---

## 1. Worktree diff review and merge-back

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

## 2. Human-in-the-loop approval gates

**The gap:** gates are purely mechanical (`contains` / `matches` / `equals` /
`ok`). Real-world workflows that spend money or mutate a repo need a "show me
what you've got before continuing" checkpoint — e.g. approve the synthesized
plan before the implement phase, or approve verified findings before a fix
phase runs.

**The feature:** a `"kind": "approval"` step (or `gate` with
`"condition": {"human": true}`) that pauses the run, surfaces the referenced
step's output (and, with #1, its diff), and waits: interactive prompt in the
TUI, an Approve/Reject card in the web UI, and `--approve-all` /
`--on-approval fail|stop` flags for headless CI runs. Approval decisions land
in run history; a paused run survives process exit via the existing cache/rerun
machinery (resume = re-run, cached steps replay, gate re-asks).

**Why it matters:** it converts steamtrain from "fire and hope" into something
people trust with larger, more expensive, more destructive workflows — the
whole point of a workflow orchestrator.

## 3. Structured step outputs (typed data flow)

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
contracts, and it's the foundation for honest CI pass/fail (#4).

## 4. CI / headless integration (GitHub Action + machine-readable results)

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

## 5. Cost budgets and cost analytics

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

## 6. Per-step tool permissions and sandbox profiles

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

## 7. Detached runs and a run queue (reattach from any UI)

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

## 8. Notifications on run completion / approval needed

**The gap:** once runs are long (and especially once they're detached, #7, or
waiting on a human, #2), the user needs to be pinged rather than poll a
terminal.

**The feature:** a `notify` config block — terminal bell + OS desktop
notification out of the box, plus a generic webhook (covers Slack/Discord/
ntfy without bespoke integrations) — fired on run completion, failure,
budget-exceeded, and approval-pending, with workflow name, status line, total
cost, and a deep link to the web-UI run page.

**Why it matters:** small feature, outsized quality-of-life. It's also the
glue that makes #2 and #7 usable rather than just possible.

## 9. Workflow sharing: import/export and a community catalog

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

## 10. Web UI hardening for shared/remote use

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
`127.0.0.1` until this lands — and it's a prerequisite for #7/#8 deep links
being safe to share.

---

## Suggested sequencing

Two tracks can proceed in parallel:

- **Trust track (protects users):** #5 budgets → #6 permissions → #10 web
  hardening. Each is small-to-medium and independent.
- **Capability track (unlocks use cases):** #1 diff/merge → #2 approval gates
  → #3 structured outputs → #4 CI action, in that order — each builds directly
  on the previous one. #7 detached runs, #8 notifications, and #9 sharing can
  slot in whenever bandwidth allows (#8 should land with or right after #2/#7).
