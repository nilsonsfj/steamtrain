import type { WorkspaceConfig } from "./types";

/**
 * Seed workspace presets written to ~/.steamtrain/workspace.json on first run.
 *
 * - `plan`      → Claude Code (strong reasoning for breaking work down)
 * - `implement` → OpenCode (fast, cheap edits via a non-Anthropic provider)
 * - `review`    → Claude Code (a deeper model for catching issues)
 */
export const DEFAULT_WORKSPACE_CONFIG: WorkspaceConfig = {
  workspaces: [
    { id: "plan", agent: "claude", model: "claude-sonnet-4-6" },
    { id: "implement", agent: "opencode", model: "openai/gpt-5.4-mini" },
    { id: "review", agent: "claude", model: "claude-opus-4-8" },
  ],
};
