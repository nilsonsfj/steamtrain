# Per-step tool permissions and sandbox profiles

Every agent step used to run with whatever powers its CLI grants by default —
which, for a headless coding agent, is usually *everything*. A "critique this
plan" step could rewrite the repository exactly like an "implement it" step
could. Worktree isolation kept those writes out of your checkout, but nothing in
the spec expressed the difference, and nothing enforced it.

A step can now declare what it is allowed to do:

```json
{
  "id": "review",
  "kind": "worker",
  "model": "sonnet 5",
  "workspace": "attach:implement",
  "permissions": "read-only",
  "prompt": "Review the diff in this worktree. Report issues; change nothing."
}
```

`permissions` is a promise the engine keeps in three independent ways:

1. **Translation** — each adapter maps the profile onto its CLI's native
   permission flags (`claude --permission-mode` + tool allow/deny lists,
   `codex --sandbox`, opencode's read-only `plan` agent).
2. **Refusal** — a step whose agent cannot enforce the profile does not run.
   You get a dispatch-time error naming the step and the agent, not a lock icon
   over an unrestricted process.
3. **Verification** — after a `read-only` step finishes, steamtrain compares its
   workspace against a fingerprint taken before the agent started. If anything
   changed, the step *fails* — whatever the CLI claimed to allow.

---

## The three profiles

| profile | may read | may write files | shell | network | verified afterwards |
| --- | --- | --- | --- | --- | --- |
| `read-only` | yes | **no** | **no** (or sandboxed read-only FS) | **no** | yes |
| `edit` | yes | yes, inside its own workspace | sandboxed only | **no** | no |
| `full` | yes | yes | yes | yes | no |

- **`read-only`** — the profile for reviewers, critics, judges, planners,
  scanners, and anything whose product is an opinion. Where the CLI has a real
  sandbox this is enforced as a read-only filesystem with networking off
  (`codex --sandbox read-only`); where it has tool lists instead, as read/search
  tools with writes, shell, and network denied (claude).
- **`edit`** — read plus write inside the step's own workspace, and nothing
  else. Enforceable on claude and codex.
- **`full`** — the one profile that *grants* rather than restricts. It
  pre-approves everything the CLI offers so an implement step never stalls on a
  permission prompt it cannot answer headlessly (claude gets
  `--permission-mode bypassPermissions`, codex `--sandbox danger-full-access`).

**Omitting `permissions` is not the same as `full`.** An undeclared step keeps
the historical behavior exactly: no permission flags are passed, and nothing is
verified. `full` is an explicit statement, and it changes the flags.

## The object form

```json
"permissions": {
  "profile": "read-only",
  "allow": ["Bash(npm test:*)"],
  "deny": ["WebFetch"],
  "onUnsupported": "fail",
  "verify": true
}
```

| field | default | meaning |
| --- | --- | --- |
| `profile` | — | `"read-only"`, `"edit"`, or `"full"`. Required. |
| `allow` | `[]` | Extra tool patterns to allow on top of the profile, in the agent's own syntax. A read-only reviewer that must run one specific command declares it here instead of dropping to `full`. |
| `deny` | `[]` | Tool patterns denied regardless of profile — deny always wins. Use it to carve dangerous tools out of `full` (`["Bash(git push:*)"]`). |
| `onUnsupported` | `"fail"` | What to do when the step's agent cannot enforce the profile. `"fail"` refuses to launch the step; `"warn"` runs it, records the gap, and leaves post-run verification as the only guard. |
| `verify` | `true` for `read-only` | Check after the run that the step's workspace is byte-identical. Meaningless for the other profiles, which may write. |

`allow`/`deny` map to real flags on claude only. On codex, opencode, and mimo
they are advisory: the profile is still enforced by the sandbox / agent, and the
gap is reported as partial enforcement rather than silently ignored.

## Which agents can enforce what

| agent | `read-only` | `edit` | `full` | mechanism |
| --- | --- | --- | --- | --- |
| `claude` | native | native | native | `--permission-mode` + `--allowedTools`/`--disallowedTools` |
| `codex` | native | native | native | `--sandbox read-only` / `workspace-write` / `danger-full-access` |
| `opencode` | native | — | native | `--agent plan` (built-in read-only agent) |
| `mimo` | native | — | native | same CLI surface as opencode |
| `amp`, `cursor`, `kimi`, `kiro`, `antigravity` | — | — | native | headless runs are all-or-nothing; no flag takes powers back |

`full` is satisfiable everywhere — there is nothing to enforce. The restricted
profiles are where agents differ, and the table is the reason
`onUnsupported: "fail"` is the default: a promise nobody can keep is worse than
no promise.

The TUI's `/agents` manager shows each agent's enforceable profiles
(`perms=read-only/edit`), so you can pick an agent for a locked-down step
without leaving the terminal.

## Where the default comes from

Layers, most specific first. Whichever layer wins owns the whole decision — they
do not merge field by field, so reading one step tells you exactly what it can
do:

1. the step's own `permissions`
2. the workflow's top-level `permissions`
3. a `workflow` call step's `permissions` (for the child run it starts)
4. the project/user config's `permissions` (`steamtrain.json`,
   `~/.steamtrain/config.json`)
