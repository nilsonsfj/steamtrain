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
  "maxConcurrency": 3,
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
| `kind` | no | One of `worker`, `processor`, `distributor`, `consolidator`, `gate`. Missing means `worker`. |
| `dependsOn` | no | Step ids from earlier phases only. Same-phase and forward dependencies are invalid. |

## Building blocks

### Worker / processor

Runs one agent against one prompt. `processor` is an alias for `worker`.
Existing no-`kind` steps are treated as workers.

Required fields: `agent`, `model`, `prompt`.

Optional fields: `cwd`, `env`, `extraArgs`, `effort`, `forEach`, `retry`.

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
form `items`.

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
| `contains` | Require output/input text to contain this rendered string. |
| `matches` | Require output/input text to match this rendered regular expression. |
| `equals` | Require output/input text to equal this rendered string. |
| `not` | Invert the final result. |

`onFalse` controls a false condition:

| value | meaning |
| --- | --- |
| `continue` | Default. Mark the gate blocked but keep the workflow successful. |
| `fail` | Mark the gate, phase, and workflow failed, then stop scheduling later phases. |
| `stop` | Stop scheduling later phases after the current phase completes while keeping the workflow successful. |

Steps with `dependsOn` are skipped when any referenced earlier step failed.

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
- `maxConcurrency` is capped at 16.
- Distributor steps require `items` or `agent` + `model` + `prompt`.
- Consolidator steps require `dependsOn`.
- Agent-backed consolidators require `agent`, `model`, and `prompt` together.
- Gate conditions require at least one of `ok`, `contains`, `matches`, or
  `equals`.

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
