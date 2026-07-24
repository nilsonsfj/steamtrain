import { Box, Text } from "ink";
import type { ApiDoctorResult, DoctorResult } from "../doctor";
import type { ProjectIdentity } from "../project";
import { formatProjectLabel } from "../project";
import { formatTokens, formatUsd } from "../workflow";
import { API_STATUS_STYLE, STATUS_STYLE } from "./theme";
import { useTerminalSize } from "./useTerminalSize";
import { SPINNER_FRAMES, useWorkIndicator } from "./useWorkIndicator";

interface StatusBarProps {
  doctor: DoctorResult[] | null;
  /** Direct-inference API readiness, shown on its own line below the agents (null while probing). */
  apiDoctor: ApiDoctorResult[] | null;
  /** Current project identity — name + directory, always visible. */
  project: ProjectIdentity;
  configSource: string;
  /**
   * Agent-preset workspace scope label (`user` / `project` / custom path).
   * Renamed in chrome to `presets:` so it is not mistaken for the project dir.
   */
  workspaceLabel: string;
  running: boolean;
  /** Live spend for the active run, shown as a cost ticker while running. */
  runCostUsd?: number;
  /** Live total tokens for the active run. */
  runTokens?: number;
  /**
   * Soft health mode for credential-free workflows (e.g. tour): hide the red
   * agent/API chip wall and show a calm "ready to ride" pill instead.
   */
  softHealth?: boolean;
}

/** Cells between adjacent chips on a line. */
const SEP = "   ";
const SEP_WIDTH = SEP.length;
const PREFIX = "steamtrain ";

/** A chip reads `symbol name label`; symbol is 1 cell, plus two joining spaces. */
function chipWidth(name: string, label: string): number {
  return name.length + label.length + 3;
}

/**
 * Fit as many chips as possible onto a single line of the given width, in
 * order. Overflow is dropped (reported as `hidden`) rather than wrapped —
 * mid-word wrapping is what breaks the layout and flickers. When anything is
 * cut, a trailing "+N" marker is guaranteed room by evicting more chips.
 */
function packLine<T extends { width: number }>(
  chips: T[],
  budget: number,
): { shown: T[]; hidden: number } {
  const shown: T[] = [];
  let used = 0;
  for (const chip of chips) {
    const sep = shown.length > 0 ? SEP_WIDTH : 0;
    if (used + sep + chip.width > budget) break;
    shown.push(chip);
    used += sep + chip.width;
  }
  let hidden = chips.length - shown.length;
  while (hidden > 0 && shown.length > 0 && used + SEP_WIDTH + 2 + String(hidden).length > budget) {
    const evicted = shown.pop();
    if (!evicted) break;
    used -= evicted.width + (shown.length > 0 ? SEP_WIDTH : 0);
    hidden += 1;
  }
  return { shown, hidden };
}

function OverflowMarker({ hidden, leading }: { hidden: number; leading: boolean }) {
  return (
    <Text color="gray">
      {leading ? SEP : ""}+{hidden}
    </Text>
  );
}

