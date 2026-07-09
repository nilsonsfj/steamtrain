import { Box, Text } from "ink";
import type { ApiDoctorResult, DoctorResult } from "../doctor";
import { formatTokens, formatUsd } from "../workflow";
import { API_STATUS_STYLE, STATUS_STYLE } from "./theme";
import { useTerminalSize } from "./useTerminalSize";
import { SPINNER_FRAMES, useWorkIndicator } from "./useWorkIndicator";

interface StatusBarProps {
  doctor: DoctorResult[] | null;
  /** Direct-inference API readiness, shown after the agents (null while probing). */
  apiDoctor: ApiDoctorResult[] | null;
  configSource: string;
  workspaceLabel: string;
  running: boolean;
  /** Live spend for the active run, shown as a cost ticker while running. */
  runCostUsd?: number;
  /** Live total tokens for the active run. */
  runTokens?: number;
}

/** One status entry (an agent, an API, or the group divider) with its render width. */
type Chip =
  | { kind: "agent"; result: DoctorResult; width: number }
  | { kind: "api"; result: ApiDoctorResult; width: number }
  | { kind: "divider"; width: number };

/** Cells between adjacent chips on a line. */
const SEP = "   ";
const SEP_WIDTH = SEP.length;
const PREFIX = "steamtrain ";

/** A chip reads `symbol name label`; symbol is 1 cell, plus two joining spaces. */
function chipWidth(name: string, label: string): number {
  return name.length + label.length + 3;
}

/**
 * Pack chips onto up to two lines, each bounded by its own width budget, in
 * order. Chips that don't fit are dropped (reported as `hidden`) rather than
 * wrapped — mid-word wrapping is what breaks the layout and flickers. An
 * overflow "+N" marker is reserved room on the last line when anything is cut.
 */
function packChips(
  chips: Chip[],
  line1Budget: number,
  line2Budget: number,
): { line1: Chip[]; line2: Chip[]; hidden: number } {
  const budgets = [Math.max(0, line1Budget), Math.max(0, line2Budget)];
  const rows: Chip[][] = [[], []];
  const used = [0, 0];
  const line = (i: number): Chip[] => rows[i] ?? [];
  let cur = 0;
  let placed = 0;

  for (const chip of chips) {
    let fit = false;
    while (cur < rows.length) {
      const sep = line(cur).length > 0 ? SEP_WIDTH : 0;
      if (used[cur]! + sep + chip.width <= budgets[cur]!) {
        line(cur).push(chip);
        used[cur] = used[cur]! + sep + chip.width;
        placed += 1;
        fit = true;
        break;
      }
      cur += 1;
    }
    if (!fit) break;
  }

  let hidden = chips.length - placed;
  if (hidden > 0) {
    // Reserve room for a "+N" marker on the last non-empty line, evicting
    // trailing chips until it fits (a wider N stays within the eviction loop).
    const i = line(1).length > 0 ? 1 : 0;
    while (line(i).length > 0 && used[i]! + SEP_WIDTH + 2 + String(hidden).length > budgets[i]!) {
      const evicted = line(i).pop();
      if (!evicted) break;
      used[i] = used[i]! - evicted.width - (line(i).length > 0 ? SEP_WIDTH : 0);
      hidden += 1;
    }
  }

  return { line1: line(0), line2: line(1), hidden };
}

function renderChip(chip: Chip, key: string, leading: boolean) {
  return (
    <Box key={key}>
      {leading ? <Text color="gray">{SEP}</Text> : null}
      {chip.kind === "divider" ? (
        <Text color="gray">│</Text>
      ) : chip.kind === "agent" ? (
        <AgentStatus result={chip.result} />
      ) : (
        <ApiStatus result={chip.result} />
      )}
    </Box>
  );
}

