# Agent configuration

Agent instances (the runnable entries behind workspaces and workflow steps) can
be configured at two scopes:

| Scope   | File                        | When to use                                    |
| ------- | --------------------------- | ---------------------------------------------- |
| global  | `~/.steamtrain/config.json` | An agent you want in every project (default)   |
| project | `./steamtrain.json`         | Project-specific overrides or team-shared setup |

Config merges as **defaults → global → project**. Agent entries merge by `id`:
a project entry with the same id replaces the global entry wholesale.

The global file accepts the same keys as `steamtrain.json` except `workflows`
(user workflows live in `~/.steamtrain/workflows.json`):

```json
{
  "agents": [
    { "id": "mimocode", "provider": "opencode", "binary": "mimocode" }
  ],
  "binaries": { "claude": "/usr/local/bin/claude" },
  "stepTimeoutSec": 600,
  "modelFailover": {
    "on": ["quota", "rate_limit", "transient"],
    "failoverDelayMs": 250
  }
}
```

`modelFailover` is the project/user default for mid-flight model re-routing when
an agent hits quota, rate limits, or other configured failures — see
[Model binding](model-binding.md#configuring-mid-flight-model-failover). Workflow
and per-step `modelFailover` override it.

Valid providers: `claude`, `opencode`, `codex`, `cursor`, `antigravity`, `amp`, `kiro`. An instance reuses its
provider's adapter; `binary` is only needed when the executable name differs
from the provider (e.g. a fork).

Running with `--config <file>` loads that file alone — the global layer is not
read, and global agent operations are unavailable.

The endpoints that direct-inference `llm` steps call are configured the same
way, under `apis` — see [API configuration](api-configuration.md).

## Model classes

Workflows may bind steps with `modelClass` (`thinker`, `ultrathinker`,
`implementer`, `reviewer`, `deep-reviewer`, `simple`, `balanced`) instead of a
concrete model. Override the preferred families in config:

```json
{
  "modelClasses": {
    "implementer": {
      "preferred": ["composer-2.5", "claude-sonnet-5", "gpt-5.3-codex"]
    }
  }
}
```

See [Model binding](model-binding.md) for aliases, reference agents, and
runtime failover.

## Slash commands

```
/agent list                                   # shows each agent's scope
/agent add <id> <provider> [binary]           # adds to the global config
/agent add <id> <provider> [binary] --project # adds to ./steamtrain.json
/agent enable <id> · /agent disable <id>      # writes to the agent's own scope
```

`enable`/`disable` accept `--global`/`--project` to force a scope; unconfigured
built-ins are written to the global file by default.

## Agent manager (TUI)

Press **Ctrl+A** from any screen (or run `/agents`) to open the agent manager:

- `↑/↓` select · `Enter`/`Space` enable/disable
- `a` add — a small form for id, provider, optional binary, and scope
- `d` delete a configured entry (built-in defaults can only be disabled)
- `r` recheck — re-run the preflight doctor (pick up a just-installed CLI or a
  fresh login without restarting)
- `Esc` close

Each row shows the agent's **live readiness** (`ready`, `needs sign-in`, `not
installed`, `error`) with its version when ready, plus scope (`global`,
`project`, or `builtin`), enabled state, provider, and binary. Selecting an
agent that isn't ready shows its fix inline — the install or login command —
so getting set up never means leaving the manager to hunt for the command. The
header carries a one-line readiness summary (`3/5 ready · 1 sign-in`).

## Web UI

Every agent's live readiness is a **health chip** in the header. Click any chip
(green or red) to open the **Agent & API setup** panel: the browser analog of
`steamtrain init`'s readiness table — each agent and API with its status,
version/binary, and, for anything not ready, the exact fix with a one-click
**Copy**. **Recheck** re-runs the doctors in place; **Edit config →** jumps to
the config editor. Agents that simply aren't installed collapse into one quiet
chip instead of a wall of red, so the header stays calm on a fresh machine.

The config page (gear icon) edits configured agents with a per-row **scope**
selector, and links back to the setup panel via **Check readiness & fixes →**.
New agents default to **global** (`~/.steamtrain/config.json`), matching
`/agent add` and the TUI manager. Choose **project** to write into
`./steamtrain.json` instead. Timeouts on the same page still save to the
project file.
