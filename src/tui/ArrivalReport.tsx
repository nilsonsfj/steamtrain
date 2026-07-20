import { Box, Text } from "ink";
import { type ArrivalReport, arrivalReceiptCards, formatArrivalHeadline } from "../workflow";
import { wrapOutputLines } from "./output-window";

interface ArrivalReportViewProps {
  report: ArrivalReport;
  width: number;
  height: number;
  /** Workflow name for the climax headline. */
  workflowName?: string | null;
  /** When true, show destination key hints (TUI interactive). */
  showKeys?: boolean;
}

/**
 * The Arrival Report: climax headline, three receipt facts, consolidator
 * output as the body, and plain-language next actions. Replaces the live tree
 * when a run completes — the tree remains reachable via Esc / i.
 */
export function ArrivalReportView({
  report,
  width,
  height,
  workflowName,
  showKeys = true,
}: ArrivalReportViewProps) {
  const inner = Math.max(20, width - 4);
  const headline = formatArrivalHeadline(report.receipt, workflowName);
  const cards = arrivalReceiptCards(report.receipt);
  const titleColor = report.receipt.ok ? "green" : "red";

  // Fixed chrome: border(2) + kicker/hint(1) + headline(1) + cards(1) + destinations(1).
  const chrome = 6;
  const bodyBudget = Math.max(1, height - chrome);
  const heroLines = wrapOutputLines(report.hero, inner).slice(0, bodyBudget);
  const kicker = report.receipt.ok ? "End of the line · Arrival" : "Stopped short";

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={titleColor}
      paddingX={1}
      width={width}
      height={height}
    >
      <Box justifyContent="space-between">
        <Text color={titleColor} bold>
          {kicker}
        </Text>
        <Text color="gray">i details · Esc back</Text>
      </Box>
      <Text color={titleColor} bold>
        {headline}
      </Text>
      <Box>
        {cards.map((card, i) => (
          <Text key={card.id} color="gray">
            {i > 0 ? "  ·  " : ""}
            <Text color="white">{card.label}</Text> {card.value}
          </Text>
        ))}
      </Box>
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
