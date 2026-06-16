# Public release readiness assessment

Date: 2026-06-16

## Verdict

The repository is not ready for a polished public release yet.

The underlying project looks credible: it has a coherent TypeScript codebase,
strict typechecking, substantial workflow documentation, and a passing test suite.
The main gaps are around public-facing polish, release mechanics, CI, package
metadata, and web UI security posture.

Recommended readiness level:

- Private/internal use: reasonable.
- Public GitHub preview or beta: close, after fixing the release blockers below.
- npm or broadly announced CLI release: not ready until packaging and install flow
  are cleaned up.

## Scope checked

This review covered:

- Project structure and public-facing documentation.
- npm package metadata and package dry-run behavior.
- Build, typecheck, test, lint, and basic built-CLI smoke checks.
- CI and release workflow presence.
- Security and hygiene issues that would matter for a public repository.
- Obvious unprofessional artifacts, stale docs, or credibility problems.

Commands run:

```bash
npm install
npm run typecheck
npm run lint
npm run test
npm run build
node dist/index.js --help
node dist/index.js workflow validate multi-plan
npm run dev -- --help
npm audit --omit=dev
npm audit
npm pack --dry-run
```

Results:

- `npm run typecheck`: passed.
- `npm run test`: passed, 41 test files and 327 tests.
- `npm run build`: passed.
- `node dist/index.js --help`: passed.
- `node dist/index.js workflow validate multi-plan`: passed.
- `npm run lint`: failed with 17 Biome issues.
- `npm run dev -- --help`: failed in this environment because the script invokes
  `bun`, and Bun was not installed.
- `npm audit --omit=dev`: 0 production vulnerabilities.
- `npm audit`: 6 dev-toolchain vulnerabilities, including 1 critical, through
  esbuild/Vite/Vitest/tsup.
- `npm pack --dry-run`: succeeded after a manual build; package contents were
  `README.md`, `package.json`, `dist/index.js`, and `dist/index.js.map`.

## Release blockers

### 1. License is claimed but not actually present

`README.md` says the project is MIT licensed, but there is no `LICENSE` file and
`package.json` has no `"license"` field.

Impact:

- Public users do not have a clear legal grant.
- npm and GitHub metadata will not show the expected license.
- This looks incomplete for an open-source release.

Recommended fix:

- Add a full MIT `LICENSE` file.
- Add `"license": "MIT"` to `package.json`.

### 2. No CI, and the current lint script fails

There is no GitHub Actions workflow or equivalent CI configuration. The project
has meaningful tests and quality scripts, but they are not automatically enforced.

The local verification run found:

- Typecheck passed.
- Tests passed.
- Build passed.
- Lint failed with 17 Biome format/import/lint issues.

Impact:

- Contributors cannot see whether a PR is healthy.
- Maintainers cannot point to a clean public quality gate.
- A failing `npm run lint` is an easy first-contact failure for outside users.

Recommended fix:

- Fix the current Biome failures.
- Add CI for install, lint, typecheck, test, and build on PRs and pushes.

### 3. npm/package release flow is underbaked

`package.json` points `bin` and `main` at `dist/index.js`, and publishes only
`dist`, but `dist` is gitignored and there is no `prepack` or `prepublishOnly`
script.

Impact:

- `npm pack` or `npm publish` relies on the maintainer remembering to run
  `npm run build` first.
- A package could be published without the expected built CLI.
- There is no obvious public install story such as `npm install -g steamtrain`.

Recommended fix:

- Add `prepack` or `prepublishOnly` to run the build.
- Add package metadata: `repository`, `bugs`, `homepage`, `keywords`, and license.
- Document an end-user install path separately from contributor setup.

### 4. Public documentation has factual inconsistencies

The documentation is extensive, but several visible statements are stale or
contradictory:

- README intro mentions Claude Code and OpenCode but omits Codex, even though
  Codex is supported by code and package metadata.
- README says `multi-plan` uses "claude + opencode", but the bundled workflow
  currently uses OpenCode-only free models.
- README architecture tree places `docs/` under `src/`, which is not the actual
  layout.
- README says `npm run dev` is "same, via tsx", but the script runs
  `bun src/index.tsx`.
- `docs/web-ui.md` says the web UI folds events with the same model the TUI uses,
  while `TUI-WEBUI-DIFFERENCES.md` says the reducers are near-duplicates and not
  yet unified.
- Root-level `TUI-WEBUI-DIFFERENCES.md` reads like an internal planning tracker,
  including branch names and remaining convergence work.

Impact:

- These are the kinds of inconsistencies that make a public repository look less
  trustworthy, even if the implementation is solid.

Recommended fix:

- Update README to match current agent support, workflow definitions, and scripts.
- Reconcile or remove contradictory web UI documentation.
- Move internal planning material out of the root public surface, or rewrite it as
  polished project documentation.

### 5. Web UI security posture needs to be clearer and harder to misuse

