import {
  type ParsedDiffFile,
  diffFileDisplayPath,
  diffFileLineCounts,
} from "../workflow/unified-diff";

/** One styled terminal row of a rendered diff (always single-height). */
export interface DiffStyledLine {
  text: string;
  color?: string;
  bold?: boolean;
  dimColor?: boolean;
}

const STATUS_BADGE: Record<ParsedDiffFile["status"], { letter: string; color: string }> = {
  added: { letter: "A", color: "green" },
  modified: { letter: "M", color: "yellow" },
  deleted: { letter: "D", color: "red" },
  renamed: { letter: "R", color: "cyan" },
};

/** Right-align a line number in a 4-wide gutter column; blank when absent. */
function gutter(num: number | null): string {
  return num === null ? "    " : String(num).padStart(4);
}

/**
 * Render parsed files as GitHub-review-style terminal lines: a bold status
 * header per file, cyan hunk headers, and diff lines with dual old/new
 * line-number gutters. One styled segment per line — the gutter shares the
 * line kind's color (context lines carry none, keeping gutters readable).
 */
export function buildDiffLines(files: ParsedDiffFile[]): DiffStyledLine[] {
  const lines: DiffStyledLine[] = [];
  files.forEach((file, fileIndex) => {
    if (fileIndex > 0) lines.push({ text: "" });
    const badge = STATUS_BADGE[file.status];
    const path =
      file.status === "renamed"
        ? `${file.oldPath ?? "(unknown)"} → ${file.newPath ?? "(unknown)"}`
        : diffFileDisplayPath(file);
    const { additions, deletions } = diffFileLineCounts(file);
    lines.push({
      text: `${badge.letter} ${path}  +${additions} −${deletions}`,
      color: badge.color,
      bold: true,
    });

    if (file.isBinary) {
      lines.push({ text: "  Binary file not shown", dimColor: true });
      return;
    }
    if (file.hunks.length === 0) {
      lines.push({ text: "  No textual changes (metadata only)", dimColor: true });
      return;
    }
    for (const hunk of file.hunks) {
      lines.push({ text: hunk.header, color: "cyan", dimColor: true });
      for (const line of hunk.lines) {
        const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
        lines.push({
          text: `${gutter(line.oldNumber)} ${gutter(line.newNumber)} │ ${marker}${line.text}`,
          color: line.kind === "add" ? "green" : line.kind === "del" ? "red" : undefined,
        });
        if (line.noNewline) {
          lines.push({
            text: `${gutter(null)} ${gutter(null)} │ \\ No newline at end of file`,
            dimColor: true,
          });
        }
      }
    }
  });
  return lines;
}

/**
 * Cap a raw patch before parsing/rendering — a runaway diff would otherwise
 * produce tens of thousands of terminal rows and hitch the TUI.
 */
export function truncatePatch(patch: string, cap = 200_000): { patch: string; truncated: boolean } {
  if (patch.length <= cap) return { patch, truncated: false };
  return { patch: patch.slice(0, cap), truncated: true };
}
