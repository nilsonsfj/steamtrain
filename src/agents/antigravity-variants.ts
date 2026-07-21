import { spawn } from "node:child_process";
import type { AgentModel } from "./agent-model";

export type AntigravityModelInfo = { name: string };

const CACHE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;

interface VariantCache {
  models: Map<string, AntigravityModelInfo>;
  fetchedAt: number;
  binary: string;
}

class AntigravityVariantCacheStore {
  private cache: VariantCache | null = null;
  private refreshPromise: Promise<boolean> | null = null;

  cacheIsFresh(): boolean {
    return this.cache !== null && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS;
  }

  get models(): Map<string, AntigravityModelInfo> | null {
    return this.cache?.models ?? null;
  }

  set models(value: Map<string, AntigravityModelInfo> | null) {
    if (value === null) {
      this.cache = null;
    } else {
      this.cache = { models: value, fetchedAt: Date.now(), binary: "agy" };
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

const store = new AntigravityVariantCacheStore();

/**
 * Parse `agy models` text output into model id metadata.
 * Model ids are the display labels themselves (e.g. "Gemini 3.1 Pro (High)").
 */
export function parseAntigravityModelsOutput(output: string): Map<string, AntigravityModelInfo> {
  const result = new Map<string, AntigravityModelInfo>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Drop glog lines (I0721 …), progress banners, and usage chrome.
    if (/^[IWEF]\d{4}\s/.test(trimmed)) continue;
    if (/^Fetching available models/i.test(trimmed)) continue;
    if (/^Usage of agy:/i.test(trimmed)) continue;
    if (/^Available subcommands:/i.test(trimmed)) continue;
    if (trimmed.startsWith("-") || trimmed.startsWith("--")) continue;
    // Model labels look like "Gemini 3.1 Pro (High)" / "Claude Opus 4.6 (Thinking)".
    if (!/^[A-Za-z0-9]/.test(trimmed)) continue;
    if (trimmed.length > 120) continue;
    // Heuristic: bare status chrome without an effort suffix is not a model id.
    // Real agy labels today always use Title Case product names, not "server"/"listening".
    if (/\b(error|failed|listening|starting|server)\b/i.test(trimmed) && !/\(/.test(trimmed)) {
      continue;
    }
    result.set(trimmed, { name: trimmed });
  }
  return result;
}

function fetchAntigravityModels(binary: string): Promise<string> {
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
      reject(new Error(`agy models timed out after ${FETCH_TIMEOUT_MS}ms`));
    }, FETCH_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      // Cap noisy glog; models usually land on stdout.
      if (stderr.length < 20_000) stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      // agy often prints models on stdout while still emitting glog on stderr;
      // accept exit 0 or any run that produced parseable model lines.
      const combined = `${stdout}\n${stderr}`;
      if (code === 0 || parseAntigravityModelsOutput(combined).size > 0) {
        resolve(combined);
        return;
      }
      reject(new Error(stderr.trim() || `agy models exited with code ${code}`));
    });
  });
}

/** Load model metadata from the local Antigravity CLI. Returns false when unavailable. */
export async function refreshAntigravityVariantCache(binary = "agy"): Promise<boolean> {
  if (store.refreshInFlight) return store.refreshInFlight;

  store.refreshInFlight = (async () => {
    try {
      const output = await fetchAntigravityModels(binary);
      const models = parseAntigravityModelsOutput(output);
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

function getCachedModel(id: string): AntigravityModelInfo | undefined {
  if (!store.cacheIsFresh()) return undefined;
  return store.models?.get(id);
}

/** Human-readable name for an Antigravity model from the live cache, if known. */
export function getAntigravityModelName(id: string): string | undefined {
  return getCachedModel(id)?.name;
}

/** Model catalog from a fresh `agy models` cache (empty when unavailable). */
export function listAntigravityCachedAgentModels(): readonly AgentModel[] {
  if (!store.cacheIsFresh()) return [];
  const models = store.models;
  if (!models) return [];
  return [...models.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, info]) => ({ id, name: info.name }));
}

/** @internal Test helper — inject a model cache without spawning the Antigravity CLI. */
export function setAntigravityVariantCacheForTests(
  models: Map<string, AntigravityModelInfo>,
): void {
  store.models = models;
}

/** @internal Test helper — clear the in-memory variant cache. */
export function clearAntigravityVariantCacheForTests(): void {
  store.clear();
}
