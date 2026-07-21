import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { homeRelativePath } from "./paths";

/** How the display name for a project was chosen. */
export type ProjectNameSource = "config" | "package" | "directory";

/**
 * Resolved identity for the project steamtrain is operating on — the directory
 * that owns `steamtrain.json`, `.steamtrain/`, and agent cwd.
 */
export interface ProjectIdentity {
  /** Absolute project directory. */
  cwd: string;
  /** Short display name shown in chrome. */
  name: string;
  /** Home-relative path for secondary display (`~/…`). */
  displayPath: string;
  /** Where {@link name} came from. */
  nameSource: ProjectNameSource;
}

export interface ResolveProjectDirOptions {
  /** Base for relative paths (defaults to `process.cwd()`). */
  from?: string;
}

export type ResolveProjectDirResult = { ok: true; cwd: string } | { ok: false; error: string };

/**
 * Resolve and validate a project directory. Relative paths are resolved against
 * `from` (launch cwd). Does not create directories — the path must already exist
 * and be a directory so agents and `.steamtrain/` land somewhere real.
 */
export function resolveProjectDir(
  raw: string,
  opts: ResolveProjectDirOptions = {},
): ResolveProjectDirResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: "project directory path is empty" };
  }
  const cwd = resolve(opts.from ?? process.cwd(), trimmed);
  if (!existsSync(cwd)) {
    return { ok: false, error: `project directory does not exist: ${cwd}` };
  }
  try {
    if (!statSync(cwd).isDirectory()) {
      return { ok: false, error: `project directory is not a directory: ${cwd}` };
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `cannot read project directory: ${detail}` };
  }
  return { ok: true, cwd };
}

export interface ResolveProjectIdentityOptions {
  home?: string;
  /**
   * Explicit name from `steamtrain.json` (`name` field). Wins over package.json
   * and the directory basename when non-empty.
   */
  configName?: string;
}

/**
 * Build the display identity for a project directory.
 *
 * Name priority: config `name` → package.json `name` → directory basename.
 */
export function resolveProjectIdentity(
  cwd: string,
  opts: ResolveProjectIdentityOptions = {},
): ProjectIdentity {
  const absolute = resolve(cwd);
  const home = opts.home ?? homedir();
  const displayPath = homeRelativePath(absolute, home);
  const configName = sanitizeProjectName(opts.configName);
  if (configName) {
    return { cwd: absolute, name: configName, displayPath, nameSource: "config" };
  }
  const packageName = readPackageName(absolute);
  if (packageName) {
    return { cwd: absolute, name: packageName, displayPath, nameSource: "package" };
  }
  const dirName = basename(absolute) || absolute;
  return { cwd: absolute, name: dirName, displayPath, nameSource: "directory" };
}

/** Trim and reject empty / path-like junk for a project display name. */
export function sanitizeProjectName(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  // Keep names short and printable for chrome; drop control characters.
  const cleaned = trimmed.replace(/[\r\n\t]+/g, " ").slice(0, 80);
  return cleaned || undefined;
}

function readPackageName(cwd: string): string | undefined {
  try {
    const raw = readFileSync(resolve(cwd, "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return sanitizeProjectName((parsed as { name?: unknown }).name as string | undefined);
  } catch {
    return undefined;
  }
}

/**
 * Compact one-line label for narrow TUI chrome. Always leads with the project
 * name; attaches the home-relative path as secondary when it adds information.
 */
export function formatProjectLabel(
  identity: ProjectIdentity,
  maxWidth = 42,
): { primary: string; secondary?: string } {
  const name = identity.name;
  const path = identity.displayPath;
  if (name === path) {
    return { primary: shortenEnd(name, maxWidth) };
  }
  const combined = `${name} · ${path}`;
  if (combined.length <= maxWidth) return { primary: name, secondary: path };
  if (name.length + 3 >= maxWidth) return { primary: shortenEnd(name, maxWidth) };
  return {
    primary: name,
    secondary: shortenMiddle(path, Math.max(8, maxWidth - name.length - 3)),
  };
}

function shortenEnd(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  return `${text.slice(0, max - 1)}…`;
}

function shortenMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  if (max <= 3) return `${text.slice(0, max - 1)}…`;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}
