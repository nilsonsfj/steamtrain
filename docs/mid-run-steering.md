# Mid-run steering: pause, edit, resume

Once a run starts, *watch* and *cancel* are no longer the only verbs. A live
run can be **paused** (in-flight steps finish; nothing new is scheduled), any
step that has **not started yet** can have its prompt, command, model, or
effort **edited**, and the run then **resumes** with the edits applied. That
turns "step 7 of 9 is about to run with the wrong prompt — restart the
40-minute run" into a 30-second correction.

There is deliberately **no rewind**: steps that already ran keep their
results. Editing targets the future of the run, not its past. (Re-running a
finished run is what `workflow run --from <id>` is for.)

## The verbs

### Pause

A pause request stops the engine scheduling **new** steps. Steps already in
flight run to completion — agents are never killed mid-edit. The engine emits
a `run_paused` event when it acknowledges; UIs show the run as *pausing*
(in-flight steps draining) and then *paused*.

- In **loop workflows** (a gate with `loopTo`), scheduling is phase-by-phase,
  so the pause takes effect at the next phase boundary.
- A paused run still honors cancel; approval checkpoints already pending can
  still be decided.

### Edit

While a pause is requested, any step that has **not started** in the current
run may be edited:

| field    | applies to |
| -------- | ---------- |
| `prompt` | worker / processor / `llm` / consolidator / approval / agent-backed distributor |
| `cmd`    | `command` steps |
| `model`, `effort` | agent-backed and `llm` steps |

Edits never change the graph (no ids, dependencies, or fan-out shape). The
engine validates each edit against the live spec and rejects it with a clear
reason when the step is unknown, already started/running, or the field does
not exist on its kind. An edited step whose result was cached (a resumed run)
has the stale cache entry dropped, so the edited version actually executes;
downstream steps consume its new output as usual.

Inside a loop, steps of the region being re-run become editable again while
paused between iterations.

### Resume

Scheduling continues; edited steps run with their patches applied. The step's
result (and its row/card in every UI and in history) is badged `✎ edited`.

## Auditability

Every intervention lands in the run record: the event stream carries
`run_paused` / `run_resumed` / `step_edited` (with the exact patch and who
made it), history records an ordered `interventions` list, and the edited
step's result is flagged. A steered run is still an honest record.

## Using it

**TUI** — during a live run press `p` to pause (press again to resume). While
paused, pick a pending step with `↑/↓` and press `e` to open the editor; edit
the prompt/command and (for agent-backed steps) cycle model/effort with ←/→,
`Enter` applies the whole patch as one recorded edit, `Esc` discards.

**Web UI** — the run bar gains a **⏸ Pause / ▶ Resume** button next to
Cancel. While paused, pending step cards show an **✎ Edit step** button that
opens the prompt/command editor, plus model/effort selects for agent-backed
steps. Works for the page's own runs and for attached runs owned by other
processes.

**CLI** — works on any live run in the project, whoever owns it (TUI, web,
`--detach`):

```bash
steamtrain workflow runs                       # find the run id (⏸ paused shows here too)
steamtrain workflow pause <runId>
steamtrain workflow edit-step <runId> <stepId> --prompt "the corrected prompt"
steamtrain workflow edit-step <runId> <stepId> --prompt-file fixed-prompt.txt
steamtrain workflow edit-step <runId> <stepId> --cmd "npm test -- --filter auth"
steamtrain workflow edit-step <runId> <stepId> --model claude-opus-4-8 --effort high
steamtrain workflow resume <runId>
```

`edit-step` waits briefly for the owning process to validate the edit and
prints the accept/reject verdict.

**HTTP** (the web server's API):

```
POST /api/runs/:id/pause
POST /api/runs/:id/resume
POST /api/runs/:id/edit-step   { "stepId": "...", "prompt"/"cmd"/"model"/"effort": "..." }
```

## Cross-process plumbing

Steering rides the same live-run registry as cancel and approvals
(`.steamtrain/runs/<runId>/`): any surface writes the desired pause state to
`control/pause.json` (last write wins) and drops edit requests under
`control/edits/`; the owning process polls them, applies them to the run, and
writes each edit's accept/reject result back. `workflow runs`, the web
Active-runs panel, and the run meta all reflect the acknowledged paused state.

## Semantics worth knowing

- **Pause acknowledgement** (`run_paused`) is emitted by the engine, not the
  requesting UI — with long steps in flight it can lag the request. UIs show
  "pause requested" feedback immediately and flip to *paused* on the event.
- **Sub-workflows**: a `workflow`-kind step counts as one in-flight step — a
  pause waits for the whole child run to finish, and a child run's own steps
  are not individually editable.
- **`forEach` fan-outs**: edit the parent step before it starts; children
  inherit the edited prompt. Individual children cannot be edited.
- **Caching**: an edited step's fresh result is cached like any other, so
  re-running the same workflow + input later resumes from the steered result.
  Run `--fresh` to ignore it.
