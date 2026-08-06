import { existsSync } from "node:fs";
import { basename, dirname, sep } from "node:path";

/**
 * The recently-opened project list.
 *
 * Small enough to be obvious, kept separate from the store so the ordering
 * rules can be tested without a filesystem.
 */

/** How many projects the File menu offers. Beyond this the list stops being a shortcut. */
export const RECENTS_LIMIT = 8;

/**
 * Put `dir` at the front, removing any earlier occurrence.
 *
 * Re-opening a project moves it up rather than adding a duplicate, which is
 * what makes the list stay useful without any explicit management.
 */
export function addRecent(
  recents: readonly string[],
  dir: string,
  limit: number = RECENTS_LIMIT,
): string[] {
  return [dir, ...recents.filter((entry) => entry !== dir)].slice(0, limit);
}

/** Drop a project from the list — used when it turns out not to exist. */
export function removeRecent(recents: readonly string[], dir: string): string[] {
  return recents.filter((entry) => entry !== dir);
}

/**
 * Drop entries that are no longer directories on this machine.
 *
 * Projects get moved, renamed and deleted, and a menu offering a folder that
 * errors when picked is worse than a shorter menu.
 */
export function pruneRecents(
  recents: readonly string[],
  exists: (path: string) => boolean = existsSync,
): string[] {
  return recents.filter(exists);
}

export interface RecentLabel {
  /** What the menu item says. */
  label: string;
  path: string;
}

/**
 * Label each project by folder name, disambiguated by its parent only where
 * two entries would otherwise read identically.
 *
 * Checkouts of the same repository under different roots are the common case
 * here — `steamtrain` twice in a menu is useless, and showing the full path for
 * every entry to fix that makes the menu unreadable.
 */
export function labelRecents(recents: readonly string[]): RecentLabel[] {
  const counts = new Map<string, number>();
  for (const dir of recents) {
    const name = basename(dir);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return recents.map((dir) => {
    const name = basename(dir);
    if ((counts.get(name) ?? 0) < 2) return { label: name, path: dir };
    const parent = basename(dirname(dir));
    // A project directly under the filesystem root has no parent worth naming;
    // the full path is then the only honest label.
    return { label: parent ? `${parent}${sep}${name}` : dir, path: dir };
  });
}
