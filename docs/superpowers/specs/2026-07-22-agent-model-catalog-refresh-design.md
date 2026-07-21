# Agent model catalog refresh (2026-07-22)

## Goal

Bring steamtrain's per-agent model catalogs, cross-agent family registry, role-class preferences, and Codex cost tables in line with current provider offerings - notably Gemini 3.6 Flash and GPT-5.6 Sol/Terra/Luna pricing.

## Approach

Curated static refresh (existing architecture). Live CLI/API refresh remains the full account catalog for Cursor, Antigravity, OpenCode, and Codex; static lists are offline fallbacks and identity seeds.

## Decisions

- Antigravity static ids migrate to live slug form (`gemini-3.6-flash-high`, …). Display labels remain accepted as aliases for workflow compatibility.
- Antigravity default model: `gemini-3.6-flash-high`.
- Never emit hybrid ids like `gemini-3.6-flash-high (High)`; repair already-glued hybrids at resolve time.
- Cursor static list expands to current notables without dumping every `*-fast` / effort variant.
- Codex gains GPT-5.6 Sol/Terra/Luna `$/MTok` rates; Claude/Cursor/OpenCode keep CLI-reported cost; no new Antigravity USD estimator.
- `gemini flash` alias moves to `gemini-3.6-flash`; `gemini-3.5-flash-lite` added for cheap/simple class preference.

## Surfaces

| File / area | Change |
| --- | --- |
| `src/agents/antigravity.ts` + variants | Slug catalog, effort suffix mapping, default |
| `src/agents/opencode.ts` | Zen/Go gaps (3.6 Flash, Flash-Lite, Fable 5, Sonnet 5, GLM 5.2, Grok 4.5, …) |
| `src/agents/cursor.ts` | Expanded curated static list |
| `src/agents/codex.ts` | GPT-5.6 pricing |
| `src/agents/model-identity.ts` | New Gemini families + offerings |
| `src/agents/model-classes.ts` | Prefer 3.6 Flash / Flash-Lite where appropriate |
| Tests + light `docs/model-binding.md` | Match new ids/defaults |

## Out of scope

Amp/Kiro redesign; mirroring every Cursor effort/fast id statically; Antigravity cost estimation.
