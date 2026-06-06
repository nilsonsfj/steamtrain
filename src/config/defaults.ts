import type { SteamtrainConfig } from "./types";

/** Sensible defaults for project-level `steamtrain.json`. Workspace presets live in `~/.steamtrain/workspace.json`. */
export const DEFAULT_CONFIG: SteamtrainConfig = {
  timeoutMs: 300_000,
  // Heavy CLI subprocesses, so default modest; configurable up to MAX_CONCURRENCY.
  maxConcurrency: 3,
};
