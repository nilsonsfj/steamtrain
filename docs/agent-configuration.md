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
  "stepTimeoutSec": 600
}
```

Valid providers: `claude`, `opencode`, `codex`, `cursor`, `amp`. An instance reuses its
provider's adapter; `binary` is only needed when the executable name differs
from the provider (e.g. a fork).

Running with `--config <file>` loads that file alone — the global layer is not
read, and global agent operations are unavailable.

The endpoints that direct-inference `llm` steps call are configured the same
way, under `apis` — see [API configuration](api-configuration.md).

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
- `Esc` close

Each row shows the agent's scope (`global`, `project`, or `builtin`), enabled
state, provider, binary, and default model.

## Web UI

The config page (gear icon) edits configured agents with a per-row **scope**
selector. New agents default to **global** (`~/.steamtrain/config.json`),
matching `/agent add` and the TUI manager. Choose **project** to write into
`./steamtrain.json` instead. Timeouts on the same page still save to the
project file.
