# Human in the loop

steamtrain treats a workflow run as a collaboration, not a batch job. Beyond
[approval checkpoints](workflow-spec.md#approval-human-in-the-loop-checkpoint)
(shipped earlier), four capabilities put a person *inside* the run — each
usable from every surface (TUI, web UI, CLI, detached runs):

1. **[Autonomy labels](#autonomy-labels)** — know what a workflow will need
   from you *before* you launch it.
2. **[Human steps](#human-steps-kind-human)** (`kind: "human"`) — steps whose
   output a person supplies.
3. **[Agent clarifying questions](#agent-clarifying-questions-canask)**
   (`canAsk: true`) — let a blocked agent ask one question instead of guessing.
4. **[Interactive takeover](#interactive-takeover-workflow-takeover)**
   (`workflow takeover`) — drop into a recorded step's agent session by hand.

Plus the glue that makes waiting-on-a-human practical:
**[notifications](#notifications-notify)** on approval-pending /
input-pending / run completion.

---

## Autonomy labels

Workflows with and without a human in the loop are inherently different
products: one can run unattended (CI, `--detach` and walk away), the other
parks until a person shows up. Every surface that lists or previews workflows
shows an autonomy label so the cost is visible up front:

| label | meaning |
| --- | --- |
| `▸ autonomous` | Runs unattended end-to-end — no human involvement declared. |
| `✋ approvals` | Pauses at approval checkpoints — a human must approve or reject to continue. |
| `✎ interactive` | Asks a human for input mid-run — answers or choices are required to finish. |

The label is computed from the spec: `human` steps and `canAsk` agent steps ⇒
interactive; `approval` steps and gates with `condition.human` ⇒ approvals;
anything else ⇒ autonomous. Sub-workflow (`kind: "workflow"`) steps are
resolved through the catalog, so a checkpoint nested inside a child workflow
still labels the parent.

Where it shows up:

- `steamtrain workflow list` — badge on every row.
- `steamtrain workflow plan <name>` — an `autonomy:` line with the explanation.
- TUI — badge in the workflow picker and the preview header.
- Web UI — badge on every workflow card (hover for the explanation).

The headless CLI also warns at launch when a workflow is interactive and no
`--human` values were supplied.

## Human steps (`kind: "human"`)

A step whose output a *person* supplies — the data counterpart to an approval
checkpoint's consent. Full field reference:
[workflow-spec.md → Human](workflow-spec.md#human-human-in-the-loop-data-step).

```jsonc
{
  "id": "design-choice",
  "kind": "human",
  "dependsOn": ["propose"],
  "prompt": "Which proposed design should be implemented?\n{{steps.propose.output}}",
  "choices": ["conservative", "balanced", "aggressive"]
}
```

Answering, per surface:

- **TUI** — the run shows a magenta "✎ input needed" card; press `a` to open
  the answer box. Number keys (1–9) pick a choice instantly; free text submits
  on Enter; Esc closes the box without answering (the run keeps waiting).
- **Web UI** — an inline answer form on the step card: choice buttons, a JSON
  editor (with a local parse check) for `output`-schema steps, a textarea
  otherwise. `POST /api/runs/:id/input` with `{ stepId, value, iteration? }`.
- **Headless CLI** — pre-supply answers:

  ```bash
  steamtrain workflow run incident-review --input "outage 42" \
    --human timeline=@timeline.txt --human severity=high
  ```

  `@file` reads the value from a file. A step with no supplied value fails
  fast with guidance (CI never hangs).
- **Detached runs** — the runner parks until any attached UI answers:

  ```bash
  steamtrain workflow answer <runId>                     # show what is being asked
  steamtrain workflow answer <runId> --step timeline --file timeline.txt
  ```

  Pending inputs are visible in `workflow runs` (`✎ input: <step>`), in
  `workflow attach` output, in the TUI run browser, and in the web Active runs
  panel.

Validation is engine-side and consistent everywhere: a wrong choice or a
schema-mismatched JSON reply is re-asked (up to 3 attempts) with the error
shown; answers are attempt-scoped in the shared run registry so a stale bad
answer can never satisfy a re-ask. Accepted answers are cached — a resumed run
replays them rather than re-asking — and recorded in run history along with
who answered.

## Agent clarifying questions (`canAsk`)

The best answer to "the agent guessed wrong" is often "let it ask." Setting
`canAsk: true` on a worker/processor step tells the agent (via a protocol line
appended to its prompt) that it may end its reply with one final line:

```text
QUESTION: <the one question it is blocked on>
```

When it does, the engine pauses the step, surfaces the question through the
**same human-input channel** as `human` steps (TUI answer box, web form,
`--human <stepId>=<answer>` headless, `workflow answer` for detached runs),
then continues the agent with the answer:

- **Session resume** where the CLI supports it (claude:
  `--resume <sessionId>`): the agent keeps every bit of context it built up
  and receives only the answer.
- **Composed prompt** otherwise: the step re-runs with the original prompt
  plus the question and answer appended — self-contained, works for every
  adapter.

Bounded to **one question per step**: a continuation that asks again fails the
step with guidance (split the step, or enrich its prompt/context). The
exchange is recorded on the step result (`questions`) and shown in step
detail views; costs and tokens of both turns are summed into the step.

```jsonc
{
  "id": "implement",
  "agent": "claude",
  "model": "claude-sonnet-5",
  "prompt": "Implement the fix described in: {{input}}",
  "canAsk": true
}
```

Reserve `canAsk` for steps whose input is likely ambiguous — it marks the
workflow ✎ interactive, and an unanswered question fails the step in
headless runs (supply `--human implement="<answer>"` or use `--detach`).

## Interactive takeover (`workflow takeover`)

A step gets 90% of the way there and stalls, or a finished run needs a nudge.
Instead of re-prompting through another step or abandoning the orchestrator
for a fresh contextless session:

```bash
steamtrain workflow takeover <runId> <stepId>
```

launches the step's agent CLI **interactively** inside the step's still-live
git worktree, resuming the step's recorded session where the provider
supports it (claude: `--resume <sessionId>`; other providers start a fresh
interactive session in the same worktree, clearly noted). You finish the job
by hand with the agent's full context.

On exit:

- the takeover is recorded in run history as an intervention (who, when,
  which session, exit code), so a taken-over run stays an auditable record;
- the worktree's final state flows into the existing harvest machinery —
  `workflow history show <runId> --diff` shows exactly what you left behind,
  and `workflow history apply <runId>` lands it.

Takeover targets **recorded** (finished) runs; a live run's steps are still
owned by the engine — cancel it or let it settle first. It needs the step's
worktree to still exist (don't `history prune` first) and works best when a
session id was recorded (agent steps record theirs automatically). The
TUI step detail and the web step drawer surface the ready-to-copy takeover
command on any eligible step.

## Notifications (`notify`)

Once runs are long, detached, or waiting on a human, you want to be pinged
rather than poll a terminal. Add a `notify` block to `steamtrain.json` (or
`~/.steamtrain/config.json`):

```jsonc
{
  "notify": {
    "bell": true,                          // terminal bell (BEL to stderr)
    "desktop": true,                       // notify-send (Linux) / osascript (macOS)
    "webhook": "https://ntfy.sh/my-runs",  // POST a JSON payload per event
    "events": ["approval-pending", "input-pending", "run-failed"]  // omit ⇒ all
  }
}
```

Events: `run-completed`, `run-failed`, `budget-exceeded`, `approval-pending`,
`input-pending`. Each notification carries the workflow name, run id, a
one-line status (with total cost on terminal events), and — for web-hosted
runs — a deep link to the run page. The webhook body is the same JSON shape,
so Slack/Discord/ntfy glue needs no bespoke integration.

Notifications are strictly best-effort and fire-and-forget: a failed channel
never slows or breaks a run. Only the process that *owns* a run notifies
(CLI runner, TUI, web server) — attached viewers stay quiet, so one event
never pings twice. A re-asked input (rejected answer) does not re-ping: the
first ask proved you're present.

## See also

- [workflow-spec.md](workflow-spec.md) — full step-kind reference
  (approval, human, gate `condition.human`).
- [detached-runs.md](detached-runs.md) — the run registry that carries
  cross-process answers and approvals.
- [mid-run-steering.md](mid-run-steering.md) — pause / edit pending steps /
  resume, the other half of "the run as a collaboration".
- [worktree-merge-back.md](worktree-merge-back.md) — how takeover edits land.
