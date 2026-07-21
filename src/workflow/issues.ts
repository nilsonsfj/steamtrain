import { runCommand } from "./merge";
import { jsonPathGet } from "./structured";
import type { StepResult } from "./types";

/**
 * Building block 6 support module: the `issues` step's collection, dedupe,
 * severity ordering, report rendering, and `gh` CLI plumbing. Kept separate
 * from `engine.ts` (like `merge.ts`) so the pure data-shaping logic (easy to
 * unit test) stays apart from step dispatch and event plumbing.
 */

/** One out-of-scope finding collected from a source step's structured `json`. */
export interface CollectedFinding {
  title: string;
  body?: string;
  severity?: string;
  file?: string;
  line?: number;
  /** The leaf step id the finding was read from — provenance for the report/issue body. */
  sourceStepId: string;
}

export type CollectFindingsOutcome =
  | { ok: true; findings: CollectedFinding[]; malformed: number }
  | { ok: false; error: string };

/**
 * Walk `sourceIds`' recorded results and read each source's `json` at
 * `findingsPath` into a flat findings list. Mirrors `executeMergeStep`'s leaf
 * judgment exactly (see that function's comments): descend ONE level into
 * `childResults` UNLESS the parent itself carries a `worktree` (a future-
 * proofing guard for a step shape that has both, ported verbatim from the
 * merge step so the two collectors never drift); a skipped/not-run leaf
 * contributes nothing; a failed leaf fails the WHOLE collection (a partial
 * findings report built from a failed pipeline would misrepresent what
 * actually happened). A leaf with no structured output, or nothing at
 * `findingsPath`, is not an error — a clean run simply has no findings there.
 */
export function collectFindings(
  sourceIds: string[],
  results: Map<string, StepResult>,
  findingsPath: string,
): CollectFindingsOutcome {
  const findings: CollectedFinding[] = [];
  let malformed = 0;
  for (const id of sourceIds) {
    const result = results.get(id);
    if (!result) return { ok: false, error: `issues source '${id}' has no result` };
    if (result.skipped) continue;
    const leaves = result.worktree
      ? [result]
      : result.childResults?.length
        ? result.childResults
        : [result];
    for (const leaf of leaves) {
      if (leaf.skipped || leaf.notRun) continue;
      if (!leaf.ok) {
        // Surface the source's own error so the failure is debuggable from
        // this step's message alone, without digging through the run record.
        const cause = leaf.error ? `: ${leaf.error}` : "";
        return {
          ok: false,
          error: `issues source '${leaf.stepId}' failed${cause}; findings were not collected`,
        };
      }
      if (leaf.json === undefined) continue;
      const raw = jsonPathGet(leaf.json, findingsPath);
      if (!Array.isArray(raw)) continue;
      for (const item of raw) {
        const parsed = parseFindingItem(item, leaf.stepId);
        if (parsed) findings.push(parsed);
        else malformed += 1;
      }
    }
  }
  return { ok: true, findings, malformed };
}

/** Parse one findings-array entry: a plain string (→ title) or an object with a required `title`. */
function parseFindingItem(item: unknown, sourceStepId: string): CollectedFinding | undefined {
  if (typeof item === "string") {
    const title = item.trim();
    return title ? { title, sourceStepId } : undefined;
  }
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const obj = item as Record<string, unknown>;
    const title = typeof obj.title === "string" ? obj.title.trim() : "";
    if (!title) return undefined;
    return {
      title,
      body: typeof obj.body === "string" ? obj.body : undefined,
      severity: typeof obj.severity === "string" ? obj.severity : undefined,
      file: typeof obj.file === "string" ? obj.file : undefined,
      line: typeof obj.line === "number" ? obj.line : undefined,
      sourceStepId,
    };
  }
  return undefined;
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase();
}

function normalizeFile(file: string | undefined): string {
  return (file ?? "").trim().toLowerCase();
}

