# Detached runs & the run queue

Date: 2026-07-09 (roadmap item 1.5)

Long workflows used to hold a terminal hostage: a run was tied to the TUI/web
session that started it, closing the laptop lid killed it, and two concurrent
runs could collide over the step cache and git worktrees. This feature makes
runs first-class background citizens:

- **Detached runs** — `steamtrain workflow run … --detach` executes under a
  background process that survives the launching terminal.
- **Attach from any UI** — the CLI (`workflow attach`), the TUI (`/attach`,
  the run browser), and the web UI (the *Active runs* sidebar) can all replay
  an in-flight run's record so far and then tail it live — regardless of which
  UI started it.
- **A shared run queue** — at most `maxParallelRuns` workflows execute at
  once across *all* processes in a project; excess runs wait instead of
  colliding.
- **Cross-process cancel & approvals** — `workflow cancel <id>` stops a run
  owned by any process, and a human-approval checkpoint on a detached run can
  be decided from the CLI, TUI, or web.
- **Cross-process steering** — `workflow pause|resume|edit-step` steer a run
  owned by any process through the same registry (see
  [`mid-run-steering.md`](mid-run-steering.md)).

## The live-run registry

Everything is built on one shared, file-based registry under
`.steamtrain/runs/<runId>/` (sibling to the step cache and run history):

```
meta.json         status (queued|running|done|error|canceled|budget-exceeded),
                  owning pid, source (cli|cli-detached|tui|web), launch args,
                  pending approval checkpoints
events.ndjson     every WorkflowEvent, one JSON line each (append-only)
cancel            marker file — any process drops it; the owner polls & aborts
approvals/*.json  human-approval decisions written by any attached UI
control/          mid-run steering: pause.json (desired pause state) and
                  edits/*.json (step-edit requests + owner verdicts)
runner.log        stdout/stderr of a detached runner (debugging)
```

**Every** driver — foreground CLI, detached runner, TUI, web server —
registers its runs here and mirrors its event stream into `events.ndjson`, so
attach/cancel/approve work uniformly no matter where a run started. Only the
owning process writes a run's meta/events; other processes read (attach) or
drop marker files (cancel, approval decisions), so no cross-process locking is
needed.

Hygiene is cooperative: every listing sweeps the registry, deleting finished
entries older than ~15 minutes and marking dead-owner entries (`kill -9`,
crash, reboot) as errored — folding whatever events they recorded into run
history so the run doesn't vanish. Stream chatter (`step_event` text deltas)
is capped at 20k lines per run; lifecycle events are always recorded.

## CLI

```bash
# Fire and return: the run continues under a background process.
steamtrain workflow run bug-hunt --input "audit the parser" --detach

steamtrain workflow runs                # in-flight runs (--all: recently finished too)
steamtrain workflow attach <runId>      # replay + live tail; Ctrl+C detaches
steamtrain workflow cancel <runId>      # works on runs owned by any process
steamtrain workflow approve <runId> [--step <id>] [--reject [--on-reject fail|stop]] [--note <text>]
```

- `--detach` composes with everything `run` supports: `--param`, `--fresh`,
  `--stdin`, `--from <runId> [--retry-failed]`, `--approve-all` /
  `--on-approval`. The parent validates the workflow, runs the doctor
  preflight, and prepares the cache (fresh / retry seeds) *before* spawning,
  so misconfigurations fail fast in your terminal.
- `workflow attach` exits with the run's status code (0 done, 1 failed,
  130 canceled); detaching with Ctrl+C exits 0 and leaves the run going.
- Foreground runs participate too: they appear in `workflow runs`, can be
  canceled from another terminal, and wait in the queue when slots are busy
  (a `queued: position N` line is printed while waiting).

## Approvals on detached runs

A detached run that reaches a human-approval checkpoint **parks and waits**
(there is no terminal to ask) unless the launch passed `--approve-all` or
`--on-approval fail|stop`. While parked:

