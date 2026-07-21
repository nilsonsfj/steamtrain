# API configuration

API instances are the endpoints that direct-inference [`llm` steps](workflow-spec.md#llm-direct-api-inference)
call — the lightweight sibling of [agent instances](agent-configuration.md).
Where an agent instance wraps a coding-agent CLI (binary, env, extra args), an
API instance wraps one HTTP endpoint: its dialect, base URL, key env var,
default model, and pricing. They can be configured at the same two scopes:

| Scope   | File                        | When to use                                     |
| ------- | --------------------------- | ----------------------------------------------- |
| global  | `~/.steamtrain/config.json` | An API you want in every project (default)      |
| project | `./steamtrain.json`         | Project-specific overrides or team-shared setup |

Config merges as **defaults → global → project**. API entries merge by `id`:
a project entry with the same id replaces the global entry wholesale.

Four built-in instances exist with zero config, mirroring the built-in agents.
Two are the raw providers; two are popular OpenAI-compatible gateways preset
with their endpoint and key env, so you can reference them by id straight away:

- **`anthropic`** — the Anthropic Messages API, key from `ANTHROPIC_API_KEY`
- **`openai`** — the OpenAI chat-completions wire format, key from `OPENAI_API_KEY`
- **`openrouter`** — [OpenRouter](https://openrouter.ai) (`https://openrouter.ai/api/v1`),
  key from `OPENROUTER_API_KEY`; models use the `provider/model` id format
  (e.g. `openai/gpt-5.2`, `anthropic/claude-sonnet-4.6`)
- **`opencode-zen`** — [OpenCode Zen](https://opencode.ai/docs/zen/)
  (`https://opencode.ai/zen/v1`), key from `OPENCODE_API_KEY`. **Keyless**: its
  free models run with no key at all (e.g. `opencode/big-pickle`); set the key
  to use paid models and get higher rate limits.

An `apis` entry with one of those ids customizes the built-in (every bare llm
step of that provider then inherits it); any other id defines a new instance:

```json
{
  "apis": [
    { "id": "anthropic", "provider": "anthropic", "baseUrl": "https://my-gateway.corp/v1" },
    {
      "id": "groq",
      "provider": "openai",
      "baseUrl": "https://api.groq.com/openai/v1",
      "apiKeyEnv": "GROQ_API_KEY",
      "defaultModel": "llama-3.3-70b-versatile",
      "pricing": { "inputPerMTok": 0.59, "outputPerMTok": 0.79 }
    }
  ]
}
```

Fields (all optional except `id` and `provider`):

- **`provider`** — `"anthropic"` or `"openai"`. The `openai` dialect is what
  Groq, Together, Ollama, vLLM, and most proxies speak.
- **`enabled`** — defaults to true. Disabled instances are hidden outside
  config surfaces, and a workflow referencing one is blocked before dispatch.
- **`label`** — display name for config surfaces.
- **`baseUrl`** — endpoint override (OpenAI convention: include `/v1`). Unset
  means the conventional env override (`ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`),
  else the provider's public API.
- **`apiKeyEnv`** — env var holding the key. The key itself is **never stored
  in config** — only the variable name.
- **`keyless`** — when true, the endpoint serves models without a key: no auth
  header is sent and a missing key is not a readiness failure (set by the
  `opencode-zen` built-in; also useful for a local Ollama/vLLM server). A key is
  still used if the `apiKeyEnv` variable is set.
- **`defaultModel`** — used when a step referencing this instance omits `model`.
- **`pricing`** — per-MTok USD rates applied to steps on this instance that
  don't declare their own, so budgets and cost analytics see exact spend.

## Using an instance from a workflow

An `llm` step references an instance via `api` and inherits its settings; the
step's own fields (`model`, `apiKeyEnv`, `baseUrl`, `pricing`, `provider`)
override the instance's one by one:

```jsonc
{ "id": "judge", "kind": "llm", "api": "groq", "prompt": "Judge: {{input}}" }
```

With `api` set, `model` may be omitted when the instance has a `defaultModel`.
Steps without `api` keep the original behavior: provider inferred from the
model (`claude-*` → anthropic, else openai), resolved through the built-in
instance of that provider.

## Readiness: status bar, doctor, and dispatch gating

Enabled instances get the same treatment agents get from the doctor:

- **TUI status bar** shows each instance after the agents (`◆ anthropic ready`,
  `◇ openai no key`). "no key" is informational — it just means that provider
  is not set up.
- **Web health chips** appear next to the agent chips; `GET /api/doctor`
  returns them under `apis`.
- The check is: key env var set → probe the endpoint's models listing (5s
  timeout) → `ready` / `key rejected` / `unreachable`. A missing key never
  touches the network.
- **Dispatch gating:** a workflow with `llm` steps only starts when every step
  resolves to an enabled instance with a model and its key env var is set —
  the same fail-fast contract agent-backed workflows get from the doctor,
  minus any network dependency.

## Usage and cost attribution

Every `llm` step is attributed to its instance: live step cards and history
show `groq/llama-3.3-70b` exactly like `claude/claude-opus-4-8`, and
`steamtrain workflow costs` rolls llm spend up under the same `api/model`
keys — so "which endpoint is eating the budget?" has an answer.

## Slash commands

```
/api list                                     # shows each instance's scope + key status
/api add <id> <anthropic|openai> [baseUrl]    # adds to the global config
        [--key-env <env>] [--model <model>] [--project]
/api enable <id> · /api disable <id>          # writes to the instance's own scope
```

`enable`/`disable` accept `--global`/`--project` to force a scope; unconfigured
built-ins are written to the global file by default.

## API manager (TUI)

Run `/apis` from any screen to open the API manager:

- `↑/↓` select · `Enter`/`Space` enable/disable
- `a` add — a small form for id, provider, optional base URL / key env / default model, and scope
- `d` delete a configured entry (built-in defaults can only be disabled)
- `r` recheck — re-run the readiness probes (pick up a key you just exported
  without restarting)
- `Esc` close

Each row shows the instance's **live readiness** (`ready`, `no key`, `key
rejected`, `offline`, `error`), scope (`global`, `project`, or `builtin`),
enabled state, provider, key env var (and whether it is set), endpoint, and
default model. Selecting an instance that isn't ready shows its fix inline (for
a missing key, the `export <ENV>=…` scaffold). The header carries a one-line
readiness summary.

## Web UI

API endpoints appear as **health chips** in the header alongside the agents.
Click any chip to open the **Agent & API setup** panel (see
[agent configuration](agent-configuration.md#web-ui)), which lists every
endpoint with its status and, for anything not ready, the fix with a one-click
**Copy** — plus a **Recheck** that re-probes in place. Endpoints without a key
collapse into one quiet chip rather than shouting.

The config page (gear icon) has an **APIs** section mirroring the agents
section: add/remove instances, toggle enabled, pick **global** (default) or
**project** scope, and edit provider, base URL, key env var, default model,
and pricing. Saving writes each row to its chosen file and re-probes readiness
immediately.

Running with `--config <file>` loads that file alone — the global layer is not
read, and global API operations are unavailable (same as agents).
