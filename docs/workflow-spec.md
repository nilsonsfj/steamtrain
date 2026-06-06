# Steamtrain workflow language

Workflows are steamtrain's primary orchestration unit. A workflow is a JSON
object made of ordered phases; each phase contains one or more steps. Phases run
sequentially. Steps inside a phase run concurrently, bounded by
`maxConcurrency`.

Workflow definitions live under the `workflows` map in `steamtrain.json`.

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
              "id": "review-api",
              "kind": "worker",
              "agent": "claude",
              "model": "claude-sonnet-4-6",
              "dependsOn": ["areas"],
              "prompt": "Review the API area:\n{{steps.areas.items}}"
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
              "dependsOn": ["review-api"],
              "condition": { "step": "review-api", "ok": true },
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
              "dependsOn": ["review-api", "has-output"]
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

Optional fields: `cwd`, `env`, `extraArgs`.

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
| `fail` | Mark the gate, phase, and workflow failed. |
| `stop` | Stop scheduling later phases after the current phase completes. |

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

Unknown placeholders are left unchanged.

## Validation rules

- A workflow must contain at least one phase.
- A phase must contain at least one step.
- Step ids must be unique across the workflow.
- `dependsOn` and gate `condition.step` may reference earlier phases only.
- A workflow may contain at most 1000 static steps.
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
