import { Box, Text, useInput } from "ink";
import { useCallback, useMemo, useState } from "react";
import { modelIdsForAgent, modelNameForAgent } from "../agents";
import { truncate } from "../agents/util";
import type { SteamtrainConfig } from "../config";
import { AGENT_COLOR } from "./theme";
import {
  EDITOR_EFFORT_NONE,
  type EditorField,
  type StepEditorPatch,
  type StepEditorTarget,
  agentChangePatch,
  agentOptions,
  cycleOption,
  editorFieldsFor,
  effortChangePatch,
  effortOptions,
  modelChangePatch,
} from "./workflow-step-editor";

interface WorkflowStepEditorProps {
  target: StepEditorTarget;
  config: SteamtrainConfig;
  width: number;
  height: number;
  /** Stage a session override for the step (merged into existing overrides). */
  onApply: (patch: StepEditorPatch) => void;
  onClose: () => void;
}

interface Working {
  agent?: string;
  model?: string;
  effort?: string;
  prompt: string;
}

const FIELD_LABEL: Record<EditorField, string> = {
  agent: "agent",
  model: "model",
  effort: "effort",
  prompt: "prompt",
};

/**
 * In-place editor for a selected workflow step. Reachable with Ctrl+E from the
 * workflow preview. ↑/↓ moves between fields; ←/→ cycles agent/model/effort;
 * Enter edits the prompt. Every change stages a session override immediately
 * (persist with `/save-workflows`).
 */
export function WorkflowStepEditor({
  target,
  config,
  width,
  height,
  onApply,
  onClose,
}: WorkflowStepEditorProps) {
  const [working, setWorking] = useState<Working>(() => ({
    agent: target.agent,
    model: target.model,
    effort: target.effort,
    prompt: target.prompt,
  }));
  const [focusIndex, setFocusIndex] = useState(0);
  const [editingPrompt, setEditingPrompt] = useState(false);

  // Recompute available fields against the *working* copy: switching agents can
  // add or remove the effort row (e.g. haiku has no effort levels).
  const fields = useMemo(
    () => editorFieldsFor({ ...target, ...working }, config),
    [target, working, config],
  );
  const clampedFocus = Math.min(focusIndex, Math.max(0, fields.length - 1));
  const focusedField = fields[clampedFocus];

  const apply = useCallback(
    (patch: StepEditorPatch) => {
      setWorking((prev) => ({ ...prev, ...patch }));
      onApply(patch);
    },
    [onApply],
  );

  const cycleField = useCallback(
    (field: EditorField, dir: 1 | -1) => {
      if (field === "agent") {
        const opts = agentOptions(config);
        if (opts.length === 0 || !working.agent) return;
        const next = cycleOption(opts, working.agent, dir);
        if (next !== working.agent) apply(agentChangePatch(working, next, config));
      } else if (field === "model") {
        if (!working.agent) return;
        const opts = modelIdsForAgent(working.agent, config);
        if (opts.length === 0 || !working.model) return;
        const next = cycleOption(opts, working.model, dir);
        if (next !== working.model) apply(modelChangePatch(working, next, config));
      } else if (field === "effort") {
        if (!working.agent || !working.model) return;
        const opts = effortOptions(working.agent, working.model, config);
        const current = working.effort ?? EDITOR_EFFORT_NONE;
        const next = cycleOption(opts, current, dir);
        if (next !== current) apply(effortChangePatch(next));
      }
    },
    [working, config, apply],
  );

  useInput((input, key) => {
    if (editingPrompt) {
      if (key.escape || key.return) {
        setEditingPrompt(false);
        return;
      }
      if (key.backspace || key.delete) {
        apply({ prompt: working.prompt.slice(0, -1) });
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        apply({ prompt: working.prompt + input });
      }
      return;
    }

    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      setFocusIndex((i) => Math.max(0, Math.min(i, fields.length - 1) - 1));
      return;
    }
    if (key.downArrow) {
      setFocusIndex((i) => Math.min(fields.length - 1, i + 1));
      return;
    }
    if (!focusedField) return;
    if (focusedField === "prompt") {
      if (key.return) setEditingPrompt(true);
      return;
    }
    if (key.leftArrow) cycleField(focusedField, -1);
    else if (key.rightArrow) cycleField(focusedField, 1);
  });

  const innerWidth = Math.max(20, width - 6);
  const agentColor = working.agent ? (AGENT_COLOR[working.agent] ?? "white") : "gray";

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} height={height}>
      <Box justifyContent="space-between">
        <Text color="cyan" bold>
          edit step · {target.workflowName} › {target.stepId}{" "}
          <Text color="magenta">({target.kindLabel})</Text>
        </Text>
        <Text color="gray">
          {editingPrompt
            ? "type · Enter/Esc done"
            : "↑/↓ field · ←/→ change · Enter edit · Esc close"}
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1} flexGrow={1}>
        {fields.length === 0 ? (
          <Text color="gray">This step has no editable parameters.</Text>
        ) : (
          fields.map((field, i) => {
            const focused = i === clampedFocus;
            return (
              <Box key={field} flexDirection="column">
                <Box>
                  <Text color={focused ? "cyan" : "gray"}>{focused ? "▶ " : "  "}</Text>
                  <Text color={focused ? "cyan" : "white"} bold={focused}>
                    {FIELD_LABEL[field].padEnd(7)}
                  </Text>
                  <Text color="gray">{"  "}</Text>
                  {field === "agent" ? (
                    <Text color={agentColor}>‹ {working.agent} ›</Text>
                  ) : field === "model" ? (
                    <Text color="white">
                      ‹ {modelLabel(working.agent, working.model, config)} ›
                    </Text>
                  ) : field === "effort" ? (
                    <Text color="white">‹ {working.effort ?? EDITOR_EFFORT_NONE} ›</Text>
                  ) : (
                    <Text color={focused ? "cyan" : "white"}>
                      {editingPrompt && focused
                        ? "(editing below)"
                        : promptPreview(working.prompt, innerWidth)}
                    </Text>
                  )}
                </Box>
              </Box>
            );
          })
        )}

        {focusedField === "prompt" ? (
          <Box
            flexDirection="column"
            marginTop={1}
            borderStyle="round"
            borderColor="gray"
            paddingX={1}
          >
            <Text color="gray">prompt {editingPrompt ? "(editing)" : "(Enter to edit)"}:</Text>
            <Box width={innerWidth}>
              <Text wrap="wrap">
                {working.prompt || (editingPrompt ? "" : "(blank)")}
                {editingPrompt ? <Text color="cyan">▋</Text> : null}
              </Text>
            </Box>
          </Box>
        ) : null}
      </Box>

      <Box>
        <Text color="gray">changes stage as session overrides · /save-workflows to persist</Text>
      </Box>
    </Box>
  );
}

function modelLabel(
  agent: string | undefined,
  model: string | undefined,
  config: SteamtrainConfig,
): string {
  if (!agent || !model) return model ?? "(none)";
  const name = modelNameForAgent(agent, model, config);
  return name === model ? model : `${name} (${model})`;
}

function promptPreview(prompt: string, width: number): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  if (!oneLine) return "(blank)";
  return truncate(oneLine, Math.max(24, width - 16));
}