The web UI defaults to `127.0.0.1`, which is a good default. However, it has no
authentication and exposes privileged actions over HTTP:

- Start agent runs.
- Cancel runs.
- Read doctor results.
- Create, edit, and delete workflows.
- Trigger LLM-backed workflow generation.

The README and docs also show `--host 0.0.0.0`. Anyone who can reach that port can
drive the server process using the local machine's agent credentials and
environment.

Additional concern:

- Request bodies are read into memory without a size limit, which creates a
  straightforward denial-of-service risk if the server is reachable.

Impact:

- This is acceptable only if the web UI is clearly treated as a privileged local
  service.
- Public docs currently understate the full authoring API surface.

Recommended fix:

- Document the web UI as a local-only privileged control plane.
- Add request body limits.
- Document all authoring endpoints in `docs/web-ui.md`.
- Consider a local auth token, stricter host warnings, or disabling authoring
  routes when bound outside localhost.

## High-priority polish before release

### Package metadata is incomplete

`package.json` is missing common public metadata:

- `license`
- `repository`
- `bugs`
- `homepage`
- `keywords`
- `author` or `contributors`, if desired

This is not as severe as the missing license file, but it will look unfinished on
npm and GitHub.

### Dev-toolchain audit reports vulnerabilities

Production dependencies audit clean with `npm audit --omit=dev`, but the full
audit reports 6 vulnerabilities through dev dependencies.

These appear to be in build/test tooling rather than runtime dependencies, so
they are not a release blocker by themselves. They should still be addressed or
documented before a public launch because audit output is often one of the first
things outside contributors run.

### Lockfile and toolchain story is mixed

The repo commits `bun.lock`, ignores `package-lock.json`, and says npm also
works. In this environment, npm install worked, but Bun was not installed and the
documented `npm run dev` path failed because it invokes Bun.

Recommended fix:

- Decide whether Bun is required or merely preferred.
- If npm is supported, make npm scripts work without Bun or document Bun as a
  prerequisite.
- Consider adding `"packageManager"` to `package.json`.

### OSS housekeeping files are absent

The repository currently lacks:

- `CONTRIBUTING.md`
- `SECURITY.md`
- `CHANGELOG.md`
- `CODE_OF_CONDUCT.md`, optional but common

Recommended minimum:

- Add `SECURITY.md` because the project controls local agent subprocesses and has
  a local web UI.
- Add a short `CONTRIBUTING.md` with setup, test, lint, and build commands.
- Add a `CHANGELOG.md` for the initial public version.

## Lower-priority issues

These do not block a preview release, but are worth resolving for polish:

- Published package includes `dist/index.js.map`, which contains source mapping
  data. This may be fine for transparency and debugging, but it should be an
  intentional choice.
- `.gitignore` permits `.env.example`, but no `.env.example` exists.
- Some test helper exports are exposed through `src/agents/index.ts`. This is not
  a problem for CLI-only use, but it looks less polished if the package is treated
  as a library surface.
- There are no screenshots, terminal captures, GIFs, or examples directory. The
  text docs are strong, but a public launch would benefit from a visual demo.

## Positive signals

Several parts of the repository are already in good shape:

- Strict TypeScript settings are enabled.
- Tests are broad and passed in this review: 41 files, 327 tests.
- Build succeeds.
- The built CLI passed basic help and bundled-workflow validation smoke checks.
- No committed secrets were found in the reviewed source.
- Production dependency audit was clean.
- Config, settings, and workflow specs use Zod validation.
- Agent subprocess spawning does not use shell interpolation.
- The workflow documentation is substantial and shows real product thinking.
- The web UI binds to localhost by default and already warns about trusted
  networks.

## Recommended minimum checklist

Before a public GitHub beta:

- [ ] Add `LICENSE` and package license metadata.
- [ ] Fix `npm run lint`.
- [ ] Add CI for lint, typecheck, tests, and build.
- [ ] Fix README inaccuracies around Codex, `multi-plan`, architecture, and
      `npm run dev`.
- [ ] Rewrite or move `TUI-WEBUI-DIFFERENCES.md`.
- [ ] Clarify the web UI threat model and document all web API routes.
- [ ] Add basic `SECURITY.md`.

Before publishing to npm or announcing broadly:

- [ ] Add package repository, bugs, homepage, and keyword metadata.
- [ ] Add `prepack` or `prepublishOnly` so package creation always builds `dist`.
- [ ] Document a clear end-user install path.
- [ ] Decide whether source maps should ship.
- [ ] Resolve or explicitly accept dev-toolchain audit findings.
- [ ] Add `CONTRIBUTING.md` and `CHANGELOG.md`.

## Bottom line

This looks like a serious early-stage tool with a stronger implementation base
than release surface. The biggest risks are not core functionality. They are the
missing license, absent CI, failing lint, inconsistent public docs, underdeveloped
package release process, and the privileged local web UI needing clearer security
framing.

Fixing those would make the repository much more credible for a public beta.
