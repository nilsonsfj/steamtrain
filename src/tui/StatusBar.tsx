import { Box, Text } from "ink";
import type { DoctorResult } from "../doctor";
import { STATUS_STYLE } from "./theme";
import { SPINNER_FRAMES, useWorkIndicator } from "./useWorkIndicator";

interface StatusBarProps {
  doctor: DoctorResult[] | null;
  configSource: string;
  workspaceLabel: string;
  running: boolean;
}

export function StatusBar({ doctor, configSource, workspaceLabel, running }: StatusBarProps) {
  const { spinnerFrame, elapsedSeconds } = useWorkIndicator(running);

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
      </Box>
      <Box>
        {running ? (
          <Text color="yellow">
            {SPINNER_FRAMES[spinnerFrame]} working ({elapsedSeconds}s)
          </Text>
        ) : (
          <Text color="gray">idle</Text>
        )}
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

function shorten(source: string): string {
  if (source.length <= 28) return source;
  return `…${source.slice(-27)}`;
}
