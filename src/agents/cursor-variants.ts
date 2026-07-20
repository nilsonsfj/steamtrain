import { spawn } from "node:child_process";
import type { AgentModel } from "./agent-model";

export type CursorModelInfo = { name: string };

const CACHE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;

interface VariantCache {
  models: Map<string, CursorModelInfo>;
  fetchedAt: number;
  binary: string;
}

class CursorVariantCacheStore {
  private cache: VariantCache | null = null;
  private refreshPromise: Promise<boolean> | null = null;

  cacheIsFresh(): boolean {
    return this.cache !== null && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS;
  }

  get models(): Map<string, CursorModelInfo> | null {
    return this.cache?.models ?? null;
  }

  set models(value: Map<string, CursorModelInfo> | null) {
    if (value === null) {
      this.cache = null;
    } else {
      this.cache = { models: value, fetchedAt: Date.now(), binary: "agent" };
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

const store = new CursorVariantCacheStore();

/**
 * Parse `agent --list-models` text output into model id metadata.
 * Expects `id - Display Name` lines after an "Available models" header.
 */
export function parseCursorListModels(output: string): Map<string, CursorModelInfo> {
  const result = new Map<string, CursorModelInfo>();
  const lines = output.split("\n");

  let afterHeader = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!afterHeader) {
      if (trimmed === "Available models") {
        afterHeader = true;
      }
      continue;
    }

    if (!trimmed) continue;

    const sep = trimmed.indexOf(" - ");
    if (sep === -1) continue;

    const id = trimmed.slice(0, sep).trim();
    const name = trimmed.slice(sep + 3).trim();
    if (!id || !name) continue;

    result.set(id, { name });
  }

  return result;
}

function fetchCursorListModels(binary: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["--list-models"], {
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
      reject(new Error(`agent --list-models timed out after ${FETCH_TIMEOUT_MS}ms`));
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
      reject(new Error(stderr.trim() || `agent --list-models exited with code ${code}`));
    });
  });
}

/** Load model metadata from the local Cursor Agent CLI. Returns false when unavailable. */
export async function refreshCursorVariantCache(binary = "agent"): Promise<boolean> {
  if (store.refreshInFlight) return store.refreshInFlight;

  store.refreshInFlight = (async () => {
    try {
      const output = await fetchCursorListModels(binary);
      const models = parseCursorListModels(output);
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

function getCachedModel(id: string): CursorModelInfo | undefined {
  if (!store.cacheIsFresh()) return undefined;
  return store.models?.get(id);
}

/** Human-readable name for a Cursor model from the live cache, if known. */
export function getCursorModelName(id: string): string | undefined {
  return getCachedModel(id)?.name;
}

/** Model catalog from a fresh `agent --list-models` cache (empty when unavailable). */
export function listCursorCachedAgentModels(): readonly AgentModel[] {
  if (!store.cacheIsFresh()) return [];
  const models = store.models;
  if (!models) return [];
  return [...models.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, info]) => ({ id, name: info.name }));
}

/** @internal Test helper — clear the in-memory variant cache. */
export function clearCursorVariantCacheForTests(): void {
  store.clear();
}
