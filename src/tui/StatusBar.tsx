import { Box, Text } from "ink";
import type { ApiDoctorResult, DoctorResult } from "../doctor";
import { formatTokens, formatUsd } from "../workflow";
import { API_STATUS_STYLE, STATUS_STYLE } from "./theme";
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
  const showTicker = running && ((runCostUsd ?? 0) > 0 || (runTokens ?? 0) > 0);

  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Box>
        <Text bold color="cyan">
          steamtrain{" "}
        </Text>
        {doctor === null ? (
          <Text color="gray">running preflight…</Text>
        ) : (
          doctor.map((d, i) => (
            <Box key={d.agent}>
              {i > 0 ? <Text color="gray">{"   "}</Text> : null}
              <AgentStatus result={d} />
            </Box>
          ))
        )}
        {doctor !== null && apiDoctor && apiDoctor.length > 0 ? (
          <>
            <Text color="gray">{"  │  "}</Text>
            {apiDoctor.map((d, i) => (
              <Box key={d.api}>
                {i > 0 ? <Text color="gray">{"   "}</Text> : null}
                <ApiStatus result={d} />
              </Box>
            ))}
          </>
        ) : null}
      </Box>
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
