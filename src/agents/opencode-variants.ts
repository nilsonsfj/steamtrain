import { spawn } from "node:child_process";
import type { AgentModel } from "./agent-model";
import { fallbackOpencodeEfforts } from "./opencode-efforts-fallback";

const CACHE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;

export interface OpencodeModelInfo {
  name: string;
  efforts: readonly string[];
}

interface VariantCache {
  models: Map<string, OpencodeModelInfo>;
  fetchedAt: number;
  binary: string;
}

class OpencodeVariantCacheStore {
  private cache: VariantCache | null = null;
  private refreshPromise: Promise<boolean> | null = null;

  cacheIsFresh(): boolean {
    return this.cache !== null && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS;
  }

  get models(): Map<string, OpencodeModelInfo> | null {
    return this.cache?.models ?? null;
  }

  set models(value: Map<string, OpencodeModelInfo> | null) {
    if (value === null) {
      this.cache = null;
    } else {
      this.cache = { models: value, fetchedAt: Date.now(), binary: "opencode" };
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

const store = new OpencodeVariantCacheStore();

/**
 * Parse `opencode models --verbose` output into provider/model metadata.
 * Each block is a model id line followed by a JSON object with `name` and `variants`.
 */
export function parseOpencodeModelsVerbose(output: string): Map<string, OpencodeModelInfo> {
  const result = new Map<string, OpencodeModelInfo>();
  const lines = output.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? "";
    if (!/^[^\s{]+\/[^\s{]+$/.test(line)) continue;

    const modelId = line;
    i += 1;
    if (i >= lines.length || lines[i]?.trim() !== "{") continue;

    let depth = 0;
    let inString = false;
    let escaped = false;
    const jsonLines: string[] = [];
    for (; i < lines.length; i++) {
      const chunk = lines[i] ?? "";
      jsonLines.push(chunk);
      for (const ch of chunk) {
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === '"') inString = false;
        } else {
          if (ch === '"') inString = true;
          else if (ch === "{") depth += 1;
          else if (ch === "}") depth -= 1;
        }
      }
      if (depth === 0) break;
    }

    try {
      const data = JSON.parse(jsonLines.join("\n")) as {
        name?: string;
        variants?: Record<string, unknown>;
      };
      result.set(modelId, {
        name: data.name ?? modelId,
        efforts: Object.keys(data.variants ?? {}).sort(),
      });
    } catch {
      // Skip malformed blocks.
    }
  }

  return result;
}

function fetchOpencodeModelsVerbose(binary: string): Promise<string> {
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
      reject(new Error(`opencode models --verbose timed out after ${FETCH_TIMEOUT_MS}ms`));
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
      reject(new Error(stderr.trim() || `opencode models --verbose exited with code ${code}`));
    });
  });
}

function cacheIsFresh(): boolean {
  return store.cacheIsFresh();
}

/** Load model metadata from the local OpenCode install. Returns false when unavailable. */
export async function refreshOpencodeVariantCache(binary = "opencode"): Promise<boolean> {
  if (store.refreshInFlight) return store.refreshInFlight;

  store.refreshInFlight = (async () => {
    try {
      const output = await fetchOpencodeModelsVerbose(binary);
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

function getCachedModel(model: string): OpencodeModelInfo | undefined {
  if (!store.cacheIsFresh()) return undefined;
  return store.models?.get(model);
}

/** Human-readable name for an OpenCode model from the live cache, if known. */
export function getOpencodeModelName(model: string): string | undefined {
  return getCachedModel(model)?.name;
}

/** Model catalog from a fresh `opencode models --verbose` cache (empty when unavailable). */
export function listOpencodeCachedAgentModels(): readonly AgentModel[] {
  if (!store.cacheIsFresh()) return [];
  const models = store.models;
  if (!models) return [];
  return [...models.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, info]) => ({ id, name: info.name }));
}

/** Effort levels for an OpenCode model: live cache first, static heuristics as fallback. */
export function getOpencodeEfforts(model: string): readonly string[] {
  const cached = getCachedModel(model);
  if (cached) return cached.efforts;
  return fallbackOpencodeEfforts(model);
}

/** Whether a fresh variant cache is loaded (tests may inject via `setOpencodeVariantCacheForTests`). */
export function hasOpencodeVariantCache(): boolean {
  return store.cacheIsFresh();
}

/** @internal Test helper — inject a model cache without spawning OpenCode. */
export function setOpencodeVariantCacheForTests(models: Map<string, OpencodeModelInfo>): void {
  store.models = models;
}

/** @internal Test helper — clear the in-memory variant cache. */
export function clearOpencodeVariantCacheForTests(): void {
  store.clear();
}
