import { homedir } from "node:os";
import { resolve, sep } from "node:path";

/** Show paths under `home` as `~/…` instead of an absolute path. */
export function homeRelativePath(path: string, home: string = homedir()): string {
  const resolvedHome = resolve(home);
  const resolvedPath = resolve(path);
  if (resolvedPath === resolvedHome) return "~";
  const prefix = resolvedHome.endsWith(sep) ? resolvedHome : `${resolvedHome}${sep}`;
  if (resolvedPath.startsWith(prefix)) {
    return `~${resolvedPath.slice(resolvedHome.length)}`;
  }
  return resolvedPath;
}
