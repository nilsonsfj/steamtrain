import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The desktop app's own persisted state: which projects were opened recently
 * and how the window was last arranged.
 *
 * Deliberately separate from `~/.steamtrain/` — nothing here is steamtrain
 * configuration. It is window furniture, and a CLI user who never opens the app
 * should not acquire a file describing one.
 *
 * Every read is best-effort. A corrupt or unreadable state file must degrade to
 * "first launch", never to a failed start: the whole file is a convenience, and
 * losing it costs the user one folder pick.
 */

export interface WindowStateShape {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface DesktopState {
  /** Most-recently-opened first. */
  recents: string[];
  window?: WindowStateShape;
  /**
   * Name of the last workflow the user had open, per project.
   *
   * Keyed by project directory because the last workflow means nothing once
   * the window is pointed at a different project. The web UI's own
   * `localStorage` copy of this can't survive a restart on its own: the
   * embedded server picks a new port every launch, so its origin changes and
   * `localStorage` resets with it.
   */
  lastWorkflow?: Record<string, string>;
}

const EMPTY: DesktopState = { recents: [] };

/** Filename inside the Electron `userData` directory. */
export const STATE_FILE = "desktop-state.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Coerce whatever was on disk into a `DesktopState`.
 *
 * Field-by-field rather than trusting the shape: this file is rewritten by
 * every version of the app and hand-editable, so a stale or partial record has
 * to yield a usable state rather than an exception at startup.
 */
export function parseState(raw: string): DesktopState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY };
  }
  if (!isRecord(parsed)) return { ...EMPTY };

  const recents = Array.isArray(parsed.recents)
    ? parsed.recents.filter((entry): entry is string => typeof entry === "string" && entry !== "")
    : [];

  const win = isRecord(parsed.window) ? parsed.window : undefined;
  const width = typeof win?.width === "number" ? win.width : undefined;
  const height = typeof win?.height === "number" ? win.height : undefined;
  // Width and height are the two fields the rest of the code may not do
  // without, so a record missing either is no window state at all.
  const window: WindowStateShape | undefined =
    width && height
      ? {
          ...(typeof win?.x === "number" ? { x: win.x } : {}),
          ...(typeof win?.y === "number" ? { y: win.y } : {}),
          width,
          height,
          maximized: win?.maximized === true,
        }
      : undefined;

  const lastWorkflowRaw =
    isRecord(parsed.lastWorkflow) && !Array.isArray(parsed.lastWorkflow)
      ? parsed.lastWorkflow
      : undefined;
  const lastWorkflow: Record<string, string> | undefined = lastWorkflowRaw
    ? Object.fromEntries(
        Object.entries(lastWorkflowRaw).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
        ),
      )
    : undefined;

  return {
    recents,
    ...(window ? { window } : {}),
    ...(lastWorkflow && Object.keys(lastWorkflow).length > 0 ? { lastWorkflow } : {}),
  };
}

/**
 * Drop `lastWorkflow` entries for projects no longer in `recents`.
 *
 * `recents` is already pruned/trimmed/cleared in several places; without this
 * `lastWorkflow` would grow by one key per project ever opened, forever.
 */
export function pruneLastWorkflow(
  lastWorkflow: Record<string, string> | undefined,
  recents: readonly string[],
): Record<string, string> | undefined {
  if (!lastWorkflow) return undefined;
  const kept = new Set(recents);
  const entries = Object.entries(lastWorkflow).filter(([dir]) => kept.has(dir));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export interface StateStore {
  read(): DesktopState;
  write(state: DesktopState): void;
}

/**
 * A `StateStore` backed by a JSON file under `userData`.
 *
 * Writes go via a temporary file and a rename, so a crash mid-write leaves the
 * previous state rather than a truncated file the next launch would discard.
 */
export function createStateStore(userDataDir: string): StateStore {
  const file = join(userDataDir, STATE_FILE);
  return {
    read(): DesktopState {
      try {
        return parseState(readFileSync(file, "utf8"));
      } catch {
        // No file yet, or unreadable — either way, this is a first launch.
        return { ...EMPTY };
      }
    },
    write(state: DesktopState): void {
      try {
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
        renameSync(tmp, file);
      } catch (err) {
        // Losing window position is not worth interrupting anything over.
        console.warn("[steamtrain] could not save desktop state:", err);
      }
    },
  };
}
