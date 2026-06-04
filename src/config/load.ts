import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "./defaults";
import { type ConfigFile, type SteamtrainConfig, type TaskType, configFileSchema } from "./types";

export const CONFIG_FILENAME = "steamtrain.json";

export interface LoadedConfig {
  config: SteamtrainConfig;
  /** Absolute path the config came from, or a human note about the fallback. */
  source: string;
  /** Non-fatal problem encountered while loading (kept defaults). */
  warning?: string;
}

/** Load defaults, then deep-merge a `steamtrain.json` from `cwd` if present. */
export function loadConfig(cwd: string = process.cwd()): LoadedConfig {
  const path = join(cwd, CONFIG_FILENAME);
  if (!existsSync(path)) {
    return { config: DEFAULT_CONFIG, source: "built-in defaults" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return {
      config: DEFAULT_CONFIG,
      source: "built-in defaults",
      warning: `could not parse ${CONFIG_FILENAME}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const result = configFileSchema.safeParse(parsed);
  if (!result.success) {
    return {
      config: DEFAULT_CONFIG,
      source: "built-in defaults",
      warning: `invalid ${CONFIG_FILENAME}: ${result.error.issues[0]?.message ?? "schema error"}`,
    };
  }

  return { config: mergeConfig(DEFAULT_CONFIG, result.data), source: path };
}

export function mergeConfig(base: SteamtrainConfig, override: ConfigFile): SteamtrainConfig {
  return {
    tasks: {
      plan: override.tasks?.plan ?? base.tasks.plan,
      implement: override.tasks?.implement ?? base.tasks.implement,
      review: override.tasks?.review ?? base.tasks.review,
    },
    binaries: { ...base.binaries, ...override.binaries },
    timeoutMs: override.timeoutMs ?? base.timeoutMs,
  };
}

/** Resolve a task type to its `{ agent, model }`. */
export function resolveTaskConfig(config: SteamtrainConfig, type: TaskType) {
  return config.tasks[type];
}
