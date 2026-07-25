import { type RunRecord, finalRunWorktrees, worktreeDiff } from "../workflow";
import { parseUnifiedDiff } from "../workflow/unified-diff";
import { type DiffStyledLine, buildDiffLines, truncatePatch } from "./diff-lines";
import { message } from "./util";

/** One step's rendered diff (or the error that kept it from rendering). */
export interface HistoryDiffStep {
  stepId: string;
  branch: string;
  exists: boolean;
  files: number;
  additions: number;
  deletions: number;
  /** Styled content lines; empty when the worktree is gone or errored. */
  lines: DiffStyledLine[];
  /** Set when the diff could not be computed (e.g. worktree pruned). */
  error?: string;
  /** True when the raw patch hit the truncation cap before parsing. */
  truncated?: boolean;
}

/**
 * Compute every recorded step worktree's diff against its base commit and
 * render it to styled lines. Framework-free (no React) so it is unit-testable;
 * per-source failures degrade to an error entry instead of failing the run.
 */
export async function loadRunDiff(record: RunRecord): Promise<HistoryDiffStep[]> {
  const steps: HistoryDiffStep[] = [];
  for (const source of finalRunWorktrees(record)) {
    try {
      const diff = await worktreeDiff(source, { patch: true });
      const { patch, truncated } = truncatePatch(diff.patch ?? "");
      const files = parseUnifiedDiff(patch);
      steps.push({
        stepId: source.stepId,
        branch: source.branch,
        exists: true,
        files: diff.files.length,
        additions: diff.additions,
        deletions: diff.deletions,
        lines: buildDiffLines(files),
        truncated,
      });
    } catch (err) {
      steps.push({
        stepId: source.stepId,
        branch: source.branch,
        exists: false,
        files: 0,
        additions: 0,
        deletions: 0,
        lines: [],
        error: message(err),
      });
    }
  }
  return steps;
}
