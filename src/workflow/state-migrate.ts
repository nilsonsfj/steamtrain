/**
 * Schema migrators for on-disk workflow state (cache, history, live-run meta).
 *
 * These exist *before* the next version bump so a bump has an upgrade path
 * instead of silently discarding every stored file. Today every store is at
 * its current version with no prior formats to lift — the migrators are
 * identity passes that still validate, and the switch arms are the place to
 * add vN→vN+1 transforms when a constant is incremented.
 */

export type MigrateResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Walk `parsed.version` up to `currentVersion`, applying `steps[from]` for
 * each hop. Unknown / future versions fail closed (caller treats as absent).
 */
export function migrateStateVersion<T extends { version: number }>(
  parsed: unknown,
  currentVersion: number,
  steps: Record<number, (value: Record<string, unknown>) => Record<string, unknown> | undefined>,
): MigrateResult<T> {
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, reason: "not an object" };
  }
  let value = { ...(parsed as Record<string, unknown>) };
  const rawVersion = value.version;
  if (typeof rawVersion !== "number" || !Number.isInteger(rawVersion)) {
    return { ok: false, reason: "missing version" };
  }
  let version = rawVersion;
  if (version > currentVersion) {
    return { ok: false, reason: `future version ${version}` };
  }
  while (version < currentVersion) {
    const step = steps[version];
    if (!step) {
      return { ok: false, reason: `no migrator from version ${version}` };
    }
    const next = step(value);
    if (!next || typeof next.version !== "number") {
      return { ok: false, reason: `migrator from version ${version} failed` };
    }
    value = next;
    version = next.version;
  }
  if (version !== currentVersion) {
    return { ok: false, reason: `version ${version} !== ${currentVersion}` };
  }
  return { ok: true, value: value as T };
}