5. nothing — unrestricted, no verification

Declaring it once at the workflow level is the clearest way to say "only the
implement step writes":

```json
{
  "name": "audit",
  "permissions": "read-only",
  "phases": [ /* every agent step here is read-only … */ ]
}
```

and the repository-wide form is the strongest statement a project can make:

```json
// steamtrain.json
{ "permissions": "read-only" }
```

Every agent step of every workflow in that project is then read-only until it
says otherwise — a workflow you have not audited cannot quietly rewrite your
checkout. Steps that genuinely need to write have to declare it, which is
exactly the review you wanted.

Sub-workflows inherit: a parent's profile becomes the child run's lowest layer,
so "nothing in this workflow writes" still holds three workflows deep, while a
child that declares its own profiles keeps them.

## Verification: trust, but check

A flag is a promise made by someone else's binary. It can be ignored, renamed
in the next release, stripped by a wrapper script — and five of the nine
supported agents cannot express a restriction at all. So `read-only` steps are
also checked from the outside.

Before the agent starts, steamtrain fingerprints the step's workspace as a git
tree hash of its complete working state (tracked edits, deletions, and untracked
files, honoring `.gitignore`, excluding `.steamtrain/`). After the step
finishes, it fingerprints again. Any difference fails the step:

```
fail review
   🔓 permission violation: modified 2 path(s) — M src/auth.ts, A notes.md
```

Details worth knowing:

- **A dirty starting state is fine.** The baseline is taken per step, so a
  reviewer using `workspace: "attach:implement"` inherits the implement step's
  edits as its baseline and is judged only on what *it* changed. A tree hash
  (not `git status`) is used precisely so that editing an already-modified file
  is still caught.
- **A violating step fails even if it "succeeded."** A reviewer that edited the
  code under review has invalidated its own review; keeping the output would
  make the profile theater.
- **Verification is skipped, never faked, when unavailable.** Outside a git
  repository there is no cheap reliable fingerprint, so the check reports
  nothing rather than guessing. Native enforcement still applies, and
  `StepResult.permissions.verified` records whether the check actually ran.
- **`read-only` + `artifacts` is rejected at validation time** — a step cannot
  produce the files it promises while being unable to write. So is `permissions`
  on a step with no agent to restrict (`gate`, `command`, `llm`, …), and
  `read-only` on a `merge` step whose conflict resolver has to edit files.

## Seeing it before you run

- **TUI preview** — a `🔒 sandbox: 4 read-only · 1 full` line next to
  `ready to run`, a badge on each step row, and, in the step drill-in, the
  profile plus who enforces it (`enforced by codex`, or
  `NOT enforceable by amp — this step is blocked before it spawns`).
