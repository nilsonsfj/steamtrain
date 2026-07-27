import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import {
  defaultModelForAgent,
  modelIdsForAgent,
  modelNameForAgent,
  resolveAgentInstances,
} from "../agents";
import type { SteamtrainConfig } from "../config";
import type { DoctorResult } from "../doctor";
import type { RunRecord } from "../workflow";
import { listRetryCandidateSteps } from "../workflow";
import type { RetryRetargetLaunch } from "./useHistory";

type Stage = "agent" | "model" | "steps" | "confirm";

export interface RetryRetargetOverlayProps {
  record: RunRecord;
  config: SteamtrainConfig;
  doctor: DoctorResult[] | null;
  onConfirm: (launch: RetryRetargetLaunch) => void;
  onCancel: () => void;
}

/**
 * Compact history overlay: pick agent → model → optional steps → confirm.
 * Space toggles steps; Enter advances / confirms; Esc cancels.
 */
export function RetryRetargetOverlay({
  record,
  config,
  doctor,
  onConfirm,
  onCancel,
}: RetryRetargetOverlayProps) {
  const readyAgents = useMemo(() => {
    const instances = resolveAgentInstances(config);
    // Ready when doctor has no row yet (unknown) or status is ok — same rule as
    // the web history retarget modal (app.js openRetryRetargetModal).
    return instances.filter((agent) => {
      const health = doctor?.find((d) => d.agent === agent.id);
      return !health || health.status === "ok";
    });
  }, [config, doctor]);

  const candidates = useMemo(() => listRetryCandidateSteps(record), [record]);

  const [stage, setStage] = useState<Stage>("agent");
  const [agentIndex, setAgentIndex] = useState(0);
  const [modelIndex, setModelIndex] = useState(0);
  const [stepCursor, setStepCursor] = useState(0);
  const [selectedSteps, setSelectedSteps] = useState<Set<string>>(() => new Set());

  const agent = readyAgents[agentIndex];
  const models = useMemo(() => {
    if (!agent) return [] as { id: string; label: string }[];
    const ids = modelIdsForAgent(agent.id, config);
    return [
      { id: "", label: `(default · ${defaultModelForAgent(agent.id, config)})` },
      ...ids.map((id) => ({ id, label: modelNameForAgent(agent.id, id, config) || id })),
    ];
  }, [agent, config]);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (stage === "agent") {
      if (key.upArrow) setAgentIndex((i) => Math.max(0, i - 1));
      else if (key.downArrow) setAgentIndex((i) => Math.min(readyAgents.length - 1, i + 1));
      else if (key.return && agent) {
        setModelIndex(0);
        setStage("model");
      }
      return;
    }
    if (stage === "model") {
      if (key.upArrow) setModelIndex((i) => Math.max(0, i - 1));
      else if (key.downArrow) setModelIndex((i) => Math.min(models.length - 1, i + 1));
      else if (key.return) setStage(candidates.length > 0 ? "steps" : "confirm");
      return;
    }
    if (stage === "steps") {
      if (key.upArrow) setStepCursor((i) => Math.max(0, i - 1));
      else if (key.downArrow) setStepCursor((i) => Math.min(candidates.length - 1, i + 1));
      else if (input === " ") {
        const id = candidates[stepCursor]?.stepId;
        if (!id) return;
        setSelectedSteps((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      } else if (key.return) setStage("confirm");
      return;
    }
    if (stage === "confirm" && key.return && agent) {
      const model = models[modelIndex]?.id;
      onConfirm({
        agent: agent.id,
        model: model || undefined,
        stepIds: selectedSteps.size > 0 ? [...selectedSteps] : undefined,
      });
    }
  });

  if (readyAgents.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
        <Text bold>Retry with agent</Text>
        <Text dimColor>No ready agents available. Esc to cancel.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>
        Retry with agent · {record.workflow} · {candidates.length} failed/not-run
      </Text>
      {stage === "agent" ? (
        <Box flexDirection="column">
          <Text dimColor>↑/↓ pick agent · Enter · Esc cancel</Text>
          {readyAgents.map((a, i) => (
            <Text key={a.id} color={i === agentIndex ? "cyan" : undefined}>
              {i === agentIndex ? "› " : "  "}
              {a.id}
            </Text>
          ))}
        </Box>
      ) : null}
      {stage === "model" && agent ? (
        <Box flexDirection="column">
          <Text dimColor>agent {agent.id} · ↑/↓ model · Enter · Esc cancel</Text>
          {models.map((m, i) => (
            <Text key={m.id || "default"} color={i === modelIndex ? "cyan" : undefined}>
              {i === modelIndex ? "› " : "  "}
              {m.label}
            </Text>
          ))}
        </Box>
      ) : null}
      {stage === "steps" ? (
        <Box flexDirection="column">
          <Text dimColor>Space toggle · empty = all failed · Enter · Esc cancel</Text>
          {candidates.map((s, i) => {
            const on = selectedSteps.has(s.stepId);
            return (
              <Text key={s.stepId} color={i === stepCursor ? "cyan" : undefined}>
                {i === stepCursor ? "› " : "  "}
                {on ? "[x] " : "[ ] "}
                {s.stepId}
                {s.agent ? ` · ${s.agent}` : ""}
              </Text>
            );
          })}
        </Box>
      ) : null}
      {stage === "confirm" && agent ? (
        <Box flexDirection="column">
          <Text>
            Retarget → {agent.id}
            {models[modelIndex]?.id ? `/${models[modelIndex]!.id}` : " (default)"}
            {selectedSteps.size > 0
              ? ` · ${selectedSteps.size} step(s)`
              : " · all failed/not-run agent steps"}
          </Text>
          <Text dimColor>Enter to launch · Esc cancel</Text>
        </Box>
      ) : null}
    </Box>
  );
}
