# Contributing to steamtrain

Thanks for your interest in contributing! Here's how to get started.

## Setup

```bash
git clone https://github.com/nilsonsfj/steamtrain.git
cd steamtrain
npm install
```

## Development commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start the TUI in development mode (requires Bun) |
| `npm run build` | Build the CLI to `dist/` |
| `npm run typecheck` | Run TypeScript type checking |
| `npm run lint` | Check formatting and lint rules (Biome) |
| `npm run format` | Auto-fix formatting and lint issues |
| `npm test` | Run the test suite (Vitest) |

## Code style

- TypeScript with strict mode enabled
- Biome for formatting and linting — run `npm run format` before committing
- No comments unless the user explicitly requests them
- Follow existing patterns in the codebase

## Pull requests

1. Create a feature branch from `main`
2. Make your changes
3. Run `npm run lint && npm run typecheck && npm test` to verify
4. Submit a pull request with a clear description of the change

## Architecture overview

- `src/agents/` — Agent adapters (Claude Code, OpenCode, Codex, Amp) with shared spawn/process logic
- `src/workflow/` — Workflow engine, types, authoring, catalog, caching, history
- `src/tui/` — Ink/React terminal UI
- `src/web/` — Web UI server and client
- `src/commands/` — Slash command system
- `src/orchestrator/` — Shared orchestration layer between TUI and web
- `src/config/` — Configuration loading and types
