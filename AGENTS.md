# AGENTS.md

## Cursor Cloud specific instructions

`steamtrain` is a single-package TypeScript CLI/TUI/Web-UI workflow orchestrator. There is no database or external backing service; state is local JSON under `.steamtrain/`. Standard commands live in `package.json` and `CONTRIBUTING.md` - use those.

- **The development toolchain requires Bun and Node.js 20+.** `dev`, `build`, and `test` use Bun directly (including the generated browser reducer), even when invoked through an `npm run …` wrapper. Bun is preinstalled in this environment; the startup/update script runs `bun install`.
- **Running the app in dev (from source, no build needed):**
  - TUI (default): `bun src/index.tsx`
  - Web UI: `bun src/index.tsx --web-ui --port 4317 --host 127.0.0.1` (serves at `http://127.0.0.1:4317`)
  - Headless CLI: `bun src/index.tsx workflow list|validate|run ...` (or `node dist/index.js ...` after `npm run build`).
- **Agent CLIs are NOT installed here.** Workflow steps of kind `worker`/`processor` (and `workflow create`) spawn an external agent CLI (`claude`/`opencode`/`codex`/`cursor`/`agent`/`amp`) that must be installed and authenticated; without one, the doctor preflight aborts the run with `binary_missing`. This is expected, not an environment failure.
- **To exercise the engine end-to-end without any agent**, use an "agentless" workflow whose steps are only `distributor`/`consolidator`/`gate`. Define it in a `steamtrain.json` and run via `--config-file <path>`; the doctor preflight is skipped when a workflow spawns no agents.
- **Verified baseline (2026-07-20):** `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` pass. Run the commands rather than relying on a fixed test count; the suite grows frequently.
