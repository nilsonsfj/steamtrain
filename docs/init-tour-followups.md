# `steamtrain init` + `tour` — review dispositions and follow-ups

PR #63 received several review rounds. This file records what was applied,
what was declined (and why), and what is deferred as future work — following
the [`dry-run-followups.md`](dry-run-followups.md) precedent.

## Applied across review rounds

- **Line-buffered prompting.** The original `askYesNo` resolved one answer per
  stdin `data` chunk, which misread and then hung on a pasted/piped
  `"y\nn\n"` arriving as one chunk (reviewer-confirmed blocker). Prompting now
  goes through a line-buffered reader: chunks are reassembled into lines, each
  question consumes exactly one line, type-ahead lines wait for the next
  question, a partial line waits for its newline (or end-of-input, which
  flushes it as a final answer), and a closed/errored/already-dead stream
  declines instead of hanging. The reader detaches and pauses stdin on
  dispose so it can't hold the process open.
- **Non-interactive sessions require `--yes` to write.** Piped/CI stdin
  without `--yes` now lists the offers and declines them, instead of silently
  accepting everything — redirecting output must never mutate config.
- **Detection hardening:** array-typed `scripts` guarded; pytest/ruff matched
  by `[tool.pytest` / `[tool.ruff` section headers instead of bare words;
  explicit `test` marker on `DetectedCheck` (replacing an id-suffix regex);
  npm scaffold placeholder `test` skipped; Makefile `test` used only as a
  fallback.
- **Stack-reporting parity:** a bare `pyproject.toml` now reports
  `detected: python` with zero checks, exactly like a script-less
  `package.json` reports `detected: node (…)`.
- **Config-write safety:** unparseable JSON and a non-object `workflows` key
  abort with exit 1 and an expected-shape hint, leaving the file
  byte-identical; all other top-level keys are preserved; same-named
  workflows are never overwritten.
- **UX:** `init --help`/`-h` prints command-specific help; a progress line
  prints before the doctor runs (version probes can be slow on a fresh
  machine); the generated `implement-verified` states that its agent is
  simply the first ready one and how to change it; the `verify` consolidator
  header is "Check results" rather than claiming everything passed;
  `statusGlyph` switches exhaustively over doctor statuses; the tour's
  conductor documents that a skipped dependency doesn't block a consolidator.

## Declined, with rationale

- **`statusGlyph` `default: return "?"` fallback.** Two reviews pulled in
  opposite directions: one asked for an exhaustive switch that fails to
  compile when a new doctor status is added, another asked for a runtime
  `"?"` default that degrades gracefully. These are mutually exclusive; the
  exhaustive switch was chosen because a compile error at the source of the
  new status is strictly more useful than a silent `"?"` in terminal output.
- **`not` modifier on the tour's `express-service` `when` condition.** The
  reviewer noted it themselves: the step is *meant* to be skipped, and
  `contains: "express"` with no match is exactly the pedagogical point.
- **"`implement-verified`'s test step can pollute the merge."** This one is a
  misread worth recording: the `test` step runs with
  `workspace: "inherit:impl"`, which seeds a **new** isolated worktree from
  `impl`'s final state — it does not execute inside `impl`'s worktree. The
  `merge` step's `from: ["impl"]` harvests `impl`'s worktree only, so files
  the test command writes (coverage output, caches) stay in the test step's
  own worktree and are never applied to the checkout.
- **Dropping the `target: "verified"` label on the gate.** Not dead: gate
  targets surface in `gate_evaluated` events, the CLI run summary
  (`gate:passed`), run history, and both UIs' step details. It is display
  metadata, not routing, and it is doing its job.
- **`[tool.pytest`/`[tool.ruff` prefix also matching `[tool.pytest-cov]`-style
  siblings.** Accepted as-is (the reviewer agreed): a project configuring a
  pytest or ruff plugin runs pytest or ruff.

## Deferred / out of scope for the onboarding PR

- **TOML-aware parsing of `pyproject.toml`.** Section-header prefix matching
  is deliberate scope control: a real TOML parser is a new dependency (or a
  hand-rolled one to maintain) to close a false-positive window that is
  already narrow. Revisit if detection grows more Python-specific rules.
- **Verifying `make` (and other runners) exist on PATH before offering the
  check.** Detection is synchronous and offline by design; binary resolution
  is the doctor's job and would make `detectProject` async for marginal
  benefit. A generated check whose binary is missing fails loudly with the
  shell's own "command not found" — an honest, debuggable signal. Could be
  folded into a future `workflow doctor`-style validation of command steps.
- **Formatting-preserving config writes.** `init` re-serializes
  `steamtrain.json` with 2-space indentation, which discards hand-chosen
  formatting (never data — JSON has no comments). Preserving formatting
  requires a CST-based JSON editor; not worth the dependency for a file the
  project itself generates and rewrites elsewhere (`workflow create --save
  --scope project` behaves the same way).
- **Doctor fast path for `init`.** The progress note covers the UX today. A
  real fix (cached doctor results with a TTL, or parallel probes with a
  spinner) belongs to the doctor itself so the TUI/web/CLI all benefit, not
  to `init`.
- **Choosing which agent backs `implement-verified`.** `init` intentionally
  stays zero-decision (first ready agent, its default model) and says so in
  its output; the generated JSON is the customization surface. An
  interactive agent/model picker would duplicate the TUI's existing agent
  manager — if demand shows up, add `steamtrain init --agent <id>`
  `--model <m>` flags rather than a menu.
- **Keeping the tour's sample copy in one place.** The
  `--input "all aboard"` example appears in `printNextSteps`, the README, and
  the help text. Harmless duplication today; consolidate if the copy churns.
