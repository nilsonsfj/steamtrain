import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isEnoent } from "../workflow/fs-util";
import { WORKSPACE_CONFIG_DIR } from "../workspace";
import type { SteamtrainConfig } from "./types";
import { userConfigFileSchema } from "./types";

export const USER_CONFIG_FILENAME = "config.json";

/** Default path: `~/.steamtrain/config.json`. */
export function userConfigPath(home: string = homedir()): string {
  return join(home, WORKSPACE_CONFIG_DIR, USER_CONFIG_FILENAME);
}

export interface SaveUserConfigResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/** Keys that may be updated via user (global) config save helpers. */
export type UserConfigPatch = Partial<
  Pick<
    SteamtrainConfig,
    | "binaries"
    | "agents"
    | "stepTimeoutSec"
    | "workflowTimeoutSec"
    | "maxConcurrency"
    | "loopMaxIterations"
  >
>;

/**
 * Merge a patch into the global `~/.steamtrain/config.json`, preserving other
 * keys. Validates the full merged document against {@link userConfigFileSchema}.
 */
export function saveUserConfig(
  patch: UserConfigPatch,
  configPath: string = userConfigPath(),
): SaveUserConfigResult {
  const raw = readRawConfig(configPath);
  if (raw === undefined) {
    return { ok: false, error: `could not parse ${configPath}` };
  }

  const base = raw ?? {};
  const next: Record<string, unknown> = { ...base, ...patch };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
  }

  const check = userConfigFileSchema.safeParse(next);
  if (!check.success) {
    const issue = check.error.issues[0];
    const detail = issue
      ? `${issue.path.join(".") || "config"}: ${issue.message}`
      : "invalid config";
    return { ok: false, error: `cannot save into ${configPath} (${detail})` };
  }

  writeRawConfig(configPath, next);
  return { ok: true, path: configPath };
}

export function userConfigExists(configPath: string = userConfigPath()): boolean {
  return existsSync(configPath);
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
