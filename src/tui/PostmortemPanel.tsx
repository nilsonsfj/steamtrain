import { Box, Text } from "ink";
import { useEffect, useMemo } from "react";
import type { PostmortemResult } from "../workflow";
import type { DiffStyledLine } from "./diff-lines";

interface PostmortemPanelProps {
  workflow: string;
  recordId: string;
  loading: boolean;
  error?: string;
  result?: PostmortemResult & { ok: true };
  /** First visible composed line. */
  scroll: number;
  width: number;
  height: number;
  /**
   * Reports the composed-line total and visible budget after each render, so
   * the keyboard handler can clamp scroll motions.
   */
  onMetrics?: (metrics: { totalLines: number; viewport: number }) => void;
}

/**
 * Full-screen, scrollable failure postmortem of a recorded run: the root
 * cause, category, evidence, and the proposed spec edit. Opened from the
 * history detail view with `w`; the keyboard layer owns all keys while it is
 * on screen.
 */
export function PostmortemPanel({
  workflow,
  recordId,
  loading,
  error,
  result,
  scroll,
  width,
  height,
  onMetrics,
}: PostmortemPanelProps) {
  // Chrome around the body: borders (2), title (1), key-hint row (1).
  const budget = Math.max(3, height - 4);
  // Body text wraps inside the borders and the paddingX.
  const wrapWidth = Math.max(20, width - 6);

  const allLines = useMemo(
    () => (result ? buildPostmortemLines(result, wrapWidth) : []),
    [result, wrapWidth],
  );

  const total = allLines.length;
  const start = Math.min(Math.max(0, scroll), Math.max(0, total - budget));
  const visible = allLines.slice(start, start + budget);

  useEffect(() => {
    onMetrics?.({ totalLines: total, viewport: budget });
  }, [onMetrics, total, budget]);

  const position =
    total > budget ? `lines ${start + 1}-${Math.min(total, start + budget)} of ${total}` : "";

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} height={height}>
      <Box justifyContent="space-between">
        <Text color="cyan" bold wrap="truncate-end">
          Postmortem — {workflow} · {recordId.slice(0, 8)}
        </Text>
        {result ? (
          <Text color="gray" wrap="truncate-end">
            {result.api}/{result.model}
          </Text>
        ) : null}
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {loading ? (
          <Text color="gray" dimColor>
            Diagnosing the failure with a direct LLM call…
          </Text>
        ) : error ? (
          <>
            <Text color="red">{error}</Text>
            <Text color="gray" dimColor>
              A postmortem needs an LLM API: set ANTHROPIC_API_KEY or OPENAI_API_KEY, or configure
              one under apis.
            </Text>
          </>
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
          ↑/↓ scroll · PgUp/PgDn page · g/G top/bottom · w/Esc close
        </Text>
        {position ? <Text color="gray">{position}</Text> : null}
      </Box>
    </Box>
  );
}

/** Compose the diagnosis into styled single-height terminal lines. */
export function buildPostmortemLines(
  result: PostmortemResult & { ok: true },
  width: number,
): DiffStyledLine[] {
  const d = result.diagnosis;
  const lines: DiffStyledLine[] = [];
  const wrap = (text: string): string[] => wrapWords(text, width);

  const categoryColor =
    d.category === "spec-bug" || d.category === "prompt-bug"
      ? "yellow"
      : d.category === "unknown" || d.category === "flaky-agent"
        ? "gray"
        : "red";
  lines.push({
    text: `${d.category}  (confidence: ${d.confidence}${d.rootStepId ? ` · root step: ${d.rootStepId}` : ""})`,
    color: categoryColor,
    bold: true,
  });
  if (result.specDrift) {
    lines.push({
      text: "the workflow spec changed since this run — field values below may have drifted",
      color: "yellow",
    });
  }
  lines.push({ text: "" });

  lines.push({ text: "root cause", color: "cyan", bold: true });
  for (const line of wrap(d.summary)) lines.push({ text: line });

  if (d.evidence) {
    lines.push({ text: "" });
    lines.push({ text: "evidence", color: "cyan", bold: true });
    for (const line of wrap(d.evidence)) lines.push({ text: line, color: "gray" });
  }
  if (d.suggestion) {
    lines.push({ text: "" });
    lines.push({ text: "suggested fix", color: "cyan", bold: true });
    for (const line of wrap(d.suggestion)) lines.push({ text: line });
  }

  if (d.specFix) {
    const fix = d.specFix;
    lines.push({ text: "" });
    if (fix.validation?.ok) {
      lines.push({ text: "proposed spec edit (validated ✓)", color: "green", bold: true });
    } else {
      lines.push({ text: "proposed spec edit (not applied)", color: "yellow", bold: true });
    }
    lines.push({ text: `  step '${fix.stepId}' · field '${fix.field}'` });
    if (fix.validation && !fix.validation.ok && fix.validation.error) {
      for (const line of wrap(fix.validation.error))
        lines.push({ text: `  ${line}`, color: "red" });
    }
    if (fix.rationale) {
      for (const line of wrap(fix.rationale)) lines.push({ text: `  ${line}`, color: "gray" });
    }
    if (fix.current) lines.push({ text: `  now:      ${truncateLine(fix.current, width - 12)}` });
    lines.push({ text: `  proposed: ${truncateLine(fix.proposed, width - 12)}` });
    if (fix.validation?.ok) {
      lines.push({
        text: "  apply it by editing that step (Ctrl+E in the workflow preview)",
        color: "gray",
        dimColor: true,
      });
    }
  }
  return lines;
}

function wrapWords(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let current = "";
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue;
      if (current && current.length + word.length + 1 > width) {
        lines.push(current);
        current = word;
      } else {
        current = current ? `${current} ${word}` : word;
      }
    }
    lines.push(current);
  }
  return lines;
}

function truncateLine(text: string, width: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > width ? `${oneLine.slice(0, Math.max(0, width - 1))}…` : oneLine;
}
