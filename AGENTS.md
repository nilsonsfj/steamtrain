# AGENTS.md

## Cursor Cloud specific instructions

`steamtrain` is a single-package TypeScript CLI/TUI/Web-UI workflow orchestrator. There is no database or external backing service; state is local JSON under `.steamtrain/`. Standard commands live in `package.json` and `CONTRIBUTING.md` - use those.

- **Bun is required**, not just Node. The `dev`, `build`, `test`, and `pretest` scripts all invoke `bun scripts/build-reducer.ts`, so `npm test`/`npm run build` will fail without `bun` on PATH. Bun is preinstalled in this environment and symlinked at `/usr/local/bin/bun`; the startup/update script runs `bun install`.
- **Running the app in dev (from source, no build needed):**
  - TUI (default): `bun src/index.tsx`
  - Web UI: `bun src/index.tsx --web-ui --port 4317 --host 127.0.0.1` (serves at `http://127.0.0.1:4317`)
  - Headless CLI: `bun src/index.tsx workflow list|validate|run ...` (or `node dist/index.js ...` after `npm run build`).
- **Agent CLIs are NOT installed here.** Workflow steps of kind `worker`/`processor` (and `workflow create`) spawn an external agent CLI (`claude`/`opencode`/`codex`/`amp`) that must be installed and authenticated; without one, the doctor preflight aborts the run with `binary_missing`. This is expected, not an environment failure.
- **To exercise the engine end-to-end without any agent**, use an "agentless" workflow whose steps are only `distributor`/`consolidator`/`gate`. Define it in a `steamtrain.json` and run via `--config-file <path>`; the doctor preflight is skipped when a workflow spawns no agents.
- **All checks pass on `main`**: `npm run lint`, `npm run typecheck`, and `npm run test` (643 tests) are green.
