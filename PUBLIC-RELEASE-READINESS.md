# Public release readiness assessment

Date: 2026-07-15 (refreshed; merge with PR #84 status update)

## Verdict

The 2026-06-16 release blockers are resolved. The repository is ready for a
public GitHub beta. A broadly announced npm/CLI launch still wants a
`CHANGELOG.md` and a conscious call on source maps / dev-toolchain audit
findings.

Recommended readiness level:

- Private/internal use: ready.
- Public GitHub preview or beta: ready.
- npm or broadly announced CLI release: close — finish the npm checklist below.

## Resolved since the 2026-06-16 review

| Area | Status |
| --- | --- |
| MIT `LICENSE` + `"license": "MIT"` in `package.json` | Done |
| CI (`.github/workflows/ci.yml`: lint, typecheck, test, build on Bun) | Done |
| `prepack` runs build before `npm pack` / publish | Done |
| Package metadata (`repository`, `bugs`, `homepage`, `keywords`) | Done |
| `CONTRIBUTING.md` with setup and check commands | Done |
| `SECURITY.md` (reporting channel + threat model) | Done |
| Web UI security hardening (auth token, session cookies, CSRF, login rate limit, `--no-auth`, reverse-proxy docs, 1 MiB body limit, CSP) | Done — see [`docs/web-ui.md`](docs/web-ui.md) |
| TUI/web reducer unification (`src/workflow/reducer.ts`) | Done |
| Live cost/token ticker (TUI status bar, web header) | Done |
| Mid-run steering (pause / edit pending steps / resume) | Done — see [`docs/mid-run-steering.md`](docs/mid-run-steering.md) |
| README agent/script/architecture accuracy | Done |
| End-user install path (`npm run install:local`) | Done |
| Contradictory web-UI reducer docs | Addressed |

## Remaining gaps (not beta blockers)

### 1. npm polish

- [ ] `CHANGELOG.md` — deferred until the first published version; there are no
      released versions to log yet.
- [ ] Source maps in the package and dev-toolchain audit findings — accepted for
      the alpha; revisit at first npm publish.

### 2. CI / headless integration story (product gap)

There is still no published GitHub Action, no `--report json|markdown|junit`
artifact on `workflow run`, and no documented exit-code contract for gate vs.
step failures. This is tracked as roadmap item 1.2 in
[`docs/feature-roadmap.md`](docs/feature-roadmap.md). Optional for a
local-dev-first public beta; required for a CI-oriented launch narrative.

### 3. Optional public polish

- Visual demo assets (screenshots / terminal GIFs) in the README.
- Moving or further trimming root-level internal planning docs
  ([`TUI-WEBUI-DIFFERENCES.md`](TUI-WEBUI-DIFFERENCES.md) is now a maintained
  convergence doc rather than an open tracker).

## Positive signals

- Strict TypeScript, broad test suite (600+ tests), green lint/typecheck/test
  on CI.
- Coherent workflow language with substantial documentation under `docs/`.
- Zod validation across config and workflow specs.
- Agent subprocess spawning avoids shell interpolation.
- Web UI defaults to localhost; non-local binds require auth unless `--no-auth`
  is explicitly chosen.
- No committed secrets found in routine review.

## Recommended minimum checklist

Before a public GitHub beta:

- [x] Add `LICENSE` and package license metadata.
- [x] Add CI for lint, typecheck, tests, and build.
- [x] Clarify the web UI threat model and document API routes.
- [x] Add `SECURITY.md`.
- [x] Spot-check README for agent/workflow/script accuracy.
- [x] Rewrite `TUI-WEBUI-DIFFERENCES.md` as a maintained convergence doc.

Before publishing to npm or announcing broadly:

- [x] Add package repository, bugs, homepage, and keyword metadata.
- [x] Add `prepack` so package creation always builds `dist`.
- [x] Document a clear end-user install path (`install:local`).
- [ ] Add `CHANGELOG.md` for the initial public version.
- [ ] Resolve or document dev-toolchain audit findings / source-map shipping.
- [ ] Ship CI integration (roadmap 1.2) or clearly label the tool as
      local-dev-first until it lands.

## Bottom line

License, CI, package metadata, web UI security, and `SECURITY.md` are in place.
What remains for a polished npm launch is changelog/audit housekeeping and the
optional CI/headless product story — not core engine correctness.
