# Steamtrain workflow language

Workflows are steamtrain's primary orchestration unit. A workflow is a JSON
object made of ordered phases; each phase contains one or more steps. Phases run
sequentially. Steps inside a phase run concurrently, bounded by
`maxConcurrency`.

Workflow definitions live under the `workflows` map in `steamtrain.json`.

**Read first:** [`workflow-overview.md`](workflow-overview.md) for diagrams and
execution behavior. **Examples:** [`workflow-examples.md`](workflow-examples.md).

```jsonc
{
  "maxConcurrency": 5,
  "workflows": {
    "example": {
      "description": "Split work, process it, gate it, then merge a report.",
      "phases": [
        {
          "id": "split",
          "title": "Split input",
          "steps": [
            {
              "id": "areas",
              "kind": "distributor",
              "items": ["api: {{input}}", "web: {{input}}"]
            }
          ]
        },
        {
          "id": "process",
          "title": "Process work",
          "steps": [
            {
              "id": "review-each",
              "kind": "worker",
              "agent": "claude",
              "model": "claude-sonnet-4-6",
              "dependsOn": ["areas"],
              "forEach": "steps.areas.items",
              "prompt": "Review this area:\n{{item}}"
            }
          ]
        },
        {
          "id": "route",
          "title": "Gate results",
          "steps": [
            {
              "id": "has-output",
              "kind": "gate",
              "dependsOn": ["review-each"],
              "condition": { "step": "review-each", "ok": true },
              "target": "ready"
            }
          ]
        },
        {
          "id": "report",
          "title": "Consolidate",
          "steps": [
            {
              "id": "report",
              "kind": "consolidator",
              "dependsOn": ["review-each", "has-output"]
            }
          ]
        }
      ]
    }
  }
}
```

## Top-level workflow fields

