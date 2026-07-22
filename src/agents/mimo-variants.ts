import { spawn } from "node:child_process";
import type { AgentModel } from "./agent-model";
import { fallbackMimoEfforts } from "./mimo-efforts-fallback";
import { parseOpencodeModelsVerbose } from "./opencode-variants";
import type { VariantModelInfo } from "./variant-info";

export type MimoModelInfo = VariantModelInfo;

const CACHE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;

interface VariantCache {
  models: Map<string, MimoModelInfo>;
  fetchedAt: number;
  binary: string;
}

class MimoVariantCacheStore {
  private cache: VariantCache | null = null;
  private refreshPromise: Promise<boolean> | null = null;

  cacheIsFresh(): boolean {
    return this.cache !== null && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS;
  }

  get models(): Map<string, MimoModelInfo> | null {
    return this.cache?.models ?? null;
  }

  set models(value: Map<string, MimoModelInfo> | null) {
    if (value === null) {
      this.cache = null;
    } else {
      this.cache = { models: value, fetchedAt: Date.now(), binary: "mimo" };
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

const store = new MimoVariantCacheStore();

function fetchMimoModelsVerbose(binary: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["models", "--verbose"], {
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
      reject(new Error(`mimo models --verbose timed out after ${FETCH_TIMEOUT_MS}ms`));
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
      reject(new Error(stderr.trim() || `mimo models --verbose exited with code ${code}`));
    });
  });
}

/** Load model metadata from the local MiMo install. Returns false when unavailable. */
export async function refreshMimoVariantCache(binary = "mimo"): Promise<boolean> {
  if (store.refreshInFlight) return store.refreshInFlight;

  store.refreshInFlight = (async () => {
    try {
      // Same verbose block format as OpenCode (MiMo is an OpenCode fork).
      const output = await fetchMimoModelsVerbose(binary);
      store.models = parseOpencodeModelsVerbose(output);
      return true;
    } catch {
      return false;
    } finally {
      store.refreshInFlight = null;
    }
  })();

  return store.refreshInFlight;
}

function getCachedModel(model: string): MimoModelInfo | undefined {
  if (!store.cacheIsFresh()) return undefined;
  return store.models?.get(model);
}

/** Human-readable name for a MiMo model from the live cache, if known. */
export function getMimoModelName(model: string): string | undefined {
  return getCachedModel(model)?.name;
}

/** Model catalog from a fresh `mimo models --verbose` cache (empty when unavailable). */
export function listMimoCachedAgentModels(): readonly AgentModel[] {
  if (!store.cacheIsFresh()) return [];
  const models = store.models;
  if (!models) return [];
  return [...models.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, info]) => ({ id, name: info.name }));
}

/** Effort levels for a MiMo model: live cache first, static heuristics as fallback. */
export function getMimoEfforts(model: string): readonly string[] {
  const cached = getCachedModel(model);
  if (cached) return cached.efforts;
  return fallbackMimoEfforts(model);
}

/** Whether a fresh variant cache is loaded (tests may inject via `setMimoVariantCacheForTests`). */
export function hasMimoVariantCache(): boolean {
  return store.cacheIsFresh();
}

/** @internal Test helper — inject a model cache without spawning MiMo. */
export function setMimoVariantCacheForTests(models: Map<string, MimoModelInfo>): void {
  store.models = models;
}

/** @internal Test helper — clear the in-memory variant cache. */
export function clearMimoVariantCacheForTests(): void {
  store.clear();
}