export function StatusBar({
  doctor,
  apiDoctor,
  project,
  configSource,
  workspaceLabel,
  running,
  runCostUsd,
  runTokens,
  softHealth = false,
}: StatusBarProps) {
  const { spinnerFrame, elapsedSeconds } = useWorkIndicator(running);
  const { columns } = useTerminalSize();
  const showTicker = running && ((runCostUsd ?? 0) > 0 || (runTokens ?? 0) > 0);
  const projectBits = formatProjectLabel(project, Math.max(24, Math.min(48, columns - 36)));

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

  const projectStrip = (
    <Box>
      <Text color="cyan">◈ </Text>
      <Text bold color="white">
        {projectBits.primary}
      </Text>
      {projectBits.secondary ? (
        <Text color="gray">
          {"  "}
          {projectBits.secondary}
        </Text>
      ) : null}
    </Box>
  );

  if (doctor === null) {
    return (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor="gray" paddingX={1} justifyContent="space-between">
          <Box>
            <Text bold color="cyan">
              {PREFIX}
            </Text>
            <Text color="gray">running preflight…</Text>
          </Box>
          {rightGroup}
        </Box>
        <Box paddingX={1} marginTop={0}>
          {projectStrip}
        </Box>
      </Box>
    );
  }

  if (softHealth) {
    return (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor="gray" paddingX={1} justifyContent="space-between">
          <Box>
            <Text bold color="cyan">
              {PREFIX}
            </Text>
            <Text color="green">● ready to ride</Text>
            <Text color="gray"> · no agents required</Text>
          </Box>
          {rightGroup}
        </Box>
        <Box paddingX={1}>{projectStrip}</Box>
      </Box>
    );
  }

  // Signal-first: lead with what works. Agents that are simply not installed
  // (binary_missing) are omitted entirely - "missing" is the normal state for
  // CLIs the user doesn't use, and a "N not installed" tally just burns space
  // that could show another found agent. Auth/error states on installed agents
  // stay loud because they're actionable. When nothing is installed at all,
  // surface a setup nudge instead of an empty bar.
  // Same rule for APIs: an unset key is normal (their style is already gray),
  // so key_missing collapses; auth/offline/error chips stay.
  const visibleAgents = doctor.filter((d) => d.status !== "binary_missing");
  const missingAgents = doctor.length - visibleAgents.length;
  const agentSummary =
    missingAgents > 0 && visibleAgents.length === 0 ? "no agents installed — Ctrl+A to set up" : "";
  const visibleApis = (apiDoctor ?? []).filter((d) => d.status !== "key_missing");
  const missingApis = (apiDoctor ?? []).length - visibleApis.length;
  const apiSummary =
    missingApis > 0 && visibleApis.length > 0
      ? `${missingApis} without keys`
      : missingApis > 0
        ? "◇ no API keys set"
        : "";

  // Inner content width = terminal minus the round border (1 each side) and
  // paddingX (1 each side). The agent line shares its row with the prefix and
  // the right-hand group; the API line is indented under the prefix. The
  // right-group reserve is a stable upper bound per running-state so the agent
  // line doesn't reflow with the per-second ticker.
  const inner = Math.max(0, columns - 4);
  const rightStable = `  cfg: ${shorten(configSource)}  ws: ${shorten(workspaceLabel)}`;
  const statusReserve = running ? 34 : 6;

  const agents = visibleAgents.map((result) => ({
    result,
    width: chipWidth(result.agent, STATUS_STYLE[result.status].label),
  }));
  const apis = visibleApis.map((result) => ({
    result,
    width: chipWidth(result.api, API_STATUS_STYLE[result.status].label),
  }));

  const agentSummaryReserve = agentSummary ? agentSummary.length + SEP_WIDTH + 2 : 0;
  const apiSummaryReserve = apiSummary ? apiSummary.length + SEP_WIDTH + 2 : 0;
  const agentBudget =
    inner - PREFIX.length - rightStable.length - statusReserve - 1 - agentSummaryReserve;
  const apiBudget = inner - PREFIX.length - apiSummaryReserve;
  const packedAgents = packLine(agents, agentBudget);
  const packedApis = packLine(apis, apiBudget);
  const showApiLine = apis.length > 0 || apiSummary.length > 0;

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
        <Box justifyContent="space-between">
          <Box>
            <Text bold color="cyan">
              {PREFIX}
            </Text>
            {packedAgents.shown.map((chip, i) => (
              <Box key={chip.result.agent}>
                {i > 0 ? <Text color="gray">{SEP}</Text> : null}
                <AgentStatus result={chip.result} />
              </Box>
            ))}
            {packedAgents.hidden > 0 ? (
              <OverflowMarker
                hidden={packedAgents.hidden}
                leading={packedAgents.shown.length > 0}
              />
            ) : null}
            {agentSummary ? (
              <Text color={packedAgents.shown.length > 0 ? "gray" : "yellow"}>
                {packedAgents.shown.length > 0 || packedAgents.hidden > 0 ? `${SEP}· ` : ""}
                {agentSummary}
              </Text>
            ) : null}
          </Box>
          {rightGroup}
        </Box>
        {showApiLine ? (
          <Box paddingLeft={PREFIX.length}>
            {packedApis.shown.map((chip, i) => (
              <Box key={chip.result.api}>
                {i > 0 ? <Text color="gray">{SEP}</Text> : null}
                <ApiStatus result={chip.result} />
              </Box>
            ))}
            {packedApis.hidden > 0 ? (
              <OverflowMarker hidden={packedApis.hidden} leading={packedApis.shown.length > 0} />
            ) : null}
            {apiSummary ? (
              <Text color="gray">
                {packedApis.shown.length > 0 || packedApis.hidden > 0 ? `${SEP}· ` : ""}
                {apiSummary}
              </Text>
            ) : null}
          </Box>
        ) : null}
      </Box>
      <Box paddingX={1} marginBottom={0}>
        {projectStrip}
      </Box>
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