export function StatusBar({
  doctor,
  apiDoctor,
  configSource,
  workspaceLabel,
  running,
  runCostUsd,
  runTokens,
}: StatusBarProps) {
  const { spinnerFrame, elapsedSeconds } = useWorkIndicator(running);
  const { columns } = useTerminalSize();
  const showTicker = running && ((runCostUsd ?? 0) > 0 || (runTokens ?? 0) > 0);

  const rightGroup = (
    <Box>
      {running ? (
        <Text color="yellow">
          {SPINNER_FRAMES[spinnerFrame]} working ({elapsedSeconds}s)
        </Text>
      ) : (
        <Text color="gray">idle</Text>
      )}
      {showTicker ? (
        <Text color="green">
          {"  "}
          {formatUsd(runCostUsd ?? 0)}
          {(runTokens ?? 0) > 0 ? ` · ${formatTokens(runTokens ?? 0)} tok` : ""}
        </Text>
      ) : null}
      <Text color="gray">
        {"  "}cfg: {shorten(configSource)}
        {"  "}ws: {shorten(workspaceLabel)}
      </Text>
    </Box>
  );

  if (doctor === null) {
    return (
      <Box borderStyle="round" borderColor="gray" paddingX={1} justifyContent="space-between">
        <Box>
          <Text bold color="cyan">
            {PREFIX}
          </Text>
          <Text color="gray">running preflight…</Text>
        </Box>
        {rightGroup}
      </Box>
    );
  }

  const chips: Chip[] = doctor.map((d) => ({
    kind: "agent",
    result: d,
    width: chipWidth(d.agent, STATUS_STYLE[d.status].label),
  }));
  if (apiDoctor && apiDoctor.length > 0) {
    chips.push({ kind: "divider", width: 1 });
    for (const d of apiDoctor) {
      chips.push({
        kind: "api",
        result: d,
        width: chipWidth(d.api, API_STATUS_STYLE[d.status].label),
      });
    }
  }

  // Inner content width = terminal minus the round border (1 each side) and
  // paddingX (1 each side). Line 1 shares its row with the prefix and the
  // right-hand group; line 2 is the full inner width. The right-group reserve
  // is a stable upper bound per running-state so packing doesn't reflow with
  // the per-second ticker.
  const inner = Math.max(0, columns - 4);
  const rightStable = `  cfg: ${shorten(configSource)}  ws: ${shorten(workspaceLabel)}`;
  const statusReserve = running ? 34 : 6;
  const line1Budget = inner - PREFIX.length - rightStable.length - statusReserve - 1;
  // Line 2 is indented under the prefix (paddingLeft below), so it loses the
  // same width the prefix occupies on line 1.
  const line2Budget = inner - PREFIX.length;
  const { line1, line2, hidden } = packChips(chips, line1Budget, line2Budget);

  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
      <Box justifyContent="space-between">
        <Box>
          <Text bold color="cyan">
            {PREFIX}
          </Text>
          {line1.map((chip, i) => renderChip(chip, `l0-${i}`, i > 0))}
          {line2.length === 0 && hidden > 0 ? (
            <Box>
              <Text color="gray">
                {line1.length > 0 ? SEP : ""}+{hidden}
              </Text>
            </Box>
          ) : null}
        </Box>
        {rightGroup}
      </Box>
      {line2.length > 0 ? (
        <Box paddingLeft={PREFIX.length}>
          {line2.map((chip, i) => renderChip(chip, `l1-${i}`, i > 0))}
          {hidden > 0 ? (
            <Box>
              <Text color="gray">
                {SEP}+{hidden}
              </Text>
            </Box>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}

function AgentStatus({ result }: { result: DoctorResult }) {
  const style = STATUS_STYLE[result.status];
  return (
    <Text>
      <Text color={style.color}>{style.symbol}</Text>
      <Text bold> {result.agent}</Text>
      <Text color="gray"> {style.label}</Text>
    </Text>
  );
}

function ApiStatus({ result }: { result: ApiDoctorResult }) {
  const style = API_STATUS_STYLE[result.status];
  return (
    <Text>
      <Text color={style.color}>{style.symbol}</Text>
      <Text bold> {result.api}</Text>
      <Text color="gray"> {style.label}</Text>
    </Text>
  );
}

function shorten(source: string): string {
  if (source.length <= 28) return source;
  return `…${source.slice(-27)}`;
}
