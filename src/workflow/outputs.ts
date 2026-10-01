import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { WorkflowOutputResult } from "./events";
import { STEAMTRAIN_STATE_DIR, atomicWriteFile, isOutside, sanitizePathComponent } from "./fs-util";
import { PLACEHOLDER, type TemplateContext, renderPrompt, templateStepReads } from "./template";
import { type WorkflowSpec, touchesStateDir } from "./types";

/**
 * Workflow outputs: the named results a workflow declares next to its inputs
 * (`outputs` in the spec). When a run ends, each one is rendered from the
 * steps' results and written to a file, so a bug hunt's report outlives the
 * terminal it scrolled past in. The run history records where each file went.
 */

/** Where an output with no `path` goes, under the directory the run started in. */
const WORKFLOW_OUTPUTS_DIR = `${STEAMTRAIN_STATE_DIR}/outputs`;

/** `2026-09-27_10-47-12`, in local time: sorts by date and reads at a glance. */
function runTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

export interface WriteOutputsOptions {
  /** The directory the run started in. Spec paths resolve here and must stay inside. */
  cwd: string;
  /** When the run started; names the default directory and `{{run.timestamp}}`. */
  startedAt: number;
  /** The run's final template context: input, inputs, step outputs and results. */
  context: TemplateContext;
  /** Each step's final result, to tell a finished step from one that never did. */
  results: ReadonlyMap<
    string,
    { ok: boolean; skipped?: boolean; interrupted?: boolean; notRun?: boolean }
  >;
  /**
   * Destinations the person running chose (`--out key=path`), by output key.
   * Resolved against `cwd` when relative, and not held to it: unlike a path
   * in the spec, which may come from any repository, these are theirs.
   */
  paths?: Readonly<Record<string, string>>;
  /**
   * Asked before each output is written: a reason to write no more (the run
   * was handed to a background runner that will write them), or undefined to
   * carry on. A hand-off can land while earlier outputs are being written.
   */
  stopWith?: () => string | undefined;
  /**
   * The default directory a run has claimed, shared between writes of the same
   * run: a second write (the outputs a failed hand-off left, say) goes to the
   * directory the first one made rather than to a `-2` beside it.
   */
  claimed?: { runDir?: Promise<string> };
}

/**
 * Render and write every declared output. Never throws: an output that cannot
 * be written comes back with `written: false` and the reason, and the others
 * are still written.
 */
export async function writeWorkflowOutputs(
  spec: WorkflowSpec,
  options: WriteOutputsOptions,
): Promise<WorkflowOutputResult[]> {
  const timestamp = runTimestamp(new Date(options.startedAt));
  const claimed = options.claimed ?? {};
  const all: WorkflowOutputResult[] = [];
  // Outputs on the default path that were not written: the directory they
  // would have gone to is only known once every output has had its turn.
  const unwrittenDefault: WorkflowOutputResult[] = [];
  for (const [key, output] of Object.entries(spec.outputs ?? {})) {
    const result: WorkflowOutputResult = { key, written: false };
    if (output.description) result.description = output.description;
    all.push(result);
    try {
      // A hand-off stops an output as a step that did not finish does: it is
      // not written, and says where it would have gone.
      const unfinished = options.stopWith?.() ?? unfinishedStep(output.value, options.results);
      const chosen =
        options.paths && Object.hasOwn(options.paths, key) ? options.paths[key] : undefined;
      const specPath =
        output.path !== undefined
          ? resolve(options.cwd, renderOutputPath(output.path, spec, timestamp, options))
          : undefined;
      if (unfinished) {
        result.error = unfinished;
        if (chosen !== undefined) result.path = resolve(options.cwd, chosen);
        else if (specPath !== undefined) result.path = specPath;
        else unwrittenDefault.push(result);
        continue;
      }
      // Only `--out` is the person's own choice and left unchecked: a spec's
      // path and the default directory both come with the repository, which
      // can make either a symlink to somewhere else.
      const held = chosen === undefined;
      let path: string;
      if (chosen !== undefined) {
        path = resolve(options.cwd, chosen);
      } else if (specPath !== undefined) {
        path = specPath;
      } else {
        // Named before the checks, so a refusal still says where it was meant to go.
        const intended = join(defaultRunDir(options.cwd, spec, timestamp), `${key}.md`);
        result.path = intended;
        await assertInside(options.cwd, intended);
        // Claimed only when an output is about to be written, so a run that
        // writes nothing leaves no empty directory behind.
        claimed.runDir ??= claimRunDir(defaultRunDir(options.cwd, spec, timestamp));
        path = join(await claimed.runDir, `${key}.md`);
      }
      result.path = path;
      if (held) await assertInside(options.cwd, path);
      await mkdir(dirname(path), { recursive: true });
      // Checked again once its directories exist, in case one was swapped
      // for a symlink in between.
      if (held) await assertInside(options.cwd, path);
      const text = renderPrompt(output.value, options.context, { redact: false });
      const body = text.endsWith("\n") || text === "" ? text : `${text}\n`;
      // Written whole or not at all, and by rename, which replaces a symlink
      // swapped in since the check rather than writing through it.
      await atomicWriteFile(path, body);
      result.written = true;
      result.bytes = Buffer.byteLength(body);
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }
  }
  if (unwrittenDefault.length > 0) {
    const dir =
      (await claimed.runDir?.catch(() => undefined)) ?? defaultRunDir(options.cwd, spec, timestamp);
    for (const result of unwrittenDefault) result.path = join(dir, `${result.key}.md`);
  }
  return all;
}

