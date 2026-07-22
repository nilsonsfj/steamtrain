# Mainline pipeline — one prompt in, one reviewed PR out

`mainline` is the bundled workflow that shows off the whole engine at once:
a planner splits your prompt into independent streams, each stream is
implemented and review/fix/test-looped **in its own worktree, in parallel**,
the streams are merged by an agent, the merged result gets one more
review/fix/test pass, and a PR opens — with every out-of-scope bug anyone
noticed along the way filed as a GitHub issue (or written up as a report).

```
$ steamtrain workflow run mainline --input "add rate limiting to the /upload and /export endpoints"
```

## What it does

```
                         ┌─────────────────────────────────────────┐
                         │              plan (1 agent)              │
                         │  splits the prompt into ≤ maxStreams     │
                         │  independent, self-contained charters    │
                         └───────────────────┬───────────────────────┘
                                              │ forEach stream
              ┌───────────────────────────────┼───────────────────────────────┐
              ▼                               ▼                               ▼
   ┌─────────────────────┐        ┌─────────────────────┐        ┌─────────────────────┐
   │  mainline-stream #1  │        │  mainline-stream #2  │        │  mainline-stream #3  │
   │  implement            │        │  implement            │        │  implement            │
   │    ↓                  │        │    ↓                  │        │    ↓                  │
   │  review ─┐             │        │  review ─┐             │        │  review ─┐             │
   │    ↓     │loop         │        │    ↓     │loop         │        │    ↓     │loop         │
   │  fix     │until        │        │  fix     │until        │        │  fix     │until        │
   │    ↓     │clean        │        │    ↓     │clean        │        │    ↓     │clean        │
   │  test ───┘             │        │  test ───┘             │        │  test ───┘             │
   │  (own worktree)        │        │  (own worktree)        │        │  (own worktree)        │
   └───────────┬─────────────┘        └───────────┬─────────────┘        └───────────┬─────────────┘
               └───────────────────────────────────┼───────────────────────────────────┘
                                                     ▼
                                  ┌───────────────────────────────────┐
                                  │   integrate — merge (mode: worktree)│
                                  │   agent resolves conflicts, if any  │
                                  └───────────────────┬───────────────────┘
                                                        ▼
                                  ┌───────────────────────────────────┐
                                  │  final-review ─┐                   │
                                  │       ↓         │ loop until       │
                                  │  final-fix       │ clean + tests   │
                                  │       ↓         │ pass             │
                                  │  final-test ────┘                   │
                                  │  (attached to the merged worktree)  │
                                  └───────────────────┬───────────────────┘
                                                        ▼
                             ┌──────────────────────────┴──────────────────────────┐
                             ▼                                                       ▼
                  deliver-pr / deliver-branch                              file-issues
                  opens a PR (or leaves a branch)                (out-of-scope findings, batched)
                             │                                                       │
                             └──────────────────────────┬──────────────────────────┘
                                                          ▼
                                                    arrival report
```

Every "loop until clean" box above is a `mainline-stream`-style nested gate
pair: a `test-gate` (tests must pass) then a `review-gate` (reviewer verdict
must be `"clean"`), both bounded to 4 iterations, both `onFalse: "continue"`
— a stream that never fully converges still lands its best-effort work rather
than failing the whole pipeline; the arrival report and summaries say so
honestly.

`mainline-stream` (the inner box) is also a complete workflow on its own —
run it directly with a plain task description as `{{input}}` when you don't
need the planning/merge machinery around it.

## How to run it

**CLI:**

```
steamtrain workflow run mainline --input "your task" \
  --param coderModel=opencode/mimo-v2.5-free \
  --param reviewerModel=opencode/nemotron-3-ultra-free
```

