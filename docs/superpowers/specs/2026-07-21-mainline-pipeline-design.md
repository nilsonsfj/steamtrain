# Mainline pipeline — plan → parallel streams → reviewed merge → PR (+ issues)

Status: implementing
Date: 2026-07-21

## The use-case

One prompt in, one reviewed PR out — with every side-discovery filed:

1. A **high-intelligence planner** breaks the incoming prompt into independent
   **execution streams** (e.g. Opus, GPT Sol, Fable; or K3 / GLM 5.2 on a
   budget).
2. Each stream runs **in parallel in its own worktree** on a **cheap, strong
   coding model** (e.g. Composer 2.5, Grok 4.5, MiMo 2.5).
3. Each stream is **code-reviewed in a loop** by a **high-effort reviewer**
   (e.g. Sonnet high-effort, GPT Terra high-effort, DeepSeek Pro Max, Qwen
   Max): review → fix → test → review, until clean.
4. When all streams are done, an **LLM-assisted merge** integrates them (agent
   resolves any conflicts).
5. The **merged result** goes through the same review/fix/test loop once more,
   as a single stream.
6. A **PR is created** from the final state.
7. **Out-of-scope pre-existing bugs** noticed anywhere along the way are
   documented as GitHub issues — either batched at the end alongside the PR,
   or filed live as each stream finds them.

The existing engine covers most of this (distributors, forEach fan-out,
worktree isolation, loop gates, merge with agent conflict resolution, PR
mode). This spec defines the missing building blocks, each independently
useful, plus two bundled workflows (`mainline`, `mainline-stream`) that
compose them into the full pipeline.

## Gap analysis (why each block is needed)

| Requirement | Existing mechanism | Gap |
| --- | --- | --- |
| Per-stream implement→review→fix→test loop in ONE worktree | `workspace: "inherit:<id>"` copies the source worktree | Copies fork state: in a loop, iteration 2's review inherits the pre-fix state again — fixes made in a later step's copy never persist. (This is a live convergence flaw in the bundled `review-loop`.) |
| N parallel streams, each a whole pipeline | `forEach` on worker/processor/llm | A stream is a multi-step loop, not one step. `workflow` call steps exist but can't fan out, can't receive parameters, and hide their worktrees from `merge`. |
| Merge streams, then keep working on the merged state | merge modes `apply`/`branch`/`pr` | No mode leaves a *worktree* that later steps can attach to for the final review loop. |
| File out-of-scope findings as GitHub issues | — | No findings channel and no step kind that creates issues. |
| One workflow spec, user-selectable model tiers | `inputs` + `{{inputs.*}}` in prompts | `model`/`effort` fields are not templated, so tiers would require forked specs. |
| Gate/skip on an input parameter | `when` conditions test a step output or the run input | No way to test `{{inputs.<key>}}` directly. |

## Building block 1 — `workspace: "attach:<stepId>"`

A second workspace mode alongside `inherit`. Where `inherit` **copies** the
source step's worktree state into a fresh worktree, `attach` runs the step
**inside the source step's own worktree** — no copy, no new branch. This is
the "stream worktree": implement owns the worktree; review, fix, and test all
attach to it; loop iterations naturally see each other's changes, so a
review/fix loop actually converges.

Semantics:

- Syntax: `workspace: "attach:<stepId>"` on worker/processor/command steps.
- The source becomes an implicit dependency exactly like `inherit` (scheduled
  after, skip/fail cascade, template lint).
- Valid sources: worker/processor/command steps without `forEach`; a `merge`
  step with `mode: "worktree"` (block 2); a `workflow` call step with
  `worktreeStep` and no `forEach` (block 3).
- The attached step's lease is the source's recorded worktree: same `root`,
  `branch`, `baseCommit`; `cwd` is the step's resolved cwd re-rooted into the
  worktree (same relative-path logic as allocation). Its `result.worktree`
  records that same info, so templates, `history show --diff`, and `merge`
  all see it.
- When the source ran without isolation (no git repo / no workspace manager),
  the attacher runs in the plain cwd too — same degradation as `inherit`.
- If the source's worktree no longer exists (pruned), the step fails with the
  same guidance message shape as inherit.
- **Ordering**: two steps must never run concurrently in one worktree.
  Validation requires that all steps attaching to the same source (in their
  spec order) form a strict chain: each attacher must be reachable from the
  previous attacher (and the first from the source) via `dependsOn` edges,
  counting implicit workspace/session/forEach dependencies. Violations are a
  spec validation error naming both steps. (Loop iterations are sequential by
  construction, so loops need no extra rule.)
