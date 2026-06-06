import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type WorkflowSpec, validateWorkflow } from "../workflow/types";
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

  const { config, warnings } = mergeConfig(DEFAULT_CONFIG, result.data);
  return {
    config,
    source: path,
    warning: warnings.length > 0 ? warnings.join("; ") : undefined,
  };
}

export function mergeConfig(
  base: SteamtrainConfig,
  override: ConfigFile,
): { config: SteamtrainConfig; warnings: string[] } {
  const merged: SteamtrainConfig = {
    tasks: {
      plan: override.tasks?.plan ?? base.tasks.plan,
      implement: override.tasks?.implement ?? base.tasks.implement,
      review: override.tasks?.review ?? base.tasks.review,
    },
    binaries: { ...base.binaries, ...override.binaries },
    timeoutMs: override.timeoutMs ?? base.timeoutMs,
    maxConcurrency: override.maxConcurrency ?? base.maxConcurrency,
  };

  const { workflows, warnings } = mergeWorkflows(base.workflows, override.workflows);
  if (workflows) merged.workflows = workflows;
  return { config: merged, warnings };
}

/** Merge user workflows over base, injecting each map key as the spec `name`. */
function mergeWorkflows(
  base: Record<string, WorkflowSpec> | undefined,
  override: ConfigFile["workflows"],
): { workflows?: Record<string, WorkflowSpec>; warnings: string[] } {
  if (!override) return { workflows: base, warnings: [] };
  const out: Record<string, WorkflowSpec> = { ...base };
  const warnings: string[] = [];
  for (const [name, spec] of Object.entries(override)) {
    const full = { ...spec, name };
    const valid = validateWorkflow(full);
    if (!valid.ok) {
      warnings.push(`workflow '${name}' ignored: ${valid.error}`);
      continue;
    }
    out[name] = full;
  }
  return { workflows: out, warnings };
}

/** Resolve a task type to its `{ agent, model }`. */
export function resolveTaskConfig(config: SteamtrainConfig, type: TaskType) {
  return config.tasks[type];
}