Every input has a default (see [Model tiers](#model-tiers) below), so it also
runs with zero params — keyless, on OpenCode Zen's free tier — as a way to
try the shape of the pipeline before spending real budget on it.

**TUI:** `steamtrain` → pick `mainline` from the workflow list → the input
form shows every declared input with its description and default; fill in
what you want to override and run.

**Web UI:** the same input form, plus live progress across every parallel
stream, the merge, the final loop, and the delivered PR link.

## Model tiers

`mainline` and `mainline-stream` template every `model`/`effort` field
(`{{inputs.coderModel}}`, etc.) — one spec, several cost/quality tiers, no
forking. Those params are `type: "model"` with declared `fallbackModels`, so
the TUI/web Variables form offers catalog autocomplete and a quota hit mid-run
walks the safety net instead of failing the step. Substitute your own
gateway's model ids in each agent's own format (`opencode/...`, `claude-...`,
plain codex slugs, …); the ones below are illustrative.

| tier | planner | coder (per stream) | reviewer |
| --- | --- | --- | --- |
| **premium** | Claude Opus or Fable (via `claude`/`opencode`), high effort | Composer 2.5 / Grok 4.5 | Sonnet high-effort / GPT Terra high-effort |
| **balanced** | a strong mid-tier model, default effort | a fast, capable coding model | a careful reviewer model, default-to-high effort |
| **budget** | K3 / GLM 5.2 | MiMo 2.5 | DeepSeek Pro Max / Qwen Max |

Example command lines (fill in your gateway's actual ids):

```
# premium
steamtrain workflow run mainline --input "your task" \
  --param plannerModel=claude-opus-4-8 --param plannerEffort=high \
  --param coderModel=opencode/composer-2.5 \
  --param reviewerModel=opencode/gpt-5.5-pro --param reviewerEffort=high \
  --param mergeModel=claude-opus-4-8

# balanced
steamtrain workflow run mainline --input "your task" \
  --param coderModel=opencode/deepseek-v4-flash \
  --param reviewerModel=opencode/glm-5.1

# budget (the keyless default tier)
steamtrain workflow run mainline --input "your task" \
  --param plannerModel=opencode/glm-5 \
  --param coderModel=opencode/mimo-v2.5-free \
  --param reviewerModel=opencode/nemotron-3-ultra-free
```

`reviewerEffort`/`plannerEffort` default to `""`, which templated `effort`
treats as "omit the flag" (unlike `model`, an empty rendered `effort` is not
a failure) — leave them blank for agents/models with no effort concept.

## Issue filing

Every stream's implementer and reviewer, the planner, and the final reviewer
can all report **findings** — pre-existing, out-of-scope problems they
noticed but explicitly did NOT fix (scope discipline is baked into every
prompt: "implement ONLY this stream's charter"). Two independent choices
control what happens to them:

- `issueTiming`: `"end"` (default) batches every finding into one `file-issues`
  step in the final phase, after everything else has run. `"live"` files each
  stream's findings the moment that stream finishes, via a `stream-issues`
  step inside `mainline-stream` itself — useful for long-running pipelines
  where you want visibility before the whole thing completes.
- `issueMode`: `"report"` (default, zero side effects) renders a
  severity-ordered markdown report. `"github"` creates one GitHub issue per
  finding via `gh issue create`, after checking for (and skipping) an
  existing open-or-closed issue with the same title.

`issueMode: "github"` requires `gh` on `PATH` and authenticated
(`gh auth login`) against the target repo; missing/unauthenticated `gh` fails
the step with copy-paste setup guidance rather than silently doing nothing.
Findings are deduplicated across every source before filing, so the same
pre-existing bug noticed by three different streams becomes one issue.

## How the loops converge

Every review/fix/test loop in the pipeline (per-stream and final) is bounded
at 4 iterations and never hard-fails the run on hitting the cap
(`onFalse: "continue"`) — an unconverged stream still contributes its
best-effort worktree to the merge, and the summary/arrival report says
plainly whether it actually converged (`{{steps.review.json.verdict}}`,
`{{steps.test.exitCode}}`) rather than silently claiming success. This
mirrors the reasoning behind the `review-loop` fix (see
[`workflow-spec.md`](workflow-spec.md#workspace-attachstepid)): every step in
a loop `attach`es to the SAME worktree the implementer owns, so iteration 2's
review genuinely sees iteration 1's fix instead of a stale fork.

## How to adapt it

- **Swap the test command**: `--param testCmd="npm test"` (default `"true"`,
  the POSIX no-op, so the workflow validates and runs keyless with no test
  suite wired up — real usage should always override this).
- **Force a single stream**: the planner is instructed to prefer fewer
  streams when a task doesn't decompose cleanly, and `maxStreams` (default 3)
  is an upper bound, not a target — set `--param maxStreams=1` to force the
  planner to treat the whole task as one stream (skips the merge conflict
  surface entirely).
- **Land on a branch instead of a PR**: `--param deliver=branch` — the
  workflow ships both a `deliver-pr` and a `deliver-branch` merge step, gated
  by a `value` condition on `deliver`, so only one ever runs.
- **Run just one stream's pipeline**: `mainline-stream` is a complete,
  standalone workflow — `steamtrain workflow run mainline-stream --input "implement X"` skips
  planning and merging entirely.

## See also

- [`workflow-spec.md`](workflow-spec.md) — full field reference for every
  block this pipeline uses: `workspace: "attach:"`, merge `mode: "worktree"`,
  `workflow` step `forEach`/`params`/`worktreeStep`, gate `value` conditions,
  the `issues` step, templated `model`/`effort`.
- [`worktree-lifecycle.md`](worktree-lifecycle.md) — how the kept `integrate`
  worktree and every stream's worktree get garbage-collected.
- `src/workflow/bundled.ts` — the two specs themselves, `mainline` and
  `mainline-stream`, with inline authoring comments.
