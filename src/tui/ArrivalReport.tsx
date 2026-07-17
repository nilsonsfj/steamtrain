import { Box, Text } from "ink";
import { type ArrivalReport, formatArrivalReceipt } from "../workflow";
import { wrapOutputLines } from "./output-window";

interface ArrivalReportViewProps {
  report: ArrivalReport;
  width: number;
  height: number;
  /** When true, show destination key hints (TUI interactive). */
  showKeys?: boolean;
}

/**
 * The Arrival Report: consolidator output as the hero, a monospace receipt
 * strip, and at most three next-destination actions. Replaces the live tree
 * when a run completes — the tree remains reachable via Esc / inspect.
 */
export function ArrivalReportView({
  report,
  width,
  height,
  showKeys = true,
}: ArrivalReportViewProps) {
  const inner = Math.max(20, width - 4);
  const receipt = formatArrivalReceipt(report.receipt);
  const title = report.receipt.ok ? "Arrival" : "Stopped short";
  const titleColor = report.receipt.ok ? "green" : "red";

  // Fixed chrome: border(2) + title(1) + receipt(1) + destinations(1).
  const chrome = 5;
  const bodyBudget = Math.max(1, height - chrome);
  const heroLines = wrapOutputLines(report.hero, inner).slice(0, bodyBudget);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={titleColor}
      paddingX={1}
      width={width}
      height={height}
    >
      <Box justifyContent="space-between">
        <Text color={titleColor} bold>
          🚂 {title}
          {report.heroStepId ? ` · ${report.heroStepId}` : ""}
        </Text>
        <Text color="gray">i inspect cars · Esc back</Text>
      </Box>
      <Text color="gray">{receipt}</Text>
      <Box flexDirection="column" flexGrow={1}>
        {heroLines.map((line, lineNo) => (
          // Lines are a stable top-to-bottom slice of wrapped output; index is the identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: wrap order is the identity
          <Text key={lineNo} wrap="truncate-end">
            {line || " "}
          </Text>
        ))}
      </Box>
      <Box>
        {report.destinations.map((d, i) => (
          <Text key={d.id} color={i === 0 ? "cyan" : "gray"}>
            {i > 0 ? "  ·  " : ""}
            {showKeys && d.key ? (
              <>
                <Text color="cyan" bold>
                  {d.key}
                </Text>{" "}
              </>
            ) : null}
            {d.label}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