- Merge steps dedupe sources by worktree **root** (block 2), so `from` can
  name any member of an attach group without double-merging.
- Cache/replay: identical to inherit — a cached attacher replays; a fresh run
  whose source worktree is gone re-runs the chain.

`inherit` remains for fan-in-free handoffs where forked copies are the point
(e.g. speculative branches). Docs position `attach` as the loop-safe default
for review/fix pipelines, and the bundled `review-loop` is fixed to use it.

## Building block 2 — merge `mode: "worktree"`

A fourth merge delivery mode: merge the source worktrees into a **kept**
staging worktree and record it as the merge step's own `result.worktree`
(`root`, `branch` — a `steamtrain/<runId>/…` branch, `baseCommit` = the
pre-merge target HEAD). Nothing lands in the user's checkout.

- The staging worktree lives under the same worktree base dir as agent
  worktrees (not a tmpdir that vanishes), following the existing naming
  scheme, and is retained after the run like any other step worktree (GC via
  the existing prune paths).
- Later steps may `workspace: "attach:<mergeStep>"` (or `inherit:`) — this is
  the final single-stream review loop.
- A later `merge` step may list a `mode: "worktree"` merge step (or any step
  attached to it) in `from`: its recorded worktree harvests exactly like an
  agent step's (diff base = its recorded `baseCommit`).
- `executeMergeStep` dedupes collected sources by worktree root before
  harvesting (needed for attach groups; harmless otherwise).
- Validation: `branch` may be set (names the kept branch); `perSource` with
  mode "worktree" is rejected (one kept worktree is the point); `cleanup`
  still prunes the *source* worktrees only.
- Template lint / workspace-source allowlists updated so a worktree-mode
  merge step is a legal workspace source and `{{steps.<id>.worktree.*}}`
  target.
- Validation cannot always know the mode statically (mode is a literal field,
  so it can): only `mode: "worktree"` merge steps are legal workspace
  sources; attaching to an `apply`/`branch`/`pr` merge is a validation error.

## Building block 3 — `workflow` call step upgrades

Three additions that make a sub-workflow behave like a first-class step:

1. **`forEach: "steps.<id>.items"`** — run the child workflow once per item
   of an earlier distributor/llm splitter, in parallel under
   `maxConcurrency`, mirroring worker `forEach` (fan_out event, generated
   child ids `<stepId>[i]`, per-child `{{item}}` available in the `input` and
   `params` templates, parent result aggregates `childResults`, per-child
   failure semantics matching worker fan-outs). Each child run's leaf results
   fold in namespaced as today.
2. **`params: Record<string, string>`** — templated values passed as the
   child run's declared inputs. Rendered with the parent's template context
   (including `{{item}}` under forEach), then validated with the child's
   `resolveInputs`; validation errors fail the step with the child's error
   text. Unknown-param and missing-required errors surface exactly like CLI
   `--param` errors.
3. **`worktreeStep: "<childStepId>"`** — the named child step's recorded
   worktree surfaces as this step's own `result.worktree`. With `forEach`,
   each generated child's result carries its own surfaced worktree, so a
   `merge` step whose `from` names the fan-out parent harvests one worktree
   per stream (the existing leaf-walk in `executeMergeStep` already does
   this once leaves carry worktrees). Like `outputStep`, it is resolved at
   run time; a nonexistent child step id or a child step that recorded no
   worktree fails the workflow step with a clear error. When the named child
   result carries a worktree AND `childResults`, consumers use the surfaced
   worktree (merge prefers `leaf.worktree` at the level it inspects — no deep
   descent).

MAX_STEPS budgeting: a `forEach` workflow step counts its static-item
expansion like worker fan-outs (unknown dynamic counts stay bounded by the
run-time cap, as today). Cycle/depth guards apply per generated child run.

## Building block 4 — `GateCondition.value`

`value?: string` — a templated text expression evaluated and tested by the
existing `contains`/`matches`/`equals` predicates, instead of a step output
or the run input. Mutually exclusive with `step`, `ok`, `path`, and `human`.

The canonical use is input-driven routing: `when: { value:
"{{inputs.issueTiming}}", equals: "live" }`. Works everywhere a
`GateCondition` works (gates and per-step `when`). Template lint checks the
refs inside `value` like other condition text fields.