/**
 * Why an output's value cannot be rendered: the first step it reads that did
 * not finish ok. A step read only for how it ended (`ok`, `error`,
 * `exitCode`) just has to have run, so an output can report a failure.
 */
function unfinishedStep(
  value: string,
  results: WriteOutputsOptions["results"],
): string | undefined {
  for (const [id, read] of templateStepReads(value)) {
    const result = results.get(id);
    if (!result || result.notRun) return `step '${id}' did not run`;
    if (read === "status") continue;
    if (result.skipped) return `step '${id}' was skipped`;
    if (result.interrupted) return `step '${id}' was interrupted`;
    if (!result.ok) return `step '${id}' failed`;
  }
  return undefined;
}

function defaultRunDir(cwd: string, spec: WorkflowSpec, timestamp: string): string {
  return join(cwd, WORKFLOW_OUTPUTS_DIR, safeSegment(spec.name), timestamp);
}

/**
 * Take the run's own default directory. Two runs of one workflow that start
 * in the same second would otherwise write into the same one, so the second
 * gets `<timestamp>-2`.
 */
async function claimRunDir(dir: string): Promise<string> {
  await mkdir(dirname(dir), { recursive: true });
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? dir : `${dir}-${n}`;
    try {
      await mkdir(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || n >= 100) throw error;
    }
  }
}

/**
 * Fill in a spec path's placeholders. Each value becomes one path segment:
 * an input cannot add directories, climb out with `..`, or name `.git`.
 */
function renderOutputPath(
  template: string,
  spec: WorkflowSpec,
  timestamp: string,
  options: WriteOutputsOptions,
): string {
  return template.replace(PLACEHOLDER, (match, expr: string) => {
    if (expr === "workflow") return safeSegment(spec.name);
    if (expr === "run.timestamp") return timestamp;
    if (expr.startsWith("inputs.")) {
      const inputs = options.context.inputs ?? {};
      const name = expr.slice(7);
      return safeSegment(Object.hasOwn(inputs, name) ? String(inputs[name] ?? "") : "");
    }
    return match;
  });
}

function safeSegment(value: string): string {
  const cleaned = sanitizePathComponent(value);
  return /^\.*$/.test(cleaned) || cleaned.toLowerCase() === ".git" ? `_${cleaned}` : cleaned;
}

/**
 * Refuse a spec path that leads out of the run's directory or into its `.git`,
 * compared after following symlinks, and a file that is itself a symlink. The
 * directories that do not exist yet are judged by the deepest one that does,
 * so a symlink on the way is caught before `mkdir` creates anything through it.
 */
async function assertInside(cwd: string, path: string): Promise<void> {
  const refuse = (): never => {
    throw new Error(`refusing to write outside ${cwd}: ${path}`);
  };
  const lexical = relative(resolve(cwd), resolve(path));
  if (isOutside(lexical) || lexical === "") refuse();
  const root = await realpath(cwd);
  const target = join(await realpathOfExisting(dirname(resolve(path))), basename(path));
  const rel = relative(root, target);
  if (isOutside(rel) || rel === "") refuse();
  const segments = rel.split(/[\\/]/);
  if (segments.some((segment) => segment.toLowerCase() === ".git")) refuse();
  // The run history and step cache are `.steamtrain/`'s other contents: an
  // output that replaced one would corrupt the engine's own state.
  if (touchesStateDir(segments)) refuse();
  const existing = await lstat(target).catch(() => undefined);
  if (existing?.isSymbolicLink()) refuse();
}

/** `dir` with symlinks followed as far as it exists; the missing rest is appended as written. */
async function realpathOfExisting(dir: string): Promise<string> {
  const missing: string[] = [];
  for (let current = dir; ; current = dirname(current)) {
    try {
      return join(await realpath(current), ...missing);
    } catch (error) {
      const parent = dirname(current);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === current) throw error;
      missing.unshift(basename(current));
    }
  }
}
