# steamtrain/run-workflow

Run a [steamtrain](https://github.com/nilsonsfj/steamtrain) workflow headlessly
in GitHub Actions and publish a machine-readable report. The job fails with a
**stable, documented exit code** that tells you *why* a run failed — a step
error, a quality-gate rejection, a timeout, or a cost-budget breach — so a
pipeline can branch on the outcome without parsing logs.

```yaml
- uses: nilsonsfj/steamtrain/run-workflow@v1
  with:
    workflow: bug-hunt
    input: "audit the parser for memory-safety bugs"
    report: junit
```

## The killer demo: bug-hunt on every PR

Drop this into `.github/workflows/bug-hunt.yml` and every pull request gets an
agent-driven audit, with the findings reported as JUnit (so they show up in your
CI test reporter) and the raw run attached as an artifact:

```yaml
name: bug-hunt

on:
  pull_request:

jobs:
  bug-hunt:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - uses: nilsonsfj/steamtrain/run-workflow@v1
        with:
          workflow: bug-hunt
          input: "Find bugs introduced or exposed by this PR's diff."
          report: junit
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

The step fails (exit `1`/`2`) when the workflow's own gate decides the findings
are blocking, and passes (exit `0`) when it signs off — wire it into required
status checks to gate merges on it.

## Prerequisites

The action builds steamtrain from this repository and runs it on the runner.
Workflows whose steps spawn an agent CLI (`claude`, `opencode`, `codex`, …)
need that CLI installed and authenticated on the runner — typically an API key
secret in `env:` (as above). Agentless workflows (only
`distributor`/`consolidator`/`gate` steps) need no agent at all.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `workflow` | *(required)* | Workflow name from `steamtrain.json` or the bundled catalog. |
| `input` | *(required)* | The workflow input text (`{{input}}`). |
| `params` | `""` | Input params, one `key=value` per line → `--param key=value`. |
| `config-file` | `""` | Custom `steamtrain.json` path → `--config-file`. |
| `project-dir` | `""` | Operate on another directory → `--project-dir`. |
| `report` | `junit` | Report format: `json`, `markdown`, or `junit`. |
| `report-path` | `steamtrain-report.<ext>` | Where to write the report (`<ext>` follows the format). |
| `approve-all` | `true` | Auto-approve human checkpoints (unattended CI). `false` auto-rejects and stops. |
| `agent` | `""` | Re-route steps whose pinned agent is not ready → `--agent`. |
| `fresh` | `false` | Ignore/delete the step cache for this run → `--fresh`. |
| `extra-args` | `""` | Extra raw args appended verbatim to `workflow run`. |
| `upload-artifact` | `true` | Upload the report as the `steamtrain-report` artifact. |

## Security Considerations

The `extra-args` input is word-split and injected directly into the action's
shell.  **Never populate `extra-args` from untrusted input.**  In fork-based
`pull_request` workflows, a malicious contributor can set `extra-args` to
`'--fresh; rm -rf /'` (or any arbitrary shell command) to execute code on the
runner.

Typical mitigation options:

- Restrict the workflow to `pull_request_target` instead of `pull_request`
  (runs in the base repo context, not the fork).
- Use GitHub's `pull_request` → `pull_request_target` pattern with an explicit
  checkout of the PR ref *after* the action step.
- Limit who can trigger the workflow (`if: github.actor == '…'`) or gate on
  trusted team membership.

For trusted workflows where only maintainers can edit the workflow file
(`push` to `main`, `workflow_dispatch`, …), `extra-args` is safe.

## Outputs

| Output | Description |
| --- | --- |
| `exit-code` | The steamtrain process exit code (contract below). |
| `outcome` | `success`, `step-failed`, `gate-failed`, `timeout`, `budget-exceeded`, or `canceled`. |
| `report-path` | Absolute path to the generated report file. |

## Exit-code contract

The exit code is stable so a pipeline can branch on *why* a run failed:

| Code | Outcome | Meaning |
| --- | --- | --- |
| `0` | `success` | Every step passed. |
| `1` | `step-failed` | A worker/processor/command/llm step errored. |
| `2` | `gate-failed` | A quality gate / approval checkpoint rejected the run. |
| `3` | `timeout` | The whole-workflow wall-clock budget elapsed. |
| `4` | `budget-exceeded` | A cost cap (`maxCostUsd`) was hit. |
| `130` | `canceled` | The run was canceled. |

Example: treat a gate rejection as a soft signal but a step error as hard:

```yaml
- id: hunt
  uses: nilsonsfj/steamtrain/run-workflow@v1
  continue-on-error: true
  with:
    workflow: bug-hunt
    input: "audit the diff"

- name: Fail the build on a step error (but not a gate rejection)
  if: ${{ steps.hunt.outputs.outcome == 'step-failed' || steps.hunt.outputs.outcome == 'timeout' }}
  run: exit 1
```

## Report formats

- **`junit`** — one `<testsuite>` per phase, one `<testcase>` per step; a failed
  step is a `<failure>` (a gate rejection is tagged `type="GateFailure"`).
  Publish with any JUnit reporter, e.g.
  [`mikepenz/action-junit-report`](https://github.com/mikepenz/action-junit-report).
- **`json`** — a self-describing `steamtrain.run-report` document: outcome, exit
  code, run metadata, totals, and every phase/step (failed steps carry their
  truncated output so you can see the cause without digging through logs).
- **`markdown`** — a ready-to-post summary with an outcome badge, totals, the
  failed steps, and a per-step table. Append it to `$GITHUB_STEP_SUMMARY` or post
  it as a PR comment.

## See also

- [`docs/ci-headless.md`](../docs/ci-headless.md) — the CLI flags behind this
  action (`--report`, `--output`) and the full exit-code contract.
- [steamtrain docs](../docs/README.md) — workflow authoring, budgets, and the
  bundled workflows.