- **`/permissions`** — with no argument, the whole workflow's posture step by
  step. With a profile, it sets the selected step (`--all` for every agent step
  in the pipeline, including inside sub-workflows); `/save-workflows` persists
  it. This is the "I'm about to run someone else's workflow on my real repo"
  command:

  ```
  /permissions read-only --all
  ```
- **`steamtrain workflow plan`** — a `sandbox:` summary line, a
  `permissions: read-only` tag per step, and `warn:` lines for anything running
  unenforced.
- **`steamtrain workflow list`** — the sandbox summary per workflow.
- **Web UI** — a `🔒 read-only` badge on fully-sandboxed workflow cards, a
  `🔓 unenforced`/`unenforceable` badge when a declared profile is not honored, a
  per-step badge on the run cards, and a `permissions` row in the step drawer
  (red, with the offending paths, on a violation).
- **Headless runs** — `start worker review [read-only]` in the event log, and
  the violation line above on failure.

## Clamping a step mid-run

Noticing an unrestricted step while the run is in flight is not a lost cause.
Pause the run, set the pending step's profile, resume — the same
[mid-run steering](mid-run-steering.md) path that edits prompts and models:

```bash
steamtrain workflow pause <runId>
steamtrain workflow edit-step <runId> <stepId> --permissions read-only
steamtrain workflow resume <runId>
```

In the TUI, `p` pauses and `e` opens the editor on the selected pending step
(`←/→` cycles the sandbox row); in the web UI the paused step card's **Edit
step** modal gains a Permissions select. The engine applies the same rules it
applies at authoring time — no profile on a step with no agent, no `read-only`
on a merge step or a step that declares `artifacts` — and a step clamped to
`read-only` gets the same post-run verification as one that declared it in the
spec. The edit lands in the run record as an intervention, so the step is
badged `✎ edited` and the audit trail shows who clamped what.

## Recorded in history

Each step result carries what actually happened:

```json
"permissions": {
  "profile": "read-only",
  "enforcement": "native",
  "gaps": [],
  "verified": true
}
```

`enforcement` is `native` (the CLI enforced it), `partial` (enforced, but some
part of the request was not — the `gaps` say what), or `none` (nothing was
enforced; only possible under `onUnsupported: "warn"`). A finished run is
therefore an auditable answer to "could this step have touched my repo?", not a
recollection.

Mid-flight model failover re-plans permissions per attempt: if a step fails over
to a different agent, that agent's ability to honor the profile is checked
before it spawns, not inherited from the previous one.

## Bundled workflows

The bundled catalog declares profiles, so the shipped examples are also the
reference:

| workflow | declaration |
| --- | --- |
| `multi-plan` | workflow-level `read-only` — planning reads and argues, never edits |
| `bug-hunt` | workflow-level `read-only` — it reports bugs, it does not repair them |
| `target-sweep` | workflow-level `read-only` — analysis per target, then a report |
| `review-loop` | `review` step `read-only`; `impl`/`fix` unrestricted |
| `mainline-stream` | `review` step `read-only`; `implement`/`fix` unrestricted |

They use the object form with `onUnsupported: "warn"` rather than the stricter
default, because a bundled workflow must stay runnable on whatever agent you
retarget it to. On claude/codex/opencode/mimo the restriction is enforced
natively; elsewhere it degrades honestly to post-run verification — which still
fails any read-only step that modified its workspace.

## See also

- [`workflow-spec.md`](workflow-spec.md#tool-permissions-permissions) — the field reference
- [`agent-configuration.md`](agent-configuration.md) — agent instances and the `/agents` manager
- [`worktree-lifecycle.md`](worktree-lifecycle.md) — the isolation layer permissions sit on top of
- [`mid-run-steering.md`](mid-run-steering.md) — pause a run and clamp a pending step's sandbox
- [`human-in-the-loop.md`](human-in-the-loop.md) — approval checkpoints, the other half of the trust story
