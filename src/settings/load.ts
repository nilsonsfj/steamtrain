import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_CONFIG_DIR } from "../workspace";
import { DEFAULT_SETTINGS } from "./defaults";
import { type SettingsFile, type SteamtrainSettings, settingsFileSchema } from "./types";

export const SETTINGS_FILENAME = "settings.json";

export interface LoadedSettings {
  settings: SteamtrainSettings;
  /** True when `~/.steamtrain/settings.json` exists. */
  hasUserFile: boolean;
  warning?: string;
}

/** Default path: `~/.steamtrain/settings.json`. */
export function settingsConfigPath(home: string = homedir()): string {
  return join(home, WORKSPACE_CONFIG_DIR, SETTINGS_FILENAME);
}

/** Load user settings from `~/.steamtrain/settings.json`, falling back to defaults. */
export function loadSettings(home: string = homedir()): LoadedSettings {
  const path = settingsConfigPath(home);
  if (!existsSync(path)) {
    return { settings: DEFAULT_SETTINGS, hasUserFile: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return {
      settings: DEFAULT_SETTINGS,
      hasUserFile: true,
      warning: `could not parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const result = settingsFileSchema.safeParse(parsed);
  if (!result.success) {
    return {
      settings: DEFAULT_SETTINGS,
      hasUserFile: true,
      warning: `invalid ${path}: ${result.error.issues[0]?.message ?? "schema error"}`,
    };
  }

  return {
    settings: mergeSettings(DEFAULT_SETTINGS, result.data),
    hasUserFile: true,
  };
}

export function mergeSettings(
  base: SteamtrainSettings,
  override: SettingsFile,
): SteamtrainSettings {
  return {
    promptHistoryLimit: override.promptHistoryLimit ?? base.promptHistoryLimit,
  };
}