| field | required | meaning |
| --- | --- | --- |
| `name` | no in `steamtrain.json` | Launch name. The map key is injected as `name`. |
| `description` | no | Human-readable picker/list text. |
| `phases` | yes | Ordered list of workflow phases. |
| `retry` | no | Default auto-retry policy for every agent worker/processor step. See [Auto-retry](#auto-retry-on-transient-failures). |
| `maxCostUsd` | no | Whole-workflow USD budget. The engine stops scheduling new steps once the run's cost reaches it; the run ends `budget-exceeded` and is resumable after raising the cap. See [Cost budgets](./cost-and-budgets.md). |

## Phase fields

| field | required | meaning |
| --- | --- | --- |
| `id` | yes | Unique phase identifier. |
| `title` | yes | Display title in the TUI and CLI event stream. |
| `steps` | yes | Non-empty list of steps that run concurrently in this phase. |

## Shared step fields

| field | required | meaning |
| --- | --- | --- |
| `id` | yes | Unique across the whole workflow. |
| `kind` | no | One of `worker`, `processor`, `distributor`, `consolidator`, `gate`, `merge`, `command`. Missing means `worker`. |
| `dependsOn` | no | Step ids from earlier phases only. Same-phase and forward dependencies are invalid. Steps are scheduled by these dependencies; omitting `dependsOn` makes the step wait for every step in all earlier phases. |
| `when` | no | Per-step condition (same schema as a gate condition). When false the step is skipped, not failed. See [Per-step conditions](#per-step-conditions-when). |

## Building blocks

### Worker / processor

Runs one agent against one prompt. `processor` is an alias for `worker`.
Existing no-`kind` steps are treated as workers.

Required fields: `agent`, `model`, `prompt`.

Optional fields: `cwd`, `env`, `extraArgs`, `effort`, `forEach`, `retry`,
`maxCostUsd` (per-step USD budget for `forEach` fan-outs — see
[Cost budgets](./cost-and-budgets.md)),
`output` (see [Structured step outputs](#structured-step-outputs-output)),
`workspace` / `artifacts` (see
[Workspace inheritance and artifacts](#workspace-inheritance-and-artifacts-file-handoff)).

If the resolved `cwd` is inside a git repository, the agent subprocess runs from
a matching path in its own git worktree. The worktree starts at the current
`HEAD` and includes a snapshot of tracked dirty changes plus untracked
non-ignored files. Ignored runtime entries are linked into the worktree, and the
step result records the worktree cwd, root, branch, and linked ignored paths so
agent-created changes can be inspected or merged later. Non-git directories run
directly in the resolved `cwd`.

```jsonc
{
  "id": "review-api",
  "kind": "processor",
  "agent": "claude",
  "model": "claude-sonnet-4-6",
  "cwd": "../api",
  "prompt": "Review {{input}}"
}
```

Add `forEach` to dynamically fan a worker/processor out over distributor items.
The engine creates one generated child step per item, assigns one agent run to
each child, and stores an aggregate parent result under the declared step id.

```jsonc
{
  "id": "review-each",
  "kind": "processor",
  "agent": "claude",
  "model": "claude-sonnet-4-6",
  "dependsOn": ["areas"],
  "forEach": "steps.areas.items",
  "prompt": "Review item {{item.index}}:\n{{item}}"
}
```

If `areas` produced `["api", "web"]`, the runtime step tree includes:

```text
review-each
  review-each[0] -> api
  review-each[1] -> web
```

Downstream steps reference the aggregate parent result:

- `{{steps.review-each.output}}` joins every child output with item headers.
- `{{steps.review-each.items}}` is the original item list.
- `{{steps.review-each.ok}}` is `true` only when every child run succeeds.

`forEach` sources must be successful distributor steps from earlier phases. If
the distributor is agent-backed, its final output is split on non-empty lines to
form `items` — unless it declares an `output` schema, in which case `items`
come from a JSON array (see below).

### Distributor

Turns one input into multiple item payloads. Use `items` for static/template
distribution, or provide `agent` + `model` + `prompt` for an agent-backed
splitter.

```jsonc
{
  "id": "areas",
  "kind": "distributor",
  "items": ["api: {{input}}", "web: {{input}}"]
}
```

Static distributor results expose:

- `{{steps.areas.output}}` as the items joined by newline.
- `{{steps.areas.items}}` as the structured items joined by newline.

An agent-backed distributor normally splits the agent's output on non-empty
lines. Give it an `output` JSON schema to fan out over a **JSON array**
instead: the parsed value itself must be an array, or set `itemsPath` to the
field holding one. String elements become item payloads as-is; other values
are JSON-serialized.

```jsonc
{
  "id": "split",
  "kind": "distributor",
  "agent": "claude",
  "model": "claude-sonnet-4-6",
  "prompt": "List the areas of {{input}} to review.",
  "output": {
    "type": "object",
    "required": ["targets"],
    "properties": { "targets": { "type": "array", "items": { "type": "string" } } }
  },
  "itemsPath": "targets"
}
```

### Consolidator

Combines prior results. A pure consolidator with no `agent` emits either its
rendered `prompt` or a default sectioned merge of every dependency. An
agent-backed consolidator uses `agent` + `model` + `prompt` to produce a merged
answer.

```jsonc
{
  "id": "report",
  "kind": "consolidator",
  "dependsOn": ["review-api", "review-web"],
  "prompt": "Merge:\n{{steps.review-api.output}}\n{{steps.review-web.output}}"
}
```

### Gate

Evaluates a condition and emits a target/state label. Gates are useful for
filtering, marking state transitions, failing a workflow on missing conditions,
or stopping before later phases.

```jsonc
{
  "id": "ready",
  "kind": "gate",
  "dependsOn": ["report"],
  "condition": { "step": "report", "contains": "P0" },
  "target": "needs-attention",
  "onFalse": "continue"
}
```

Gate condition fields are combined with logical AND:

| field | meaning |
| --- | --- |
| `step` | Inspect this earlier step. If omitted, inspect workflow input text. |
| `ok` | Require the referenced step's success state. |
| `path` | Inspect one field of the step's structured output (e.g. `verdict`, `issues[0].severity`) instead of its full text. Requires `step`; the step should declare an `output` schema. Missing fields evaluate as empty text. |
| `contains` | Require output/input text to contain this rendered string. |
| `matches` | Require output/input text to match this rendered regular expression. |
| `equals` | Require output/input text to equal this rendered string. |
| `not` | Invert the final result. |

With `path`, gates route on typed fields instead of substring heuristics — a
reviewer that prints "no P0 issues found" no longer trips a `contains: "P0"`
gate:

```jsonc
{
  "id": "check",
  "kind": "gate",
  "dependsOn": ["review"],
  "condition": { "step": "review", "path": "verdict", "equals": "pass" },
  "onFalse": "fail"
}
```

`onFalse` controls a false condition:

| value | meaning |
| --- | --- |
| `continue` | Default. Mark the gate blocked but keep the workflow successful. |
| `fail` | Mark the gate, phase, and workflow failed, then stop scheduling later phases. |
| `stop` | Stop scheduling later phases after the current phase completes while keeping the workflow successful. |

Steps with `dependsOn` are skipped when any referenced earlier step failed —
with one exception: a gate whose condition **explicitly tests `ok`** for that
same step still evaluates, since it opted in to inspecting failure. That is
what lets a gate (or a loop) route on a failing `command` step:

```jsonc
{
  "id": "converged",
  "kind": "gate",
  "dependsOn": ["tests"],
  "condition": { "step": "tests", "ok": true },
  "loopTo": "fix",
  "onFalse": "fail"
}
```

Text-only conditions (`contains`/`matches`/`equals`) keep the skip: they assume
the referenced step produced meaningful output, and an errored agent mid-loop
should halt the loop rather than burn its iteration budget re-running a
persistent failure.

### Merge (worktree merge-back)

Agent steps run in isolated git worktrees, so their file edits never land in
the user's checkout by themselves. A `merge` step harvests those worktrees:
it snapshots each source step's working state into a commit on its steamtrain
branch, merges the sources together in an isolated staging worktree, and
delivers the result. It is engine-executed (deterministic, no agent, no cost)
except when an agent is asked to resolve conflicts.

```jsonc
{
  "id": "land",
  "kind": "merge",
  "dependsOn": ["implement"],          // sources default to dependsOn
  "mode": "apply",                     // apply | branch | pr
  "onConflict": "agent",               // fail | ours | theirs | agent
  "agent": "claude",                   // conflict-resolution agent (onConflict: "agent")
  "model": "claude-sonnet-4-6"
}
```

| field | meaning |
| --- | --- |
| `from` | Step ids whose worktrees to merge. Defaults to `dependsOn`. A `forEach` fan-out parent contributes every child worktree. Sources whose worktrees have no changes are skipped. |
| `mode` | `apply` (default): the merged diff lands in the user's checkout as **uncommitted** working-tree changes (pre-checked and all-or-nothing; the step fails with guidance when local edits conflict). `branch`: the merged state is left on a local branch. `pr`: the branch is pushed to `origin` and a pull request is opened with the `gh` CLI. |
| `branch` | Branch name template for `branch`/`pr` modes; a unique `steamtrain/merged/…` name is generated when omitted. |
| `perSource` | One branch/PR **per source worktree** instead of one combined merge — e.g. each parallel `forEach` implementer gets its own PR for human review. Requires `mode` `branch` or `pr`. |
| `onConflict` | What to do when sources conflict with each other: `fail` (default), `ours`/`theirs` (deterministic, via `git merge -X` — resolves content conflicts only; tree-level conflicts like modify/delete still fail), or `agent` — the configured agent runs inside the staging worktree and resolves the conflict markers. Requires `agent` + `model`. |
| `prompt` | Extra guidance appended to the built-in conflict-resolution prompt. |
| `commitMessage`, `prTitle`, `prBody` | Templates for the merge commit and the PR (all support `{{…}}` placeholders). |

The step's output is a human-readable summary, and its structured result
(`{{steps.<id>.json.<path>}}`, gate `path` conditions) reports `mode`,
`merged`, `unchanged`, `files`, `additions`, `deletions`, `conflicts`,
`branches`, `prUrls`, and `noChanges` — so a downstream gate can, for example,
fail the run when nothing was produced:

```jsonc
{
  "id": "produced-changes",
  "kind": "gate",
  "dependsOn": ["land"],
  "condition": { "step": "land", "path": "noChanges", "equals": "false" },
  "onFalse": "fail"
}
```

Conflicts with the *user's checkout* are deliberately out of scope for
`apply`: the merged diff is checked first and the step fails cleanly (use
`mode: "branch"` or stash the local edits), so a run can never leave the
checkout half-patched or spray conflict markers into it.

For bespoke integration flows, skip the `merge` step and give a plain agent
step the worktree paths via templates:
`{{steps.<id>.worktree.root}}` / `{{steps.<id>.worktree.branch}}`.

Past runs can be harvested manually with the same machinery:
`steamtrain workflow history show <id> --diff [--step <stepId>] [--stat]`,
`history apply <id> [--step <stepId>]`, and `history prune <id>` (discard the
run's worktrees and branches). See
[`worktree-merge-back.md`](worktree-merge-back.md) for the full design.

### Command (deterministic shell step)

Runs one shell command — no agent, no cost, no LLM in the loop. The canonical
use is letting deterministic tools verify what non-deterministic agents
produced: gate a fix loop on `npm test` actually passing instead of an agent
claiming "DONE".

Required field: `cmd` — a templated shell line, run through the platform shell.

Optional fields: `cwd`, `env`, `stepTimeoutSec`, `output` (see
[Structured step outputs](#structured-step-outputs-output) — validated without
the agent "fix your JSON" retry, since re-running a deterministic command can't
change its output), `workspace` / `artifacts` (see
[Workspace inheritance and artifacts](#workspace-inheritance-and-artifacts-file-handoff)).

```jsonc
{
  "id": "tests",
  "kind": "command",
  "dependsOn": ["implement"],
  "cmd": "npm test"
}
```

Semantics:

- The step's output is the command's stdout and stderr, interleaved in arrival
  order and streamed live to the TUI/web UI. Output above 512 KiB is
  tail-truncated (the head is dropped — failures conventionally print last).
- The step is **ok exactly when the command exits 0**. On any other exit the
  captured output is kept (the diagnostics are the output) with the failure
  appended, and `error` says what happened (`command exited with code 1`,
  `command timed out after 900s`, …).
- `{{steps.<id>.exitCode}}` exposes the exit code to templates; a downstream
  gate routes on `{ "step": "<id>", "ok": true }`.
- `stepTimeoutSec` follows the same chain as agent steps (step → workflow →
  config → 15-minute default). On timeout the whole process tree is killed.
- Command steps run inside the same per-step git-worktree isolation as agent
  steps: in a git repository the command executes in its own worktree
  (snapshotting your dirty state), so a command that writes files never touches
  your checkout — and a later `merge` step can harvest what it wrote. The
  worktree is recorded on the result like any agent step's.

A typical trustworthy fix loop:

```jsonc
{ "id": "fix", "steps": [
  { "id": "fix-it", "agent": "claude", "model": "claude-sonnet-4-6",
    "prompt": "Fix the failing tests:\n{{steps.tests.output}}" }
] },
{ "id": "verify", "steps": [
  { "id": "tests", "kind": "command", "cmd": "npm test" }
] },
{ "id": "check", "steps": [
  { "id": "converged", "kind": "gate", "dependsOn": ["tests"],
    "condition": { "step": "tests", "ok": true },
    "loopTo": "fix", "maxIterations": 5, "onFalse": "fail" }
] }
```

## Workspace inheritance and artifacts (file handoff)

Each worker/processor/command step runs in its **own** worktree snapshotted
from your checkout — by default a later step sees an earlier step's *text
output*, never its file edits. Two fields fix that when steps must build on
each other's work:

### `workspace: "inherit:<stepId>"`

Start this step's worktree from the named step's **final worktree state**
(tracked edits, untracked files, and any commits the step made) instead of the
original checkout. The reviewer actually sees the implementer's diff; the test
run actually exercises the fix. Your checkout stays untouched — the step still
gets its own isolated worktree, just seeded differently.

```jsonc
{ "id": "build", "steps": [
  { "id": "implement", "agent": "claude", "model": "claude-sonnet-4-6",
    "prompt": "Implement: {{input}}" }
] },
{ "id": "verify", "steps": [
  { "id": "tests", "kind": "command", "workspace": "inherit:implement",
    "cmd": "npm test" }
] },
{ "id": "review", "steps": [
  { "id": "critique", "agent": "claude", "model": "claude-opus-4-8",
    "workspace": "inherit:implement",
    "prompt": "Review the uncommitted changes in this working tree (git diff)." }
] }
```

Semantics:

- The source becomes an **implicit dependency**: the inheriting step is
  scheduled after it, is skipped when it was skipped, and fails when it failed.
- The source must be a single worker/processor/command step in an earlier
  phase. A `forEach` fan-out parent has one worktree per item and cannot be
  inherited — merge its worktrees first.
- Chains compose (`b` inherits `a`, `c` inherits `b`), and the **diff base is
  inherited too**: merging the tail of a chain (via a `merge` step or `history
  apply`) lands the whole chain's changes. Point the final merge at the last
  step of a chain, not every link.
- Inside a loop (`loopTo`), each iteration inherits the source's **latest**
  worktree — a fix → test loop keeps building on the newest fix.
- Outside a git repository steps share the plain `cwd` and inheritance is
  trivially satisfied.
- On a resumed run the source may replay from cache; its recorded worktree is
  reused (worktrees are retained). If it was pruned (`history prune`), the
  inheriting step fails with a clear error — re-run without the stale cache.

### `artifacts: ["report.md", "coverage/"]`

Output files or directories the step **promises to produce**, relative to its
cwd. After the step succeeds, each is snapshotted out of the (ephemeral,
prunable) worktree into a per-run artifacts directory and recorded on the step
result; a declared artifact that was not produced **fails the step** — the
declaration is a contract downstream steps rely on.

Templates hand the snapshot path to later steps as
`{{steps.<id>.artifacts.<name>}}`, where `<name>` is the last path segment
minus its extension (`report.md` → `report`, `coverage/` → `coverage`) —
names must be unique within a step:

```jsonc
{ "id": "audit", "steps": [
  { "id": "scan", "kind": "command", "cmd": "npm audit --json > audit.json; true",
    "artifacts": ["audit.json"] }
] },
{ "id": "summarize", "steps": [
  { "id": "summary", "agent": "claude", "model": "claude-sonnet-4-6",
    "prompt": "Summarize the audit report at {{steps.scan.artifacts.audit}}" }
] }
```

Snapshot paths stay valid independent of worktree lifecycle (a `history prune`
doesn't invalidate them), and a loop iteration re-running a step replaces its
previous snapshot — latest wins, matching step outputs. Artifact paths must be
relative and stay inside the step's cwd; use artifacts when a step's real
product is a file, rather than pasting large content through text outputs.

## Per-step conditions (`when`)

Any step may carry a `when` condition using the gate-condition schema. It is
evaluated just before the step would run; when false the step is **skipped** —
recorded ok with `skipped: true`, target `skipped`, and empty output — instead
of executed.

```jsonc
{
  "id": "fix-frontend",
  "agent": "claude",
  "model": "claude-sonnet-4-6",
  "dependsOn": ["triage"],
  "when": { "step": "triage", "contains": "frontend" },
  "prompt": "Fix the frontend issues:\n{{steps.triage.output}}"
}
```

- `when.step` must reference a step in an earlier phase; omitting `step`
  applies text conditions to the workflow input.
- Skips cascade through `dependsOn` and `forEach` sources. Consolidators are
  the exception: they treat skipped inputs as absent (the default sectioned
  merge omits them) and are skipped only when every dependency was skipped.
- A skipped gate does not evaluate its condition and never stops the run.
- Skipped results are cached, so resumed runs replay the same decision.

## Structured step outputs (`output`)

Any agent-backed step (worker, processor, agent-backed distributor or
consolidator) may declare an `output` JSON schema. The engine appends a
"required output format" contract to the rendered prompt, then extracts the
JSON from the agent's final reply (raw, inside a ` ```json ` fence, or embedded
in prose — the last parseable value wins) and validates it against the schema.

```jsonc
{
  "id": "review",
  "agent": "claude",
  "model": "claude-sonnet-4-6",
  "prompt": "Review {{input}}. Verdict: pass or fail.",
  "output": {
    "type": "object",
    "required": ["verdict"],
    "properties": {
      "verdict": { "type": "string", "enum": ["pass", "fail"] },
      "issues": { "type": "array", "items": { "type": "string" } }
    }
  }
}
```

- On a parse/validation failure the engine runs **one** bounded "fix your
  JSON" retry: the agent is re-invoked with the schema, the validation error,
  and its previous reply. If that reply still doesn't match, the step fails.
  The retry surfaces in the TUI/web UI like a transient retry, and the extra
  attempt is counted in the step's `attempts` and cost.
- The parsed value is stored on the step result as `json` and drives
  `{{steps.<id>.json…}}` templates, gate/`when` `path` conditions, and
  distributor array fan-out. The step's `output` text remains the raw reply.

Supported schema keywords (a pragmatic JSON Schema subset): `type` (including
`integer`, and arrays of types), `enum`, `const`, `properties`, `required`,
`additionalProperties: false`, `items`, `minItems`/`maxItems`,
`minLength`/`maxLength`, `pattern`, `minimum`/`maximum`. Unknown keywords are
ignored.

## Scheduling

Steps are dependency (DAG) scheduled: a step starts once its `dependsOn` — plus
anything it references via `forEach`, gate `condition.step`, `when.step`, or
`{{steps.<id>.…}}` templates — has settled, bounded by `maxConcurrency`. A step
without `dependsOn` waits for every step in all earlier phases, so phases act
as barriers for it (the pre-DAG behavior). Gates with `onFalse: fail`/`stop`
hold back all later-phase steps until they evaluate, and workflows containing
loop-back gates (`loopTo`) run phase-by-phase.

## Auto-retry on transient failures

Agent worker/processor steps (and each `forEach` child) automatically re-attempt
**transient, side-effect-free** failures with exponential backoff. Auto-retry is
on by default.

A failure is retried only when the agent **did no observable work** — a
transport/spawn error or a crash that happened *before the agent completed a turn
and before it invoked any tool*. A step is **never** auto-retried if it ran to
completion and reported an error (`isError`), or if it had already started using
tools when it failed — either case may have made changes (commits, edits, API
calls). Cancellations, gates, distributors, and consolidators are never
auto-retried. This is deliberately conservative: in practice it retries spawn
failures and immediate transport/rate-limit errors, not failures that occur once
the agent is underway.

Set a default for the whole workflow with the top-level `retry` field, and/or
override it per step. Every field is optional; unset fields fall back through the
workflow default to the built-in defaults.

| field | default | meaning |
| --- | --- | --- |
| `maxAttempts` | `3` | Total tries including the first. `1` disables retry. (1–10) |
| `initialDelayMs` | `1000` | Backoff before the second attempt. (0–60000) |
| `factor` | `2` | Geometric growth per attempt: 1s, 2s, 4s, … (1–10) |
| `maxDelayMs` | `30000` | Cap on any single backoff wait. (0–600000) |
| `jitter` | `true` | Scale each wait by a random `[0,1)` so fan-out children desync. |

```jsonc
{
  "name": "build-and-test",
  "retry": { "maxAttempts": 4 },        // workflow default
  "phases": [
    {
      "id": "p1",
      "title": "Work",
      "steps": [
        {
          "id": "flaky",
          "agent": "claude",
          "model": "claude-sonnet-4-6",
          "prompt": "{{input}}",
          "retry": { "maxAttempts": 1 } // disable for just this step
        }
      ]
    }
  ]
}
```

Retries surface live in the TUI and web UI (`↻ retry n/N`), and the total
attempt count is recorded per step in run history. Auto-retry handles *transient*
failures during a run; to re-run *persistent* failures after fixing their cause
while keeping completed work, use `run --from <id> --retry-failed`.

## Templates

Prompt templates and several block fields support:

| placeholder | expands to |
| --- | --- |
| `{{input}}`, `{{args}}` | The text supplied when the workflow starts. |
| `{{steps.<id>.output}}` | Prior step output. |
| `{{steps.<id>.items}}` | Prior distributor items joined by newline. |
| `{{steps.<id>.ok}}` | `true` or `false`. |
| `{{steps.<id>.error}}` | Prior step error text, if any. |
| `{{steps.<id>.target}}` | Prior gate target/state, if any. |
| `{{steps.<id>.exitCode}}` | A prior command step's exit code, e.g. `0` (empty for other steps). |
| `{{steps.<id>.json}}` | Prior step's parsed structured output, JSON-serialized. |
| `{{steps.<id>.json.<path>}}` | A field of it, e.g. `json.verdict` or `json.targets[2]`. Strings render raw, other values JSON-serialized, missing fields empty. |
| `{{steps.<id>.artifacts.<name>}}` | The snapshot path of a prior step's declared artifact (empty when unknown). |
| `{{steps.<id>.worktree.root}}` | The step's isolated git worktree directory (empty when the step ran without one). |
| `{{steps.<id>.worktree.branch}}` | The steamtrain branch checked out in that worktree. |
| `{{steps.<id>.worktree.cwd}}` | The cwd the agent actually ran in (inside the worktree). |
| `{{item}}`, `{{item.value}}` | Current dynamic fan-out item inside a `forEach` worker/processor. |
| `{{item.index}}` | Zero-based index of the current fan-out item. |
| `{{item.sourceStepId}}` | Distributor step id that produced the current item. |

Unknown placeholders are left unchanged.

## Validation rules

- A workflow must contain at least one phase.
- A phase must contain at least one step.
- Step ids must be unique across the workflow.
- `dependsOn` and gate `condition.step` may reference earlier phases only.
- `forEach` must use `steps.<id>.items` or `<id>.items`, and the source step
  must be a distributor in an earlier phase.
- A workflow may contain at most 1000 total static + generated steps. Static
  distributor item counts are checked at validation time; agent-generated item
  counts are checked at runtime before child runs are scheduled.
- `maxConcurrency` defaults to 5 and is capped at 16.
- Distributor steps require `items` or `agent` + `model` + `prompt`.
- Consolidator steps require `dependsOn`.
- Agent-backed consolidators require `agent`, `model`, and `prompt` together.
- Gate conditions require at least one of `ok`, `contains`, `matches`, or
  `equals`.
- A gate/`when` condition `path` requires `step`.
- Distributor `itemsPath` requires an agent-backed step with an `output`
  schema.
- Merge steps require `from` or `dependsOn`; `from` may reference earlier
  phases only.
- A merge step with `onConflict: "agent"` requires `agent` and `model`.
- A merge step with `perSource` requires `mode` `"branch"` or `"pr"`.
- Command steps require a non-empty `cmd`.
- `workspace` must be `"inherit:<stepId>"`; the source must be a
  worker/processor/command step in an earlier phase, without `forEach`.
- `artifacts` entries must be relative paths that stay inside the step's cwd,
  with unique template names per step.

## CLI

```bash
steamtrain workflow list
steamtrain workflow validate [name]
steamtrain workflow run <name> --input "task text"
steamtrain workflow run <name> --stdin --json
```

Running `steamtrain` with no arguments opens the workflow-first TUI.

## See also

- [`workflow-overview.md`](workflow-overview.md) — diagrams, dynamic fan-out, gates, resume/cache, pitfalls
- [`workflow-examples.md`](workflow-examples.md) — bundled workflow walkthroughs and authoring patterns
- [`README.md`](README.md) — documentation index
