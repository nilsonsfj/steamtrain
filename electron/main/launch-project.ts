import { resolve } from "node:path";

const ELECTRON_OPTIONS_WITH_VALUES = new Set(["--user-data-dir"]);

export interface LaunchProjectPathOptions {
  argv: readonly string[];
  packaged: boolean;
  cwd?: string;
}

/**
 * Read an optional project path from the arguments Electron passes to the main
 * process. Development launches include the main script; packaged launches do
 * not.
 */
export function launchProjectPath(options: LaunchProjectPathOptions): string | undefined {
  const { argv, packaged, cwd = process.cwd() } = options;
  const args = argv.slice(packaged ? 1 : 2);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--") {
      const path = args[index + 1];
      return path ? resolve(cwd, path) : undefined;
    }
    if (arg === "--project-dir" || arg === "--cwd") {
      const path = args[index + 1];
      return path && !path.startsWith("-") ? resolve(cwd, path) : undefined;
    }
    if (arg.startsWith("-")) {
      if (ELECTRON_OPTIONS_WITH_VALUES.has(arg)) index += 1;
      continue;
    }
    return resolve(cwd, arg);
  }

  return undefined;
}

export interface SelectLaunchProjectOptions {
  explicitPath?: string;
  recents: readonly string[];
  isDirectory: (path: string) => boolean;
}

/**
 * Use an explicitly supplied project first, then the most recent usable
 * project. An undefined result means the folder picker is needed.
 */
export function selectLaunchProject(options: SelectLaunchProjectOptions): string | undefined {
  if (options.explicitPath) return options.explicitPath;
  const last = options.recents[0];
  return last && options.isDirectory(last) ? last : undefined;
}
