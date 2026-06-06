import { spawn } from "node:child_process";
import { fallbackOpencodeEfforts } from "./opencode-efforts-fallback";

const CACHE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;

interface VariantCache {
  variants: Map<string, readonly string[]>;
  fetchedAt: number;
  binary: string;
}

let cache: VariantCache | null = null;
let refreshPromise: Promise<boolean> | null = null;

/**
 * Parse `opencode models --verbose` output into provider/model → variant keys.
 * Each block is a model id line followed by a JSON object with a `variants` map.
 */
export function parseOpencodeModelsVerbose(output: string): Map<string, readonly string[]> {
  const result = new Map<string, readonly string[]>();
  const lines = output.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? "";
    if (!/^[^\s{]+\/[^\s{]+$/.test(line)) continue;

    const modelId = line;
    i += 1;
    if (i >= lines.length || lines[i]?.trim() !== "{") continue;

    let depth = 0;
    const jsonLines: string[] = [];
    for (; i < lines.length; i++) {
      const chunk = lines[i] ?? "";
      jsonLines.push(chunk);
      for (const ch of chunk) {
        if (ch === "{") depth += 1;
        else if (ch === "}") depth -= 1;
      }
      if (depth === 0) break;
    }

    try {
      const data = JSON.parse(jsonLines.join("\n")) as { variants?: Record<string, unknown> };
      result.set(modelId, Object.keys(data.variants ?? {}).sort());
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
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
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
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr.trim() || `opencode models --verbose exited with code ${code}`));
    });
  });
}

function cacheIsFresh(): boolean {
  return cache !== null && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
}

/** Load variant keys from the local OpenCode install. Returns false when unavailable. */
export async function refreshOpencodeVariantCache(binary = "opencode"): Promise<boolean> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const output = await fetchOpencodeModelsVerbose(binary);
      cache = {
        variants: parseOpencodeModelsVerbose(output),
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

/** Effort levels for an OpenCode model: live cache first, static heuristics as fallback. */
export function getOpencodeEfforts(model: string): readonly string[] {
  if (cacheIsFresh() && cache!.variants.has(model)) {
    return cache!.variants.get(model)!;
  }
  return fallbackOpencodeEfforts(model);
}

/** Whether a fresh variant cache is loaded (tests may inject via `setOpencodeVariantCacheForTests`). */
export function hasOpencodeVariantCache(): boolean {
  return cacheIsFresh();
}

/** @internal Test helper — inject a variant cache without spawning OpenCode. */
export function setOpencodeVariantCacheForTests(
  variants: Map<string, readonly string[]>,
): void {
  cache = { variants, fetchedAt: Date.now(), binary: "opencode" };
}

/** @internal Test helper — clear the in-memory variant cache. */
export function clearOpencodeVariantCacheForTests(): void {
  cache = null;
  refreshPromise = null;
}
