import { Box, Text } from "ink";
import { useEffect, useMemo } from "react";
import type { DiffStyledLine } from "./diff-lines";
import type { HistoryDiffStep } from "./history-diff";

interface HistoryDiffPanelProps {
  workflow: string;
  recordId: string;
  loading: boolean;
  steps: HistoryDiffStep[];
  /** First visible composed line. */
  scroll: number;
  height: number;
  /**
   * Reports the composed-line total and visible budget after each render, so
   * the keyboard handler can clamp scroll motions.
   */
  onMetrics?: (metrics: { totalLines: number; viewport: number }) => void;
}

/**
 * Full-screen, scrollable code-review view of a recorded run: one section per
 * step worktree (header + styled diff lines), windowed by `scroll`. Opened
 * from the history detail view with `v`; the keyboard layer owns all keys
 * while it is on screen.
 */
export function HistoryDiffPanel({
  workflow,
  recordId,
  loading,
  steps,
  scroll,
  height,
  onMetrics,
}: HistoryDiffPanelProps) {
  // Chrome around the body: borders (2), title (1), key-hint row (1).
  const budget = Math.max(3, height - 4);

  const allLines = useMemo(() => {
    const lines: DiffStyledLine[] = [];
    steps.forEach((step, index) => {
      if (index > 0) lines.push({ text: "" });
      lines.push({
        text: `⎇ ${step.stepId} · ${step.branch} · ${step.files} file${step.files === 1 ? "" : "s"} +${step.additions} −${step.deletions}`,
        color: "yellow",
        bold: true,
      });
      if (step.error) {
        lines.push({ text: `  ${step.error}`, color: "red" });
        return;
      }
      if (step.truncated) {
        lines.push({
          text: `  diff truncated at 200 KB — full diff: steamtrain workflow history show ${recordId} --diff`,
          color: "yellow",
        });
      }
      lines.push(...step.lines);
    });
    return lines;
  }, [steps, recordId]);

  const total = allLines.length;
  const start = Math.min(Math.max(0, scroll), Math.max(0, total - budget));
  const visible = allLines.slice(start, start + budget);

  useEffect(() => {
    onMetrics?.({ totalLines: total, viewport: budget });
  }, [onMetrics, total, budget]);

  const totals = steps.reduce(
    (acc, step) => ({
      files: acc.files + step.files,
      additions: acc.additions + step.additions,
      deletions: acc.deletions + step.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 },
  );
  const position =
    total > budget ? `lines ${start + 1}-${Math.min(total, start + budget)} of ${total}` : "";

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} height={height}>
      <Box justifyContent="space-between">
        <Text color="cyan" bold wrap="truncate-end">
          Run diff — {workflow} · {recordId.slice(0, 8)}
        </Text>
        <Text color="gray">
          {totals.files} file{totals.files === 1 ? "" : "s"}{" "}
          <Text color="green">+{totals.additions}</Text>{" "}
          <Text color="red">−{totals.deletions}</Text>
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {loading ? (
          <Text color="gray" dimColor>
            Computing worktree diffs…
          </Text>
        ) : steps.length === 0 ? (
          <Text color="gray" dimColor>
            No worktree changes recorded for this run
          </Text>
        ) : (
          <>
            {visible.map((line, index) => (
              <Text
                key={`${start + index}-${line.text.slice(0, 16)}`}
                color={line.color}
                bold={line.bold}
                dimColor={line.dimColor}
                wrap="truncate-end"
              >
                {line.text.length > 0 ? line.text : " "}
              </Text>
            ))}
            {Array.from({ length: Math.max(0, budget - visible.length) }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: blank padding rows never reorder
              <Text key={`pad-${i}`}> </Text>
            ))}
          </>
        )}
      </Box>
      <Box justifyContent="space-between">
        <Text color="gray" wrap="truncate-end">
          ↑/↓ scroll · PgUp/PgDn page · g/G top/bottom · v/Esc close
        </Text>
        {position ? <Text color="gray">{position}</Text> : null}
      </Box>
    </Box>
  );
}
