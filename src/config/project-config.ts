import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isEnoent } from "../workflow/fs-util";
import { loadConfig, projectConfigPath } from "./load";
import type { SteamtrainConfig } from "./types";
import { configFileSchema } from "./types";

export interface SaveProjectConfigResult {
  ok: boolean;
  path?: string;
  config?: SteamtrainConfig;
  error?: string;
}

/** Keys that may be updated via project config save helpers. */
export type ProjectConfigPatch = Partial<
  Pick<SteamtrainConfig, "stepTimeoutSec" | "workflowTimeoutSec" | "maxConcurrency" | "loopMaxIterations">
>;

/** Legacy timeout keys accepted in JSON on read; stripped on project config save. */
const LEGACY_TIMEOUT_FILE_KEYS = ["timeoutMs", "stepTimeoutMs", "workflowTimeoutMs"] as const;

/**
 * Merge a patch into the project `steamtrain.json`, preserving workflows and
 * other keys. Validates the full merged document against {@link configFileSchema}.
 */
export function saveProjectConfig(
  patch: ProjectConfigPatch,
  configPath: string = projectConfigPath(),
): SaveProjectConfigResult {
  const raw = readRawConfig(configPath);
  if (raw === undefined) {
    return { ok: false, error: `could not parse ${configPath}` };
  }

  const base = raw ?? {};
  const next: Record<string, unknown> = { ...base, ...patch };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
  }
  for (const key of LEGACY_TIMEOUT_FILE_KEYS) delete next[key];

  const check = configFileSchema.safeParse(next);
  if (!check.success) {
    const issue = check.error.issues[0];
    const detail = issue
      ? `${issue.path.join(".") || "config"}: ${issue.message}`
      : "invalid config";
    return { ok: false, error: `cannot save into ${configPath} (${detail})` };
  }

  writeRawConfig(configPath, next);
  const loaded = loadConfig({ customPath: configPath });
  return { ok: true, path: configPath, config: loaded.config };
}

export function readProjectConfig(
  configPath: string = projectConfigPath(),
): SteamtrainConfig | undefined {
  if (!existsSync(configPath)) return undefined;
  return loadConfig({ customPath: configPath }).config;
}

function readRawConfig(path: string): Record<string, unknown> | null | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch (err: unknown) {
    if (isEnoent(err)) return null;
    return undefined;
  }
}

function writeRawConfig(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}