## Building block 5 — templated `model` / `effort`

`model` and `effort` on agent-backed steps (worker/processor, agent-backed
distributor/consolidator, merge conflict agents) and `llm` steps render
through the standard template pipeline at execution time — enabling
`model: "{{inputs.coderModel}}"` so one spec serves every cost tier.

- Rendered with the step's full template context (inputs, step outputs, item,
  iteration).
- A model that renders empty fails the step with a clear message (never
  silently launches a default).
- Everything downstream sees the **rendered** value: cache keys, cost/pricing
  lookup, `step_start` events, recorded results, doctor variant checks.
- `agent` stays static (doctor preflight and autonomy labeling are
  spec-static on purpose).

## Building block 6 — `issues` step kind

Documents out-of-scope findings — as GitHub issues or as a report.

```jsonc
{
  "id": "file-issues",
  "kind": "issues",
  "from": ["plan", "streams", "final-review"],   // default: dependsOn
  "findingsPath": "findings",                    // path into each source's json
  "mode": "report",                              // "report" | "github" (templated)
  "titlePrefix": "[mainline]",
  "labels": ["from-steamtrain"],
  "repo": "owner/name",                          // optional, gh -R
  "limit": 20                                    // max issues created (default 20)
}
```

- **Findings channel**: any step that declares an `output` schema with a
  findings array participates. The issues step walks each `from` source
  (descending one level into `childResults` leaves — fan-out children and
  sub-workflow surfaces — skipping skipped/notRun leaves; a failed source
  fails the step, mirroring merge semantics), reads `json` at `findingsPath`,
  and accepts items that are objects (`title` required; `body`, `severity`,
  `file`, `line` optional) or plain strings (treated as titles). Sources
  without structured output or without the path contribute nothing (not an
  error — a clean run has no findings).
- **Dedupe**: case-insensitive normalized `title` + `file` fingerprint across
  all sources.
- **`mode: "report"`** (default): output is a severity-ordered markdown
  report; `json` = `{ findings, created: [], skippedExisting: [] }`. Zero
  side effects — the safe default.
- **`mode: "github"`**: creates one issue per finding via `gh issue create`
  (title = `titlePrefix` + title; body = finding body + provenance:
  workflow/run/source step, `file:line`, severity; `--label` per label,
  `-R repo` when set). Before creating, checks for an existing issue with the
  same title (`gh issue list --search`, state all) and skips duplicates,
  recording them in `skippedExisting`. Missing `gh` or auth failure fails the
  step with copy-paste guidance. Creation stops at `limit` and reports the
  truncation. `json.created` = `[{ title, url }]`.
- `mode` is a template (rendered, then validated ∈ {report, github}) so a
  single spec can switch modes via an input.
- No agent, no worktree, no cost. Runs `gh` from the run's base cwd (or
  `repo`). Autonomy-neutral. Never cached in github mode (side-effectful —
  mirror the approval no-cache flag) — a resumed run re-runs it; report mode
  caches normally.
- **Timing flows**: batch-at-end = one issues step in the final phase of the
  parent workflow; as-it-goes = an issues step inside the per-stream child
  workflow (gated by a `value` condition on an input). Both bundled.

## Bundled workflows

### `mainline-stream` (the per-stream pipeline; also useful standalone)

Inputs: `stream` (charter text/JSON; defaults to `{{input}}` passthrough),
`agent` is fixed per step (default `opencode` free-tier models so it runs
keyless), `coderModel`, `reviewerModel`, `reviewerEffort`, `testCmd`
(default `"true"`), `issueTiming` (`end`|`live`, default `end`), `issueMode`
(`report`|`github`, default `report`), `maxLoops`.

Phases:

1. **implement** — worker, `{{inputs.coderModel}}`, implements the stream
   charter; owns the stream worktree. Output schema `{ summary, findings }`
   (out-of-scope discoveries while implementing).
2. **review** — worker `attach:implement`, `{{inputs.reviewerModel}}` +
   `{{inputs.reviewerEffort}}`; reviews the worktree diff; output schema
   `{ verdict: "clean"|"issues", issues: [...], findings: [...] }` where
   `findings` are strictly out-of-scope pre-existing problems.
3. **fix** — worker `attach:implement`, coder model; fixes the listed issues
   (instructed to no-op when the verdict was clean).
