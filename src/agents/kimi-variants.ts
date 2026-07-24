import { spawn } from "node:child_process";
import type { AgentModel } from "./agent-model";
import { fallbackKimiEfforts } from "./kimi-efforts-fallback";
import type { VariantModelInfo } from "./variant-info";

export type KimiModelInfo = VariantModelInfo;

const CACHE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;

interface VariantCache {
  models: Map<string, KimiModelInfo>;
  fetchedAt: number;
  binary: string;
}

class KimiVariantCacheStore {
  private cache: VariantCache | null = null;
  private refreshPromise: Promise<boolean> | null = null;

  cacheIsFresh(): boolean {
    return this.cache !== null && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS;
  }

  get models(): Map<string, KimiModelInfo> | null {
    return this.cache?.models ?? null;
  }

  set models(value: Map<string, KimiModelInfo> | null) {
    if (value === null) {
      this.cache = null;
    } else {
      this.cache = { models: value, fetchedAt: Date.now(), binary: "kimi" };
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

const store = new KimiVariantCacheStore();

/**
 * Parse `kimi provider list --json` output into alias → model metadata. The
 * `models` map keys are the aliases passed to `-m`; `displayName` and the
 * optional `supportEfforts` (declared in ascending order — kept as-is) feed
 * the catalog and effort pickers.
 */
export function parseKimiProviderList(output: string): Map<string, KimiModelInfo> {
  const result = new Map<string, KimiModelInfo>();
  let data: unknown;
  try {
    data = JSON.parse(output);
  } catch {
    return result;
  }

  const models = (data as { models?: unknown }).models;
  if (!models || typeof models !== "object") return result;

  for (const [alias, raw] of Object.entries(models as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const info = raw as { displayName?: unknown; supportEfforts?: unknown };
    const efforts = Array.isArray(info.supportEfforts)
      ? info.supportEfforts.filter((e): e is string => typeof e === "string")
      : [];
    result.set(alias, {
      name: typeof info.displayName === "string" ? info.displayName : alias,
      efforts,
    });
  }
  return result;
}

function fetchKimiProviderList(binary: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["provider", "list", "--json"], {
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
      reject(new Error(`kimi provider list --json timed out after ${FETCH_TIMEOUT_MS}ms`));
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
      reject(new Error(stderr.trim() || `kimi provider list --json exited with code ${code}`));
    });
  });
}

/** Load model metadata from the local Kimi Code install. Returns false when unavailable. */
export async function refreshKimiVariantCache(binary = "kimi"): Promise<boolean> {
  if (store.refreshInFlight) return store.refreshInFlight;

  store.refreshInFlight = (async () => {
    try {
      const output = await fetchKimiProviderList(binary);
      store.models = parseKimiProviderList(output);
      return true;
    } catch {
      return false;
    } finally {
      store.refreshInFlight = null;
    }
  })();

  return store.refreshInFlight;
}

function getCachedModel(model: string): KimiModelInfo | undefined {
  if (!store.cacheIsFresh()) return undefined;
  return store.models?.get(model);
}

/** Human-readable name for a Kimi model from the live cache, if known. */
export function getKimiModelName(model: string): string | undefined {
  return getCachedModel(model)?.name;
}

/** Model catalog from a fresh `kimi provider list --json` cache (empty when unavailable). */
export function listKimiCachedAgentModels(): readonly AgentModel[] {
  if (!store.cacheIsFresh()) return [];
  const models = store.models;
  if (!models) return [];
  return [...models.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, info]) => ({ id, name: info.name }));
}

/** Effort levels for a Kimi model: live cache first, static heuristics as fallback. */
export function getKimiEfforts(model: string): readonly string[] {
  const cached = getCachedModel(model);
  if (cached) return cached.efforts;
  return fallbackKimiEfforts(model);
}

/** Whether a fresh variant cache is loaded (tests may inject via `setKimiVariantCacheForTests`). */
export function hasKimiVariantCache(): boolean {
  return store.cacheIsFresh();
}

/** @internal Test helper — inject a model cache without spawning Kimi Code. */
export function setKimiVariantCacheForTests(models: Map<string, KimiModelInfo>): void {
  store.models = models;
}

/** @internal Test helper — clear the in-memory variant cache. */
export function clearKimiVariantCacheForTests(): void {
  store.clear();
}
