import type { SteamtrainConfig } from "./types";

/**
 * Sensible defaults. Override any subset in a `steamtrain.json` at the cwd.
 *
 * - `plan`   → Claude Code (strong reasoning for breaking work down)
 * - `implement` → OpenCode (fast, cheap edits via a non-Anthropic provider)
 * - `review` → Claude Code (a deeper model for catching issues)
 *
 * The OpenCode model is `provider/model` and must be a provider you've
 * authenticated (`opencode auth login`). `openai/gpt-5.4-mini` is used here;
 * swap to e.g. `anthropic/claude-sonnet-4-6` if you add Anthropic creds.
 */
export const DEFAULT_CONFIG: SteamtrainConfig = {
  tasks: {
    plan: { agent: "claude", model: "claude-sonnet-4-6" },
    implement: { agent: "opencode", model: "openai/gpt-5.4-mini" },
    review: { agent: "claude", model: "claude-opus-4-8" },
  },
  timeoutMs: 300_000,
  // Heavy CLI subprocesses, so default modest; configurable up to MAX_CONCURRENCY.
  maxConcurrency: 3,
};
