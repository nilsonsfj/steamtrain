import { constants, accessSync, existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * Accept only http(s) API base URLs. Rejects file:, data:, and other schemes
 * that could be misused if the value were ever concatenated into a fetch URL.
 */
export function isAllowedApiBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Env var names used for `apiKeyEnv` must be conventional uppercase identifiers.
 * Deliberately allows names containing KEY/SECRET/TOKEN — that is the feature.
 */
export function isValidApiKeyEnvName(value: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(value);
}

/** Max chars for authoring prompts / command text in TUI editors and /prompt. */
export const MAX_PROMPT_CHARS = 100_000;

/**
 * Resolve a command name or path to an absolute executable, synchronously.
 * Mirrors {@link resolveBinary} in the doctor for save-time validation.
 */
export function resolveBinarySync(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes("\0") || /[\r\n]/.test(trimmed)) return undefined;
  if (trimmed.includes("/") || isAbsolute(trimmed)) {
    return isExecutableSync(trimmed) ? trimmed : undefined;
  }
  const pathEnv = process.env.PATH ?? "";
  const exts =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, trimmed + ext);
      if (isExecutableSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function isExecutableSync(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
