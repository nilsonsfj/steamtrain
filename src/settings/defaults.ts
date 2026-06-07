import type { SteamtrainSettings } from "./types";

export const DEFAULT_PROMPT_HISTORY_LIMIT = 100;

/** Sensible defaults for `~/.steamtrain/settings.json`. */
export const DEFAULT_SETTINGS: SteamtrainSettings = {
  promptHistoryLimit: DEFAULT_PROMPT_HISTORY_LIMIT,
};
