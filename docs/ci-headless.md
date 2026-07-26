# CI & headless integration

Date: 2026-07-26

steamtrain's engine already runs headlessly (`steamtrain workflow run …` is the
same engine the TUI and web UI drive). This doc covers the two things a pipeline
needs on top of that: a **machine-readable report** and a **stable exit-code
contract**, plus the published **GitHub Action** that wraps both.

## Machine-readable reports

`workflow run` accepts `--report <format>` and writes the report when the run
settles — on success *and* on failure, so a failing run still produces an
artifact a pipeline can consume.

```bash
steamtrain workflow run bug-hunt --input "audit the parser" \
  --report junit --output report.xml
```

| Flag | Meaning |
| --- | --- |
| `--report json\|markdown\|junit` | Report format. |
| `--output <file>` (`-o`) | Write the report to a file. Omit to print it to stdout. |

Rules of thumb:

- `--output` is required to have meaning, so it is rejected without `--report`.
- `--report` without `--output` prints to stdout, which conflicts with the live
  `--json` event stream — combine them only when the report goes to a file.
- `--report` needs a foreground run, so it is rejected with `--detach`. Inspect a
  finished detached run with `workflow history show <id>` instead.

### Formats

- **`json`** — a self-describing `steamtrain.run-report` (v1) document: the
  outcome and exit code, run metadata (id, workflow, input, timing), rolled-up
  totals (steps ok/failed/cached, cost, tokens), the cost-budget breach if any,
  every phase and step, and a `failedSteps` array up front. Failed steps carry
  their truncated output so you can see the cause without parsing logs.
- **`markdown`** — a summary you can post as a PR comment or job step summary:
  an outcome badge, the totals line, the failed steps with their errors/output,
  and a per-step table.
- **`junit`** — one `<testsuite>` per phase and one `<testcase>` per step; a
  failed step is a `<failure>` and a gate rejection is tagged
  `type="GateFailure"`. Feed it to any JUnit reporter (e.g.
  [`mikepenz/action-junit-report`](https://github.com/mikepenz/action-junit-report)).

## Exit-code contract

`workflow run` exits with a stable code that distinguishes *why* a run failed,
so a pipeline can branch without parsing output. The same classification drives
the report's `outcome` field, so the two always agree.

| Code | Outcome | Meaning |
| --- | --- | --- |
| `0` | `success` | The run completed and every step passed. |
| `1` | `step-failed` | A worker/processor/command/llm step errored. |
| `2` | `gate-failed` | A quality gate (or approval checkpoint) rejected the run. |
| `3` | `timeout` | The whole-workflow wall-clock budget (`timeoutSec`) elapsed. |
| `4` | `budget-exceeded` | A cost cap (workflow- or step-level `maxCostUsd`) was hit. |
| `130` | `canceled` | The run was canceled (Ctrl+C / SIGTERM / `workflow cancel`). |

Notes:

- A gate with `onFalse: "stop"` is a *graceful* halt, not a rejection — it does
  not produce exit `2`. Only `onFalse: "fail"` (and a rejected approval
  checkpoint, which the engine records as a gate) does.
- `timeout` and `canceled` both abort the run; the timeout timer is distinguished
  from a user cancel so they settle to different codes (`3` vs `130`).
- Usage errors (unknown workflow, bad flags) exit `1` before a run starts and
  produce no report.

```bash
if steamtrain workflow run bug-hunt --input "$DIFF" --report junit -o report.xml; then
  echo "passed"
else
  case $? in
    2) echo "gate rejected the findings" ;;
    3) echo "timed out" ;;
    4) echo "ran out of budget" ;;
    *) echo "step failure" ;;
  esac
fi
```

## GitHub Action

[`steamtrain/run-workflow`](../run-workflow/README.md) wraps the above for
GitHub Actions: it builds steamtrain, runs a workflow headlessly, publishes the
report as an artifact, writes a job summary, and exposes `exit-code` / `outcome`
/ `report-path` outputs.

```yaml
- uses: nilsonsfj/steamtrain/run-workflow@v1
  with:
    workflow: bug-hunt
    input: "Find bugs introduced or exposed by this PR's diff."
    report: junit
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

See the [action README](../run-workflow/README.md) for the full input/output
reference and the bug-hunt-on-every-PR example.