/** Dedupe by case-insensitive normalized `title` + `file`, keeping the first occurrence. */
export function dedupeFindings(findings: CollectedFinding[]): CollectedFinding[] {
  const seen = new Set<string>();
  const out: CollectedFinding[] = [];
  for (const finding of findings) {
    const key = `${normalizeTitle(finding.title)}\u0000${normalizeFile(finding.file)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
  }
  return out;
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function severityRank(severity: string | undefined): number {
  if (!severity) return 4;
  return SEVERITY_RANK[severity.toLowerCase()] ?? 4;
}

/** Canonical (lowercased) label for a recognized severity; verbatim text for anything else. */
function severityLabel(severity: string | undefined): string {
  if (!severity) return "unspecified";
  const lower = severity.toLowerCase();
  return lower in SEVERITY_RANK ? lower : severity;
}

/** Sort findings critical > high > medium > low > unknown/other (stable within a rank). */
export function sortBySeverity(findings: CollectedFinding[]): CollectedFinding[] {
  return [...findings]
    .map((finding, index) => ({ finding, index }))
    .sort(
      (a, b) =>
        severityRank(a.finding.severity) - severityRank(b.finding.severity) || a.index - b.index,
    )
    .map((entry) => entry.finding);
}

/** Render the `mode: "report"` markdown output. Always succeeds, even with zero findings. */
export function buildFindingsReport(findings: CollectedFinding[], malformed: number): string {
  if (findings.length === 0) {
    return malformed > 0
      ? `No findings (${malformed} malformed finding item(s) were skipped).`
      : "No findings — clean run.";
  }
  const ordered = sortBySeverity(findings);
  const lines: string[] = [`# Findings (${ordered.length})`];
  let lastLabel: string | undefined;
  for (const finding of ordered) {
    const label = severityLabel(finding.severity);
    if (label !== lastLabel) {
      lines.push("", `## ${label}`);
      lastLabel = label;
    }
    const location = finding.file
      ? ` (${finding.file}${finding.line !== undefined ? `:${finding.line}` : ""})`
      : "";
    lines.push("", `- **${finding.title}**${location} — from \`${finding.sourceStepId}\``);
    if (finding.body) {
      for (const bodyLine of finding.body.split("\n")) lines.push(`  ${bodyLine}`);
    }
  }
  if (malformed > 0) {
    lines.push("", `(${malformed} malformed finding item(s) were skipped)`);
  }
  return lines.join("\n");
}

/** The issue body: the finding's own body plus a provenance footer. */
export function buildIssueBody(finding: CollectedFinding, workflowName: string): string {
  const parts: string[] = [];
  if (finding.body) parts.push(finding.body, "");
  parts.push("---", `Filed automatically by steamtrain workflow \`${workflowName}\`.`);
  parts.push(`Source step: \`${finding.sourceStepId}\``);
  if (finding.file) {
    parts.push(
      `Location: \`${finding.file}${finding.line !== undefined ? `:${finding.line}` : ""}\``,
    );
  }
  parts.push(`Severity: ${finding.severity ?? "unspecified"}`);
  return parts.join("\n");
}

/**
 * The valid rendered values of an issues step's templated `mode` field. The
 * engine renders `mode` at execution time (so an input can switch it) and
 * validates the result against this set — a typo'd render fails loudly
 * instead of silently defaulting.
 */
export const ISSUES_MODES: ReadonlySet<string> = new Set(["report", "github"]);

/** Copy-paste guidance appended to `gh` failures (missing binary or auth). */
export const GH_GUIDANCE =
  'install the GitHub CLI (https://cli.github.com) and run `gh auth login`, or switch this step to mode "report" to avoid the gh dependency';

/**
 * Find an existing issue (any state) whose title exactly matches `title`
 * (case-insensitive, trimmed) via `gh issue list --search`. `gh`'s `--search`
 * is a text search, not an exact filter, so results are re-checked locally
 * before treating anything as a duplicate.
 */
export async function findExistingIssue(
  title: string,
  cwd: string,
  repo: string | undefined,
  signal?: AbortSignal,
): Promise<{ number: number; title: string } | undefined> {
  const args = [
    "issue",
    "list",
    "--search",
    `${title} in:title`,
    "--state",
    "all",
    "--json",
    "number,title",
  ];
  if (repo) args.push("-R", repo);
  const output = await runCommand("gh", args, cwd, signal);
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const normalized = normalizeTitle(title);
  for (const entry of parsed) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as { title?: unknown }).title === "string" &&
      typeof (entry as { number?: unknown }).number === "number"
    ) {
      const candidate = entry as { number: number; title: string };
      if (normalizeTitle(candidate.title) === normalized) return candidate;
    }
  }
  return undefined;
}

/** Create one GitHub issue via `gh issue create`; returns the created issue's URL. */
export async function createGithubIssue(opts: {
  title: string;
  body: string;
  labels?: string[];
  repo?: string;
  cwd: string;
  signal?: AbortSignal;
}): Promise<string> {
  const args = ["issue", "create", "--title", opts.title, "--body", opts.body];
  for (const label of opts.labels ?? []) args.push("--label", label);
  if (opts.repo) args.push("-R", opts.repo);
  const output = await runCommand("gh", args, opts.cwd, opts.signal);
  const url = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//.test(line))
    .pop();
  return url ?? output.trim();
}
