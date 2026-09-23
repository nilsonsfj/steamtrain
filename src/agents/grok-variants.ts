import { spawn } from "node:child_process";
import type { AgentModel } from "./agent-model";
import { GROK_MODELS } from "./grok";
import { fallbackGrokEfforts } from "./grok-efforts-fallback";

export type GrokModelInfo = { name: string; efforts: readonly string[] };

const CACHE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;

const STATIC_NAMES = new Map(GROK_MODELS.map((model) => [model.id, model.name]));

interface VariantCache {
  models: Map<string, GrokModelInfo>;
  fetchedAt: number;
}

class GrokVariantCacheStore {
  private cache: VariantCache | null = null;
  private refreshPromise: Promise<boolean> | null = null;

  cacheIsFresh(): boolean {
    return this.cache !== null && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS;
  }

  get models(): Map<string, GrokModelInfo> | null {
    return this.cache?.models ?? null;
  }

  set models(value: Map<string, GrokModelInfo> | null) {
    if (value === null) {
      this.cache = null;
    } else {
      this.cache = { models: value, fetchedAt: Date.now() };
    }
  }

  get refreshInFlight(): Promise<boolean> | null {
    return this.refreshPromise;
  }

  set refreshInFlight(value: Promise<boolean> | null) {
    this.refreshPromise = value;
  }

  clear(): void {
    this.cache = null;
    this.refreshPromise = null;
  }
}

const store = new GrokVariantCacheStore();

function displayName(id: string): string {
  return STATIC_NAMES.get(id) ?? id;
}

/**
 * Parse `grok models` text. The CLI prints a header, then one model per line:
 *
 * ```
 * Default model: grok-4.7
 * Available models:
 *   * grok-4.7 (default)
 *   - grok-4.6
 * ```
 *
 * `*` marks the account default. Display names and effort menus are not in
 * this output; known ids keep their static names and effort menus.
 */
export function parseGrokModelsOutput(output: string): Map<string, GrokModelInfo> {
  const result = new Map<string, GrokModelInfo>();
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*[*+-]\s+(\S+)(?:\s+\(default\))?\s*$/);
    const id = match?.[1];
    if (!id) continue;
    result.set(id, { name: displayName(id), efforts: [...fallbackGrokEfforts(id)] });
  }
  return result;
}

function fetchGrokModels(binary: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["models"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, 2000);
      killTimer.unref?.();
      reject(new Error(`${binary} models timed out after ${FETCH_TIMEOUT_MS}ms`));
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
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr.trim() || `${binary} models exited with code ${code}`));
    });
  });
}

/** Load model metadata from the local `grok` CLI. Returns false when unavailable. */
export async function refreshGrokVariantCache(binary = "grok"): Promise<boolean> {
  if (store.refreshInFlight) return store.refreshInFlight;

  store.refreshInFlight = (async () => {
    try {
      const output = await fetchGrokModels(binary);
      const models = parseGrokModelsOutput(output);
      if (models.size === 0) return false;
      store.models = models;
      return true;
    } catch {
      return false;
    } finally {
      store.refreshInFlight = null;
    }
  })();

  return store.refreshInFlight;
}

function cachedModel(id: string): GrokModelInfo | undefined {
  if (!store.cacheIsFresh()) return undefined;
  return store.models?.get(id);
}

/** Human-readable name from the live cache, else the static catalog. */
export function getGrokModelName(id: string): string | undefined {
  if (store.cacheIsFresh()) return cachedModel(id)?.name;
  return STATIC_NAMES.get(id);
}

/** Effort menu for a model: live cache when fresh, otherwise the static fallback. */
export function getGrokEfforts(id: string): readonly string[] {
  if (store.cacheIsFresh()) return cachedModel(id)?.efforts ?? [];
  return fallbackGrokEfforts(id);
}

/** Model catalog from a fresh `grok models` cache (empty when unavailable). */
export function listGrokCachedAgentModels(): readonly AgentModel[] {
  if (!store.cacheIsFresh()) return [];
  const models = store.models;
  if (!models) return [];
  return [...models.entries()].map(([id, info]) => ({ id, name: info.name }));
}

/** @internal Test helper — inject a model cache without spawning `grok`. */
export function setGrokVariantCacheForTests(models: Map<string, GrokModelInfo>): void {
  store.models = models;
}

/** @internal Test helper. */
export function clearGrokVariantCacheForTests(): void {
  store.clear();
}
