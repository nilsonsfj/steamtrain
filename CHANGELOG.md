# Changelog

Notable changes, newest first. Entries under Unreleased are those since
v0.1.0-alpha.2.

## Unreleased

### Changed (may break existing setups)

- **The web UI requires a token on loopback too.** `steamtrain --web-ui` used
  to bind `127.0.0.1` with no authentication. It now generates a token and
  prints a `?token=` URL, like the exposed mode does, because other local
  processes can reach `127.0.0.1`. A script must `POST /api/auth` with the
  token (your own via `--auth-token`, or the printed one) and send the session
  cookie it gets back; unauthenticated `/api/*` calls get `401`. `--no-auth`
  restores the old behavior. The `--desktop-ready-json` line gains an
  `authToken` field. See [`docs/web-ui.md`](docs/web-ui.md).
- **Harvesting into a branch that already exists now fails.** A harvest
  (`mode` `"branch"`, `"pr"` or `"worktree"`) created its staging branch with
  `git worktree add -B`, which silently reset an existing branch of that name.
  It now uses `-b`, so the harvest stops with git's error instead of
  overwriting the branch. A merge step with a fixed `branch` therefore fails on
  its second run: use a `branch` template that differs per run, or delete the
  old branch (`workflow history apply --branch <name>` is the same). A failed
  harvest also no longer deletes a branch it did not create.
- **A project `steamtrain.json` can no longer pick what gets executed.** Its
  `binaries`, an agent's `binary`, `env` and `extraArgs`, and an API's
  `baseUrl` and `apiKeyEnv` are ignored, with a warning, until the setting
  lives in `~/.steamtrain/config.json` or a file passed with `--config-file`.
  The web Settings marks such rows "inert until trusted".
- **Command templates are rendered differently.** POSIX values are bound to
  generated shell variables and expanded as data in their quoting context,
  instead of being quoted inline, so a placeholder no longer needs surrounding
  quotes (the bundled `babysit-pr` dropped its `"{{inputs.pr}}"`). Placeholders are rejected
  by default inside shell arithmetic (`$(( … ))`, `${v:off:len}`, array
  subscripts, `$[ … ]`, `(( … ))`, `[[ … -eq … ]]`, `let`, `declare -i`),
  inside ANSI-C quoted strings, and where command substitution, backticks or
  compound parameter expansions appear in an unquoted here-document with
  placeholders, since the value would be evaluated there. Pass the value
  through `env` and reference the variable, or set `allowShellTemplates: true`.
  See [`docs/workflow-spec.md`](docs/workflow-spec.md).
- **A command step ends with its shell.** A background process that still holds
  the step's output pipes (`cmd &`, a plain `nohup cmd &`) is now terminated
  and reaped before the step reports, instead of the step waiting on the pipes
  until its timeout. One that redirected its own output (`cmd >log 2>&1 &`) is
  left running.
- **File locks no longer expire by age.** A live owner is never revoked because
  its heartbeat is old; recovery needs a provably dead same-host owner. Restart
  every process that shares a lock directory together when upgrading. See
  [`docs/file-locks.md`](docs/file-locks.md).
- **Run report schema is version 2.** `--report json` adds an `outputs` array
  (the run's declared outputs and where each was written), so a consumer that
  checks `version === 1` must accept 2. `--report markdown` gains an Outputs
  section. See [`docs/ci-headless.md`](docs/ci-headless.md).
- Worktree branches and directories are named after the run's own id (a UUID)
  rather than a short hex string, so `git branch` shows
  `steamtrain/<uuid>/<step>`.

### Added

- Releasing the project state lock warns after 10 seconds, and gives up after
  5 minutes, when its coordinator is held by a process that never lets go
  (`releaseWarnAfterMs`, `releaseMaxWaitMs`).

### Fixed

- A read-only step that edited a copied ignore-rule file (a nested
  `.gitignore` that ignores itself) was still recorded as `verified: true`.
  It now fails, naming the file.
- Waiting for a process group to exit no longer runs to its timeout when the
  only members left are zombies, as under steamtrain as PID 1 in a container
  (Linux).
