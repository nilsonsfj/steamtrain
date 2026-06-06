import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type WorkflowSpec, validateWorkflow } from "../workflow/types";
import { WORKSPACE_CONFIG_FILENAME } from "../workspace";
import { DEFAULT_CONFIG } from "./defaults";
import { type ConfigFile, type SteamtrainConfig, configFileSchema } from "./types";

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

  const legacyTasks = legacyTasksWarning(parsed);
  const result = configFileSchema.safeParse(parsed);
  if (!result.success) {
    return {
      config: DEFAULT_CONFIG,
      source: "built-in defaults",
      warning: joinWarnings(
        legacyTasks,
        `invalid ${CONFIG_FILENAME}: ${result.error.issues[0]?.message ?? "schema error"}`,
      ),
    };
  }

  const { config, warnings } = mergeConfig(DEFAULT_CONFIG, result.data);
  return {
    config,
    source: path,
    warning: joinWarnings(legacyTasks, warnings.length > 0 ? warnings.join("; ") : undefined),
  };
}

function legacyTasksWarning(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  if (!("tasks" in parsed)) return undefined;
  return `'tasks' in ${CONFIG_FILENAME} is no longer supported; move workspace presets to ~/.steamtrain/${WORKSPACE_CONFIG_FILENAME}`;
}

function joinWarnings(...parts: Array<string | undefined>): string | undefined {
  const text = parts.filter(Boolean).join("; ");
  return text || undefined;
}

export function mergeConfig(
  base: SteamtrainConfig,
  override: ConfigFile,
): { config: SteamtrainConfig; warnings: string[] } {
  const merged: SteamtrainConfig = {
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