- `workflow runs` shows a `⏳ approval: <stepId>` badge;
- `workflow approve <runId>` decides it from the CLI;
- attaching from the TUI (`a`/`r` keys) or the web UI (Approve/Reject buttons)
  decides it interactively;
- `workflow cancel <runId>` unblocks it as canceled.

Decisions are written as files in `approvals/`; the runner polls them. The
same mechanism is layered onto TUI- and web-owned runs (their local
interactive prompt races the decision file — first decision wins), so an
approval can be granted from any surface for any run.

## TUI

- `/attach [runId]` attaches to an in-flight run (no id: the single active run,
  or a disambiguation list). Unambiguous id prefixes are accepted.
- The run browser (`Ctrl+J`, `/runs`, `/history`) lists in-flight runs above
  recorded history; `Enter` on one attaches.
- While attached, `Ctrl+Q` **detaches** (the run keeps going);
  `/cancel-run [runId]` cancels the attached (or named) run.
- TUI-started runs are mirrored to the registry and honor the queue — the
  notice line shows `queued — position N` while waiting.

## Web UI

- An **Active runs** sidebar panel lists every queued/running run in the
  project (web-, CLI-, or TUI-owned) with queued/detached/approval badges;
  clicking one attaches: the pipeline view replays the record and tails live.
- Cancel and Approve/Reject buttons work on attached external runs (the server
  falls back to the registry's marker/decision files).
- `GET /api/runs` returns the merged registry;
  `GET /api/runs/:id/stream` tails externally-owned runs over SSE; a
  non-terminal `{"type":"queued","position":…}` frame reports queue waits.

## The queue (`maxParallelRuns`)

```jsonc
// steamtrain.json (project) or ~/.steamtrain/config.json (user)
{ "maxParallelRuns": 2 }
```

- Default **2**, ceiling 16. Counts whole runs, across processes — distinct
  from `maxConcurrency`, which caps parallel *steps inside* one run.
- Coordination is cooperative and deterministic: waiters sort queued entries
  by arrival time (id tiebreak) and promote themselves only when their
  position fits the free slots, so every process computes the same order.
  Dead entries (crashed owners) are ignored after a short grace period. This
  is a best-effort local-machine queue, not a distributed lock.
- The whole-workflow wall-clock timeout starts when a run *leaves* the queue,
  so waiting never eats the execution budget.

## Design notes & edge cases covered

- **Torn writes:** events are parsed per complete line; a crash mid-append
  leaves at most one unparseable line, which tailers skip. Byte-offset
  tailing splits on newline *bytes* so multi-byte UTF-8 never tears.
- **Terminal ordering:** a run's terminal meta is written only after its final
  event flush, so a tailer that sees a terminal status has the whole stream.
- **Orphans:** if a runner dies without settling (SIGKILL, reboot), the next
  sweep marks the run errored and salvages its recorded events into history.
- **Queue cancel:** canceling a queued run (marker or Ctrl+C) releases it
  immediately and records a canceled history entry.
- **Event-loop liveness:** the queue wait, approval poll, and tail poll are
  deliberately ref'd timers — a detached runner parked on an approval must
  not let its event loop drain and exit.
- **No signals:** cancel is marker-file based, not `SIGTERM`-based, so
  canceling one run inside a multi-run TUI/web process never kills the whole
  process, and the mechanism is portable.

## Follow-ups (tracked, out of scope here)

- Notifications on completion/approval-needed (roadmap 1.5) — the natural
  companion; all the hooks (terminal meta, pending-approval state) exist.
- Scheduled runs (`workflow schedule --cron`) — Part 3 of the roadmap,
  unblocked by the detached runner.
- TUI/web "detach a run I started here into a background process" — today
  detach is chosen at launch (`--detach`); in-process runs still end with
  their owning process (they are attachable and cancelable while it lives).
