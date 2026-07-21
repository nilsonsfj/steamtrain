# Antigravity CLI Adapter Implementation Plan

> **For agentic workers:** Follow tasks in order. TDD where noted.

**Goal:** Add first-class steamtrain provider `antigravity` for Google's Antigravity CLI (`agy`), with plain-text print runs, resume, live models, doctor, and interactive takeover.

**Architecture:** `AntigravityAdapter` under `src/agents/` with a dedicated plain-text runner (`runAntigravityProcess`) because agy 1.1.x has no stream-json. Provider wired through types, config, doctor, models, takeover, and docs.

## Locked decisions

See `docs/superpowers/specs/2026-07-21-antigravity-cli-design.md`.

## Files

| Path | Responsibility |
|---|---|
| `src/agents/antigravity.ts` | Adapter, argv, session-id parse, plain-text runner |
| `src/agents/antigravity-variants.ts` | Parse/cache `agy models` |
| `src/agents/antigravity-transcript.ts` | Empty-stdout transcript recovery |
| `tests/antigravity-adapter.test.ts` | Argv / effort / session / transcript unit tests |
| `tests/antigravity-variants.test.ts` | Models parser/cache tests |
| Registration surfaces | events, config, index, models, types zod, doctor, takeover, cli, TUI, web, docs |

## Status

Implemented in this PR.
