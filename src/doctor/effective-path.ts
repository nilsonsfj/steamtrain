import { existsSync } from "node:fs";
import { delimiter } from "node:path";

/**
 * What `PATH` the engine is actually resolving agent binaries against.
 *
 * `resolveBinary` scans `process.env.PATH` and reports `binary_missing` when it
 * finds nothing. From the outside those two facts are indistinguishable from
 * "the agent isn't installed", which is exactly the wrong conclusion when the
 * real cause is a GUI launch inheriting a stub `PATH` — the app has to recover
 * the login shell's `PATH` itself (`electron/main/shell-path.ts`), and when
 * that recovery misfires there is currently nothing to look at.
 *
 * So the doctor reports the list it searched and where the list came from. This
 * is a diagnostic, not a control: nothing here changes resolution.
 */

/** How the engine came by its `PATH`. */
export type PathSource =
  /** Inherited from whoever launched the process — a terminal, usually. */
  | "inherited"
  /** Recovered from the user's login shell by the desktop app. */
  | "login-shell"
  /** The desktop app's shell probe failed and it fell back to a directory scan. */
  | "fallback";

export interface PathEntry {
  dir: string;
  /** False for a directory that is on `PATH` but not on disk. */
  exists: boolean;
}

export interface EffectivePath {
  entries: PathEntry[];
  source: PathSource;
  /**
   * Free-text detail from the host, e.g. which shell answered. Never parsed —
   * it exists to be read by a person looking at the setup panel.
   */
  detail?: string;
  /** True when the engine was forked by the desktop app. */
  desktop: boolean;
}

/**
 * A `PATH` source string is only trusted when it is one we defined; anything
 * else is reported as inherited rather than echoed back into the UI.
 */
function readSource(raw: string | undefined): PathSource {
  return raw === "login-shell" || raw === "fallback" ? raw : "inherited";
}

export interface DescribeEffectivePathOptions {
  /** Injected for tests. */
  exists?: (path: string) => boolean;
}

/**
 * Describe the `PATH` this process resolves binaries against.
 *
 * Duplicate entries are collapsed — a `PATH` assembled from a login shell and a
 * fallback union routinely repeats directories, and a list showing
 * `/usr/local/bin` four times obscures the one line that matters.
 */
export function describeEffectivePath(
  env: NodeJS.ProcessEnv = process.env,
  options: DescribeEffectivePathOptions = {},
): EffectivePath {
  const { exists = existsSync } = options;
  const seen = new Set<string>();
  const entries: PathEntry[] = [];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    entries.push({ dir, exists: exists(dir) });
  }
  const detail = env.STEAMTRAIN_PATH_DETAIL?.trim();
  return {
    entries,
    source: readSource(env.STEAMTRAIN_PATH_SOURCE),
    ...(detail ? { detail } : {}),
    desktop: env.STEAMTRAIN_DESKTOP === "1",
  };
}