4. **test** — command `attach:implement`, `{{inputs.testCmd}}`.
5. **test-gate** — loop gate: `{ step: "test", ok: true }`, `loopTo:
   review-phase`, bounded by `maxLoops`.
6. **review-gate** — loop gate: `{ step: "review", path: "verdict", equals:
   "clean" }`, `loopTo: review-phase` (properly nested with test-gate).
7. **stream-issues** — `issues` step, `when: { value:
   "{{inputs.issueTiming}}", equals: "live" }`, `from: ["implement",
   "review"]`, `mode: "{{inputs.issueMode}}"`.
8. **summary** — agentless consolidator: charter, iterations, verdict,
   findings count.

The child's `review` step is the parent's `outputStep` (carries findings
json); `implement` is the `worktreeStep` (carries the whole stream's work).

### `mainline` (the full pipeline)

Inputs: `plannerModel`, `plannerEffort`, `coderModel`, `reviewerModel`,
`reviewerEffort`, `mergeModel`, `maxStreams` (default 3), `testCmd`,
`issueTiming` (`end`|`live`), `issueMode` (`report`|`github`), `deliver`
(`pr`|`branch`, default `pr`), `maxLoops`. Defaults use OpenCode Zen free
models so the workflow validates and runs keyless; the docs carry a tier
table mapping premium/balanced/budget choices.

Phases:

1. **plan** — agent-backed distributor, `{{inputs.plannerModel}}` +
   `{{inputs.plannerEffort}}`: explores the repo, splits the prompt into at
   most `maxStreams` *independent* streams with minimal file overlap; output
   schema `{ streams: [{ title, charter }], findings }`, `itemsPath:
   "streams"`.
2. **streams** — `workflow` step → `mainline-stream`, `forEach:
   "steps.plan.items"`, `input: "{{item}}"`, `params` forwarding
   coder/reviewer/test/issue inputs, `outputStep: "review"`, `worktreeStep:
   "implement"`.
3. **integrate** — merge, `from: ["streams"]`, `mode: "worktree"`,
   `onConflict: "agent"` with `{{inputs.mergeModel}}`.
4.–6. **final review loop** — `final-review` (attach:integrate, reviewer),
   `final-fix` (attach:integrate, coder), `final-test` (command,
   attach:integrate), then the nested test/review loop gates, exactly like
   the stream loop.
5. **deliver** — merge, `from: ["final-fix"]` (same root as integrate after
   dedupe), `mode: "pr"` (or branch via input… mode itself is a literal, so
   the bundled spec ships `pr`; `deliver` input gates a `when` between a pr
   merge step and a branch merge step), templated `prTitle`/`prBody`
   summarizing the plan and streams. In parallel: **file-issues** — `issues`
   step, `when: { value: "{{inputs.issueTiming}}", equals: "end" }`, `from:
   ["plan", "streams", "final-review"]`, `mode: "{{inputs.issueMode}}"`.
6. **arrival** — agentless consolidator: streams table, merge summary, PR
   URL, issues filed.

### `review-loop` fix

`review` and `fix` switch from `inherit` chains to `attach:impl`, and the
merge `from` stays the tail (`fix`, deduped to impl's root). Iteration 2's
review now actually sees iteration 1's fixes — the loop converges on real
state.

## Surfaces to update

- `types.ts` (schemas, kinds, validation incl. attach ordering + new
  allowlists), `engine.ts`, `worktree.ts`, `merge.ts`, new `issues.ts`.
- `template.ts` lint (attach refs, value conditions, model/effort refs).
- `reducer.ts` + regenerated web bundle, `narration.ts`, `catalog.ts`,
  `autonomy.ts`, `plan.ts`, `cost.ts`, `arrival-report.ts`, `overrides.ts`
  (mid-run edit surface for new fields), `generate.ts`/authoring prompt
  (teach `workflow create` the new blocks), TUI step editor/details/preview,
  web `app.js` (kind styling, worktree mode, issues rendering).
- Docs: `workflow-spec.md`, `workflow-overview.md`, `workflow-examples.md`,
  `worktree-lifecycle.md`, `worktree-merge-back.md`, README (workflow table +
  a "Mainline" section), new `docs/mainline-pipeline.md` (use-case guide with
  the model-tier table).
- Tests for every block (spec validation, engine behavior with the fake/
  agentless deps used by existing tests, merge worktree mode, issues step
  with a stubbed `gh`, workflow forEach/params/worktreeStep, template
  rendering of model/effort, value conditions, review-loop convergence).
