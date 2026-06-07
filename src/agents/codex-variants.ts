import { spawn } from "node:child_process";
import type { AgentModel } from "./agent-model";
import { fallbackCodexEfforts } from "./codex-efforts-fallback";

const CACHE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;

export interface CodexModelInfo {
  name: string;
  efforts: readonly string[];
}

interface VariantCache {
  models: Map<string, CodexModelInfo>;
  fetchedAt: number;
  binary: string;
}

let cache: VariantCache | null = null;
let refreshPromise: Promise<boolean> | null = null;

/**
 * Parse `codex debug models` JSON output into slug metadata.
 * Accepts the bundled catalog shape: `{ models: [{ slug, display_name, supported_reasoning_levels }] }`.
 */
export function parseCodexDebugModels(output: string): Map<string, CodexModelInfo> {
  const result = new Map<string, CodexModelInfo>();
  const trimmed = output.trim();
  if (!trimmed) return result;

  try {
    const data = JSON.parse(trimmed) as {
      models?: Array<{
        slug?: string;
        display_name?: string;
        supported_reasoning_levels?: Array<{ effort?: string } | string>;
      }>;
    };

    for (const model of data.models ?? []) {
      const slug = model.slug?.trim();
      if (!slug) continue;

      const efforts = (model.supported_reasoning_levels ?? [])
        .map((level) => (typeof level === "string" ? level : level.effort))
        .filter((effort): effort is string => typeof effort === "string" && effort.length > 0)
        .sort();

      result.set(slug, {
        name: model.display_name?.trim() || slug,
        efforts,
      });
    }
  } catch {
    // Skip malformed output.
  }

  return result;
}

function fetchCodexDebugModels(binary: string, bundled: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["debug", "models", ...(bundled ? ["--bundled"] : [])];
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`codex debug models timed out after ${FETCH_TIMEOUT_MS}ms`));
    }, FETCH_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr.trim() || `codex debug models exited with code ${code}`));
    });
  });
}

function cacheIsFresh(): boolean {
  return cache !== null && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
}

/** Load model metadata from the local Codex install. Returns false when unavailable. */
export async function refreshCodexVariantCache(binary = "codex"): Promise<boolean> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      let output: string;
      try {
        output = await fetchCodexDebugModels(binary, false);
      } catch {
        output = await fetchCodexDebugModels(binary, true);
      }

      const models = parseCodexDebugModels(output);
      if (models.size === 0) return false;

      cache = {
        models,
        fetchedAt: Date.now(),
        binary,
      };
      return true;
    } catch {
      return false;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

function getCachedModel(model: string): CodexModelInfo | undefined {
  if (!cacheIsFresh()) return undefined;
  return cache!.models.get(model);
}

/** Human-readable name for a Codex model from the live cache, if known. */
export function getCodexModelName(model: string): string | undefined {
  return getCachedModel(model)?.name;
}

/** Model catalog from a fresh `codex debug models` cache (empty when unavailable). */
export function listCodexCachedAgentModels(): readonly AgentModel[] {
  if (!cacheIsFresh()) return [];
  return [...cache!.models.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, info]) => ({ id, name: info.name }));
}

/** Effort levels for a Codex model: live cache first, static heuristics as fallback. */
export function getCodexEfforts(model: string): readonly string[] {
  const cached = getCachedModel(model);
  if (cached) return cached.efforts;
  return fallbackCodexEfforts(model);
}

/** Whether a fresh variant cache is loaded (tests may inject via `setCodexVariantCacheForTests`). */
export function hasCodexVariantCache(): boolean {
  return cacheIsFresh();
}

/** @internal Test helper — inject a model cache without spawning Codex. */
export function setCodexVariantCacheForTests(models: Map<string, CodexModelInfo>): void {
  cache = { models, fetchedAt: Date.now(), binary: "codex" };
}

/** @internal Test helper — clear the in-memory variant cache. */
export function clearCodexVariantCacheForTests(): void {
  cache = null;
  refreshPromise = null;
}
