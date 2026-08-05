import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Locating the built CLI bundle the engine is forked from.
 *
 * The layout is the same in development and in a packaged app — `main.cjs`
 * lives in `<root>/dist-electron/` and the CLI in `<root>/dist/` — but the two
 * ways of naming that root disagree. `app.getAppPath()` is only the root when
 * Electron was pointed at a directory containing a `package.json`; launching
 * the main script directly (`electron dist-electron/main.cjs`, which is what
 * `npm run dev:electron` does) makes it the *script's* directory, and the CLI
 * is then looked for at `dist-electron/dist/index.js`, which never exists.
 *
 * So the main script's own location is the primary answer and the app path is
 * the fallback, rather than the other way round.
 */

export interface ResolveEntryOptions {
  /** Directory of the built `main.cjs` (`__dirname`). */
  mainDir: string;
  /** `app.getAppPath()`. */
  appPath: string;
  /** Injected for tests. */
  exists?: (path: string) => boolean;
}

/** Candidate locations for the CLI bundle, in the order they are tried. */
export function entryCandidates(mainDir: string, appPath: string): string[] {
  const candidates = [join(mainDir, "..", "dist", "index.js"), join(appPath, "dist", "index.js")];
  return candidates.filter((path, index) => candidates.indexOf(path) === index);
}

/**
 * Absolute path to the built CLI entry.
 *
 * Throws with every path tried, because "not built" and "built somewhere the
 * app didn't look" are the two failures here and the message has to tell them
 * apart.
 */
export function resolveEntry(options: ResolveEntryOptions): string {
  const { mainDir, appPath, exists = existsSync } = options;
  const candidates = entryCandidates(mainDir, appPath);
  const entry = candidates.find(exists);
  if (!entry) {
    throw new Error(
      `steamtrain is not built: no CLI bundle found at\n${candidates
        .map((path) => `  ${path}`)
        .join("\n")}\nRun \`npm run build\` and try again.`,
    );
  }
  return entry;
}
