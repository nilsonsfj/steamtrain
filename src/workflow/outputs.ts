import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { WorkflowOutputResult } from "./events";
import { STEAMTRAIN_STATE_DIR, isOutside, sanitizePathComponent } from "./fs-util";
import { type TemplateContext, renderPrompt, templateStepIds } from "./template";
import type { WorkflowSpec } from "./types";

/**
 * Workflow outputs: the named results a workflow declares next to its inputs
 * (`outputs` in the spec). When a run ends, each one is rendered from the
 * steps' results and written to a file, so a bug hunt's report outlives the
 * terminal it scrolled past in. The run history records where each file went.
 */

/** Where an output with no `path` goes, under the directory the run started in. */
export const WORKFLOW_OUTPUTS_DIR = `${STEAMTRAIN_STATE_DIR}/outputs`;

/** `2026-09-27_10-47-12`, in local time: sorts by date and reads at a glance. */
export function runTimestamp(date: Date): string {
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
  results: ReadonlyMap<string, { ok: boolean; skipped?: boolean }>;
  /**
   * Destinations the person running chose (`--out key=path`), by output key.
   * Resolved against `cwd` when relative, and not held to it: unlike a path
   * in the spec, which may come from any repository, these are theirs.
   */
  paths?: Readonly<Record<string, string>>;
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
  let runDir: Promise<string> | undefined;
  const written: WorkflowOutputResult[] = [];
  for (const [key, output] of Object.entries(spec.outputs ?? {})) {
    const result: WorkflowOutputResult = { key, written: false };
    if (output.description) result.description = output.description;
    written.push(result);
    try {
      const unfinished = unfinishedStep(output.value, options.results);
      const chosen = options.paths?.[key];
      let path: string;
      if (chosen !== undefined) {
        path = resolve(options.cwd, chosen);
      } else if (output.path !== undefined) {
        path = resolve(options.cwd, renderOutputPath(output.path, spec, timestamp, options));
      } else if (unfinished) {
        path = join(defaultRunDir(options.cwd, spec, timestamp), `${key}.md`);
      } else {
        // Claimed only once something is written, so a run that writes
        // nothing leaves no empty directory behind.
        runDir ??= claimRunDir(defaultRunDir(options.cwd, spec, timestamp));
        path = join(await runDir, `${key}.md`);
      }
      result.path = path;
      if (unfinished) {
        result.error = unfinished;
        continue;
      }
      // Only the spec's own paths are held inside: the default is the
      // engine's state directory, and `--out` is the person's own choice.
      const fromSpec = chosen === undefined && output.path !== undefined;
      if (fromSpec) await assertInside(options.cwd, path);
      await mkdir(dirname(path), { recursive: true });
      // Checked again once its directories exist, so a symlink on the way
      // cannot carry the file out.
      if (fromSpec) await assertInside(options.cwd, path, { resolveLinks: true });
      const text = renderPrompt(output.value, options.context, { redact: false });
      const body = text.endsWith("\n") || text === "" ? text : `${text}\n`;
      await writeFile(path, body, "utf8");
      result.written = true;
      result.bytes = Buffer.byteLength(body);
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }
  }
  return written;
}

/** Why an output's value cannot be rendered yet: the first step it reads that did not finish ok. */
function unfinishedStep(
  value: string,
  results: WriteOutputsOptions["results"],
): string | undefined {
  for (const id of templateStepIds(value)) {
    const result = results.get(id);
    if (!result) return `step '${id}' did not run`;
    if (result.skipped) return `step '${id}' was skipped`;
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
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, expr: string) => {
    if (expr === "workflow") return safeSegment(spec.name);
    if (expr === "run.timestamp") return timestamp;
    if (expr.startsWith("inputs.")) {
      return safeSegment(String(options.context.inputs?.[expr.slice(7)] ?? ""));
    }
    return match;
  });
}

function safeSegment(value: string): string {
  const cleaned = sanitizePathComponent(value);
  return /^\.*$/.test(cleaned) || cleaned.toLowerCase() === ".git" ? `_${cleaned}` : cleaned;
}

/**
 * Refuse a spec path that leads out of the run's directory or into its `.git`.
 * With `resolveLinks`, the directories are compared after following symlinks,
 * and the file itself must not be a symlink.
 */
async function assertInside(
  cwd: string,
  path: string,
  options: { resolveLinks?: boolean } = {},
): Promise<void> {
  const refuse = (): never => {
    throw new Error(`refusing to write outside ${cwd}: ${path}`);
  };
  const root = options.resolveLinks ? await realpath(cwd) : resolve(cwd);
  const target = options.resolveLinks
    ? join(await realpath(dirname(path)), basename(path))
    : resolve(path);
  const rel = relative(root, target);
  if (isOutside(rel) || rel === "") refuse();
  if (rel.split(/[\\/]/).some((segment) => segment.toLowerCase() === ".git")) refuse();
  if (options.resolveLinks) {
    const existing = await lstat(target).catch(() => undefined);
    if (existing?.isSymbolicLink()) refuse();
  }
}
