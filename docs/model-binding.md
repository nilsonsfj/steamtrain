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
load. Some classes also prefer a high reasoning effort when the step does not
set `effort` explicitly:

| Class | Intent | Default preference (first available wins) | Preferred effort |
| --- | --- | --- | --- |
| `thinker` | Hard design, diagnosis, deep analysis | Fable 5, Opus 4.8, Mythos 5, GPT-5.6 Sol, … | (model default) |
| `ultrathinker` | Maximum-effort frontier reasoning | Fable 5, GPT-5.6 Sol, Kimi K3, Opus 4.8, … | `xhigh` → `high` |
| `deep-reviewer` | High-stakes code / design review | Opus 4.8, GPT-5.6 Sol, Fable 5, GPT-5.5, … | `high` → `xhigh` |
| `reviewer` | PR and code review (frontier + value tier) | Opus 4.8, DeepSeek V4 Pro, Qwen 3.7 Max, … | `high` → `medium` |
| `implementer` | Build, refactor, fix | Sonnet 5, Composer 2.5, GPT-5.5, GPT-5.3 Codex, … | (model default) |
| `simple` | Triage, format, low-stakes chores | Haiku 4.5, MiMo free, Flash-Lite, GPT-5.6 Luna, … | (model default) |
| `balanced` | General-purpose default | Sonnet 5, GPT-5.5, GPT-5.6 Terra, Composer 2.5, Gemini 3.6 Flash, … | (model default) |

Override preferred families (and optionally `preferredEfforts`) in config:

```jsonc
{
  "modelClasses": {
    "implementer": {
      "preferred": ["composer-2.5", "claude-sonnet-5", "gpt-5.3-codex"]
    },
    "ultrathinker": {
      "preferredEfforts": ["xhigh", "high", "max"]
    },
    "thinker": {
      "name": "Deep thinker",
      "description": "Reserved for architecture and incident review.",
      "preferred": ["claude-opus-4.8", "gpt-5.6-sol"]
    }
  }
}
```

Project `steamtrain.json` merges over `~/.steamtrain/config.json` per class.

## Runtime failover

Three layers:

1. **Dispatch remap** - if a pinned agent is unhealthy but the step's model
   (or class) has another ready offering, the run binds to that offering
   automatically. `/reroute` also preserves model families when retargeting.
2. **Retry failover** - on a transient agent failure (transport error before
   any tool use), the engine walks the candidate chain (`fallbackModels`
   included) and retries on the next agent/model instead of only re-trying the
   same pair.
3. **Capacity failover** - when a provider reports **quota / billing
   exhaustion** or a **rate limit** (often as a completed error turn rather
   than a transport crash), the engine classifies the failure and walks the
   same candidate chain mid-flight so a quota run-out does not ruin the
   workflow. Same-model retries are skipped for quota (they cannot recover);
   rate limits without a next candidate still use normal backoff retries.

Resolved bindings are materialised for the run; they are **not** written back
into the workflow file. Authoring keeps the portable form.

### Configuring mid-flight model failover

`modelFailover` is optional at three layers (each field resolves independently:
per-step → workflow → project/user `steamtrain.json` → built-in defaults):

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Walk the failover chain on matching failures. |
| `on` | `["quota", "rate_limit", "transient"]` | Failure kinds that trigger a model switch. Also accepts `"auth"` or `"any"`. |
| `onCapacityResult` | `true` | Treat completed error turns that look like quota/rate-limit as failover-eligible (providers often surface exhaustion this way). |
| `allowAfterToolUse` | `false` | Allow failover after a tool ran (opt-in; the worktree may already have edits). |
| `preferNextModel` | `true` | On quota, skip re-trying the same binding and jump to the next candidate. |
| `failoverDelayMs` | `250` | Short pause before a switched attempt (same-binding retries still use `retry`). |

Workflow-level `fallbackModels` are appended to every agent-backed step's
chain (after the step's own list), so you can declare a shared safety net once:

```jsonc
{
  "name": "ship",
  "fallbackModels": ["sonnet 5", "composer-2.5", "gpt-5.3-codex"],
  "modelFailover": {
    "on": ["quota", "rate_limit", "transient"],
    "failoverDelayMs": 100
  },
  "phases": [
    {
      "id": "build",
      "title": "Build",
      "steps": [
        {
          "id": "implement",
          "modelClass": "implementer",
          "prompt": "Implement {{input}}"
        }
      ]
    }
  ]
}
```

Project / user config may set the same `modelFailover` object as a default for
every workflow. UIs surface a failover as a `step_retry` with a `failover`
payload (from → to agent/model) and update the live step target accordingly.

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
