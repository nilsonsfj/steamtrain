# Model binding

Workflows can name **what kind of mind** a step needs without pinning a specific
agent CLI. Steamtrain maps that intent onto a concrete `agent` + native `model`
at dispatch time, preferring each model's **reference agent** when it is
healthy, and falling over to other agents that offer the same model family when
it is not.

## Why this exists

Shipping a workflow that hard-codes `agent: "claude"` forces every consumer to
install and authenticate Claude Code. Naming `model: "opus 4.8"` (or
`modelClass: "thinker"`) lets the same workflow run on whatever ready agent can
actually provide that capability - Claude when available, otherwise OpenCode,
Kiro, Cursor, and so on.

## Binding forms

| Form | Fields | Resolution |
| --- | --- | --- |
| Pinned | `agent` + `model` | Runs that pair. If the agent is unhealthy, remaps onto another ready offering of the same family when one exists. |
| Model-only | `model` | Finds the family (or catalog match), prefers the reference agent, then preference order. |
| Class-only | `modelClass` | Walks the class's preferred families until a ready offering exists. |
| Agent + class | `agent` + `modelClass` | Resolves the class onto that agent's catalog. |
| Failover list | `fallbackModels` | Appends extra model queries to the candidate chain. |

Every agent-backed step still needs a `prompt`.

### Friendly model queries

`model` accepts:

- Native ids: `claude-opus-4-8`, `opencode/claude-opus-4-8`, `gpt-5.5`
- Aliases: `opus 4.8`, `sonnet`, `haiku`, `gpt 5.5`
- Family names: `Claude Opus 4.8`

Normalization collapses case, spacing, and punctuation so `Opus 4.8` and
`opus-4.8` match the same family.

### Reference agents

Each model family has a home provider - the CLI that is the natural source of
truth for that model:

| Family kind | Reference agent |
| --- | --- |
| Claude (Opus / Sonnet / Haiku / Fable) | `claude` |
| GPT / Codex | `codex` |
| Gemini | `antigravity` |
| Composer / Cursor Grok | `cursor` |
| Amp modes | `amp` |
| OpenCode-only free models | `opencode` |

When several agents offer the same family, resolution order is:

1. Explicit `agent` pin (when ready)
2. Reference agent instance (built-in id matching the provider)
3. `claude → codex → cursor → opencode → antigravity → kiro → amp`
4. Custom instances of the same provider after their built-in sibling

## Model classes

Role classes let a step say *what the work is like* instead of which weights to
load:

| Class | Intent | Default preference (first available wins) |
| --- | --- | --- |
| `thinker` | Hard design, diagnosis, deep review | Fable 5, Opus 4.8, Mythos 5, GPT-5.5 Pro, … |
| `implementer` | Build, refactor, fix | Sonnet 5, Composer 2.5, GPT-5.5, GPT-5.3 Codex, … |
| `simple` | Triage, format, low-stakes chores | Haiku 4.5, MiMo free, GPT-5.4 Mini, Amp Rush, … |
| `balanced` | General-purpose default | Sonnet 5, GPT-5.5, GPT-5.4, Composer 2.5, Amp Smart, … |

Override preferred families in config:

```jsonc
{
  "modelClasses": {
    "implementer": {
      "preferred": ["composer-2.5", "claude-sonnet-5", "gpt-5.3-codex"]
    },
    "thinker": {
      "name": "Deep thinker",
      "description": "Reserved for architecture and incident review.",
      "preferred": ["claude-opus-4.8", "gpt-5.5-pro"]
    }
  }
}
```

Project `steamtrain.json` merges over `~/.steamtrain/config.json` per class.

## Runtime failover

Two layers:

1. **Dispatch remap** - if a pinned agent is unhealthy but the step's model
   (or class) has another ready offering, the run binds to that offering
   automatically. `/reroute` also preserves model families when retargeting.
2. **Retry failover** - on a transient agent failure, the engine walks the
   candidate chain (`fallbackModels` included) and retries on the next
   agent/model instead of only re-trying the same pair.

Resolved bindings are materialised for the run; they are **not** written back
into the workflow file. Authoring keeps the portable form.

## Examples

```jsonc
{
  "id": "design",
  "modelClass": "thinker",
  "prompt": "Design an approach for: {{input}}"
}
```

```jsonc
{
  "id": "code",
  "model": "sonnet 5",
  "fallbackModels": ["composer-2.5", "gpt-5.3-codex"],
  "prompt": "Implement the design in {{steps.design.output}}"
}
```

```jsonc
{
  "id": "polish",
  "modelClass": "simple",
  "prompt": "Tighten copy and fix nits in {{steps.code.output}}"
}
```

## Surfaces

- **Schema / CLI validate** - accepts the binding forms above.
- **Doctor / dispatch** - resolves bindings before the health gate; fails only
  when no ready agent can satisfy the request.
- **TUI / Web meta** - `GET /api/meta` exposes `modelClasses` and
  `modelFamilies` alongside agent catalogs so authoring UIs can offer class
  pickers and show which agents provide a family.
- **Draft `/model <alias>`** - uses the same resolver (reference preference).
