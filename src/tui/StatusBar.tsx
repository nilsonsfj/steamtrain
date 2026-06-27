import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import type { DoctorResult } from "../doctor";
import { SPINNER_FRAMES, STATUS_STYLE } from "./theme";

interface StatusBarProps {
  doctor: DoctorResult[] | null;
  configSource: string;
  workspaceLabel: string;
  running: boolean;
}

export function StatusBar({ doctor, configSource, workspaceLabel, running }: StatusBarProps) {
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!running) {
      setElapsedSeconds(0);
      setSpinnerFrame(0);
      return;
    }

    const spinnerInterval = setInterval(() => {
      setSpinnerFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, 80);

    const startTime = Date.now();
    const timerInterval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startTime) / 1000));
    }, 200);

    return () => {
      clearInterval(spinnerInterval);
      clearInterval(timerInterval);
    };
  }, [running]);

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
