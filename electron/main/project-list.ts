import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, sep } from "node:path";

/**
 * The project list behind the topbar's project switcher.
 *
 * The menu shows each known project by name and real path, plus the one fact
 * that decides whether you want to go there: what is running or broken in it
 * *right now*. That answer comes from the project's own live-run registry
 * (`.steamtrain/runs/<id>/meta.json`) rather than its run history — history
 * would mean parsing up to a hundred whole records per project to answer a
 * menu, and "what happened last week" is not what the row is for.
 *
 * Everything here is best-effort: a project the app cannot read must yield a
 * row saying "idle", never an error. The switcher has to open.
 */

/** Mirrors `WORKFLOW_RUNS_DIR` in src/workflow/live-run-store.ts. */
export const RUNS_DIR = ".steamtrain/runs";

/**
 * Mirrors `LIVE_RUN_HEARTBEAT_STALE_MS` in src/workflow/live-run-store.ts —
 * an owner whose heartbeat is older than this is dead even if its pid answers
 * (pid reuse). Duplicated rather than imported so the desktop bundle does not
 * pull the engine in; `tests/electron-project-picker.test.ts` holds the two
 * values together.
 */
export const HEARTBEAT_STALE_MS = 60_000;

/**
 * Mirrors `LIVE_RUN_ORPHAN_GRACE_MS` — the window in which a detached run that
 * has not yet reported its own pid (`pid: -1`) still counts as starting up.
 */
export const ORPHAN_GRACE_MS = 30_000;

/** What is happening in a project at this moment. */
export interface ProjectActivity {
  /** Runs executing or queued, with an owner that still looks alive. */
  running: number;
  /** Runs that ended badly and are still in the live window. */
  failed: number;
}

export interface ProjectEntry extends ProjectActivity {
  /** Absolute directory — what `steamtrain:open-project` is called with. */
  path: string;
  /** Display name: `steamtrain.json` name, else package name, else folder. */
  name: string;
  /** Home-relative path for the second line (`~/projects/camelo`). */
  displayPath: string;
  /** The project this window is already showing. */
  current: boolean;
}

/** The fields of a live-run `meta.json` this module reads. Everything is optional: the file is written by other processes and by older versions. */
export interface LiveRunMetaLike {
  status?: unknown;
  ok?: unknown;
  pid?: unknown;
  heartbeatAt?: unknown;
  createdAt?: unknown;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Best-effort "is this pid still around", matching the engine's own check (EPERM counts as alive). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "EPERM");
  }
}

/**
 * Whether a non-terminal entry's owner is still alive — the same three rules
 * the engine's queue uses, in the same order: a detached child that has not
 * reported in (`pid: -1`) is alive inside the spawn grace window; a stale
 * heartbeat beats a live pid; otherwise the pid decides.
 *
 * Without this a crashed run would leave a project reading "1 running" until
 * someone opened it and swept the registry.
 *
 * The canonical version is `isLiveRunOwnerAlive` in
 * src/workflow/live-run-store.ts — change that and this has to follow. The
 * constants are held together by `tests/electron-project-picker.test.ts`; the
 * *rules* are not, so read the original before editing either.
 */
function ownerAlive(
  meta: LiveRunMetaLike,
  now: number,
  isAlive: (pid: number) => boolean,
): boolean {
  const pid = num(meta.pid);
  // `<=`, not `<`, in both windows: the engine counts the exact boundary as
  // alive, and a switcher that disagreed with it by one tick would report a
  // run the engine is still executing as gone.
  if (pid === -1) {
    const createdAt = num(meta.createdAt);
    return createdAt === undefined || now - createdAt <= ORPHAN_GRACE_MS;
  }
  if (pid === undefined || !isAlive(pid)) return false;
  const heartbeat = num(meta.heartbeatAt);
  return heartbeat === undefined || now - heartbeat <= HEARTBEAT_STALE_MS;
}

/**
 * Fold a project's live-run metas into the one line the menu shows.
 *
 * A canceled run is neither running nor broken — someone already dealt with
 * it, so it must not draw the eye to a project there is no reason to visit.
 */
export function summarizeRuns(
  metas: readonly LiveRunMetaLike[],
  now: number = Date.now(),
  isAlive: (pid: number) => boolean = pidAlive,
): ProjectActivity {
  let running = 0;
  let failed = 0;
  for (const meta of metas) {
    const status = typeof meta.status === "string" ? meta.status : "";
    if (status === "running" || status === "queued") {
      if (ownerAlive(meta, now, isAlive)) running += 1;
      continue;
    }
    // A cancel is recorded as `ok: false` too, so the status has to be ruled
    // out before that fallback runs.
    if (status === "canceled") continue;
    if (status === "error" || status === "budget-exceeded" || meta.ok === false) failed += 1;
  }
  return { running, failed };
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const raw = value[field];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw
    .trim()
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 80);
  return trimmed || undefined;
}

/**
 * Name a project the way the engine does: the `name` in `steamtrain.json`,
 * then the package name, then the folder. Reimplemented here (rather than
 * imported from `src/project.ts`) because main runs before any engine exists
 * for the projects it is *not* currently serving.
 */
export async function projectName(dir: string): Promise<string> {
  const config = stringField(await readJson(join(dir, "steamtrain.json")), "name");
  if (config) return config;
  const pkg = stringField(await readJson(join(dir, "package.json")), "name");
  if (pkg) return pkg;
  return basename(dir) || dir;
}

/** `~/projects/camelo` where the path is under `home`, the absolute path otherwise. */
export function displayPath(dir: string, home: string): string {
  if (!home) return dir;
  if (dir === home) return "~";
  return dir.startsWith(home + sep) ? `~${dir.slice(home.length)}` : dir;
}

/** Read one project's live-run registry. A project with no `.steamtrain/runs` is simply idle. */
export async function readActivity(
  dir: string,
  now: number = Date.now(),
): Promise<ProjectActivity> {
  const root = join(dir, RUNS_DIR);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return { running: 0, failed: 0 };
  }
  const metas = await Promise.all(entries.map((id) => readJson(join(root, id, "meta.json"))));
  return summarizeRuns(metas.filter(isRecord), now);
}

export interface ListProjectsOptions {
  /** Recently-opened projects, most recent first. */
  recents: readonly string[];
  /** The project this window is showing, if any. */
  current?: string;
  home: string;
  now?: number;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The rows the switcher renders: the open project first, then the recents in
 * their own order, deduplicated, with anything no longer on disk dropped.
 *
 * The current project stays in the list rather than being hidden — it is the
 * row that shows as selected, which is what tells you where the menu is
 * measuring "running" and "failed" from.
 */
export async function listProjects(opts: ListProjectsOptions): Promise<ProjectEntry[]> {
  const now = opts.now ?? Date.now();
  const ordered = [...(opts.current ? [opts.current] : []), ...opts.recents];
  const seen = new Set<string>();
  const dirs = ordered.filter((dir) => {
    if (!dir || seen.has(dir)) return false;
    seen.add(dir);
    return true;
  });
  const rows = await Promise.all(
    dirs.map(async (dir) => {
      if (!(await isDirectory(dir))) return undefined;
      const [name, activity] = await Promise.all([projectName(dir), readActivity(dir, now)]);
      return {
        path: dir,
        name,
        displayPath: displayPath(dir, opts.home),
        current: dir === opts.current,
        ...activity,
      };
    }),
  );
  return rows.filter((row): row is ProjectEntry => row !== undefined);
}
