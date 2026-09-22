/**
 * LRU for the web UI's per-run worktree-diff caches.
 *
 * `cache` holds fetched patch bodies. `expanded` is the paired set of open
 * step rows for the same run ids and is dropped whenever a cache entry is
 * evicted or invalidated — it is not capped on its own. Recency is the cache
 * map's insertion order (oldest at the front).
 *
 * `src/web/public/st-runs.js` keeps a matching copy: that script is classic
 * JS and cannot import this module.
 */

/** How many runs' worktree diffs a long-lived page retains. */
export const RUN_DIFF_CACHE_CAP = 32;

export interface RunDiffMaps<C, E> {
  cache: Map<string, C>;
  expanded: Map<string, E>;
}

/** Cache hit: move `runId` to most-recently-used. A miss does not insert. */
export function touchRunDiff<C, E>(maps: RunDiffMaps<C, E>, runId: string): C | undefined {
  const { cache } = maps;
  if (!cache.has(runId)) return undefined;
  const value = cache.get(runId) as C;
  cache.delete(runId);
  cache.set(runId, value);
  return value;
}

/**
 * Insert or replace `runId` and mark it most-recently-used. Past `cap`, drop
 * the least-recently-used run from both maps.
 */
export function rememberRunDiff<C, E>(
  maps: RunDiffMaps<C, E>,
  runId: string,
  value: C,
  cap: number = RUN_DIFF_CACHE_CAP,
): void {
  const { cache } = maps;
  if (cache.has(runId)) cache.delete(runId);
  cache.set(runId, value);
  while (cache.size > cap) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) return;
    cache.delete(oldest);
    maps.expanded.delete(oldest);
  }
}

/** Drop one run from both maps. Other runs stay put. */
export function invalidateRunDiff<C, E>(maps: RunDiffMaps<C, E>, runId: string): void {
  maps.cache.delete(runId);
  maps.expanded.delete(runId);
}
