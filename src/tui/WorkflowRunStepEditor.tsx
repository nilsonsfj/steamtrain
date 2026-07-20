import { Box, Text, useInput } from "ink";
import { useCallback, useMemo, useState } from "react";
import { modelIdsForAgent, modelNameForAgent } from "../agents";
import { truncate } from "../agents/util";
import { MAX_PROMPT_CHARS, type SteamtrainConfig } from "../config";
import type { StepEditPatch } from "../workflow";
import {
  EDITOR_EFFORT_NONE,
  cycleOption,
  effortOptions,
  modelChangePatch,
} from "./workflow-step-editor";

/**
 * Mid-run (pause → edit → resume) editor target. Covers prompt/cmd plus
 * optional model/effort when the step kind supports them.
 */
export interface RunStepEditorTarget {
  stepId: string;
  /** Human label for the step's block kind (worker/llm/command/…). */
  kindLabel: string;
  /** Which text field the step carries: prompt (agent/llm/…) or cmd (command). */
  field: "prompt" | "cmd";
  /** Current text: the spec value merged with any already-accepted edit. */
  initial: string;
  /** When set, model/effort rows are editable (agent-backed or llm). */
  modelEditable?: boolean;
  agent?: string;
  model?: string;
  effort?: string;
}

type RunField = "text" | "model" | "effort";

interface WorkflowRunStepEditorProps {
  target: RunStepEditorTarget;
  config: SteamtrainConfig;
  width: number;
  height: number;
  /** Stage the edit through the run's steering control (one audited intervention). */
  onApply: (patch: StepEditPatch) => void;
  onClose: () => void;
}

/**
 * Mid-run (pause → edit → resume) editor for a pending step, reached with `e`
 * while a run is paused. Unlike the preview-time `WorkflowStepEditor` (which
 * stages session overrides per keystroke), this buffers locally and submits
 * ONE edit on Enter — each accepted edit is an audited intervention in the run
 * record, so it should be the final patch, not a keystroke stream.
 */
export function WorkflowRunStepEditor({
  target,
  config,
  width,
  height,
  onApply,
  onClose,
}: WorkflowRunStepEditorProps) {
  const [value, setValue] = useState(target.initial);
  const [model, setModel] = useState(target.model);
  const [effort, setEffort] = useState(target.effort);
  const [focus, setFocus] = useState<RunField>("text");
  const [editingText, setEditingText] = useState(true);

  const fields = useMemo<RunField[]>(() => {
    const list: RunField[] = ["text"];
    if (target.modelEditable && target.agent && model) {
      list.push("model");
      if (effortOptions(target.agent, model, config).length > 1) list.push("effort");
    }
    return list;
  }, [target.modelEditable, target.agent, model, config]);

  const focusIndex = Math.min(Math.max(0, fields.indexOf(focus)), Math.max(0, fields.length - 1));
  const focusedField = fields[focusIndex] ?? "text";

  const textChanged = value !== target.initial;
  const modelChanged = target.modelEditable && model !== undefined && model !== target.model;
  const effortChanged =
    target.modelEditable && (effort ?? undefined) !== (target.effort ?? undefined);
  const changed = textChanged || modelChanged || effortChanged;

  const commit = useCallback(() => {
    if (!changed) {
      onClose();
      return;
    }
    const patch: StepEditPatch = {};
    if (textChanged && value.trim()) {
      if (target.field === "cmd") patch.cmd = value;
      else patch.prompt = value;
    }
    if (modelChanged && model) patch.model = model;
    if (effortChanged) patch.effort = effort;
    if (Object.keys(patch).length > 0) onApply(patch);
    onClose();
  }, [
    changed,
    textChanged,
    modelChanged,
    effortChanged,
    value,
    model,
    effort,
    target.field,
    onApply,
    onClose,
  ]);

  useInput((input, key) => {
    if (editingText && focusedField === "text") {
      if (key.escape) {
        setEditingText(false);
        return;
      }
      if (key.return) {
        // Enter while typing commits when there are no model rows; otherwise
        // leave text editing so ↑/↓ can reach model/effort before applying.
        if (fields.length === 1) {
          commit();
          return;
        }
        setEditingText(false);
        return;
      }
      if (key.backspace || key.delete) {
        setValue((prev) => prev.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setValue((prev) => (prev.length >= MAX_PROMPT_CHARS ? prev : prev + input));
      }
      return;
    }

    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      const next = Math.max(0, focusIndex - 1);
      setFocus(fields[next] ?? "text");
      return;
    }
    if (key.downArrow) {
      const next = Math.min(fields.length - 1, focusIndex + 1);
      setFocus(fields[next] ?? "text");
      return;
    }
    if (focusedField === "text") {
      if (key.return) {
        commit();
        return;
      }
      if (key.backspace || key.delete) {
        setEditingText(true);
        setValue((prev) => prev.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setEditingText(true);
        setValue((prev) => (prev.length >= MAX_PROMPT_CHARS ? prev : prev + input));
      }
      return;
    }
    if (key.return) {
      commit();
      return;
    }
    if (focusedField === "model" && target.agent && model) {
      if (key.leftArrow || key.rightArrow) {
        const opts = modelIdsForAgent(target.agent, config);
        const dir: 1 | -1 = key.leftArrow ? -1 : 1;
        const next = cycleOption(opts, model, dir);
        if (next !== model) {
          const patch = modelChangePatch({ agent: target.agent, model, effort }, next, config);
          setModel(patch.model);
          setEffort(patch.effort);
        }
      }
      return;
    }
    if (focusedField === "effort" && target.agent && model) {
      if (key.leftArrow || key.rightArrow) {
        const opts = effortOptions(target.agent, model, config);
        const current = effort ?? EDITOR_EFFORT_NONE;
        const dir: 1 | -1 = key.leftArrow ? -1 : 1;
        const next = cycleOption(opts, current, dir);
        setEffort(next === EDITOR_EFFORT_NONE ? undefined : next);
      }
    }
  });

  const innerWidth = Math.max(20, width - 6);
  const textLabel = target.field === "cmd" ? "command" : "prompt";

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      height={height}
    >
      <Box justifyContent="space-between">
        <Text color="yellow" bold>
          ⏸ edit paused run · {target.stepId} <Text color="magenta">({target.kindLabel})</Text>
        </Text>
        <Text color="gray">
          {editingText && focusedField === "text"
            ? fields.length > 1
              ? "type · Enter next field · Esc cancel"
              : "type · Enter apply · Esc cancel"
            : "↑/↓ field · ←/→ change · Enter apply · Esc cancel"}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1} flexGrow={1}>
        <Box>
          <Text color={focusedField === "text" ? "cyan" : "gray"}>
            {focusedField === "text" ? "▶ " : "  "}
          </Text>
          <Text color={focusedField === "text" ? "cyan" : "white"} bold={focusedField === "text"}>
            {textLabel.padEnd(7)}
          </Text>
          <Text color="gray"> </Text>
          <Text color={focusedField === "text" ? "cyan" : "white"}>
            {editingText && focusedField === "text"
              ? "(editing below)"
              : truncate(
                  value.replace(/\s+/g, " ").trim() || "(blank)",
                  Math.max(24, innerWidth - 16),
                )}
          </Text>
        </Box>

        {target.modelEditable ? (
          <>
            <Box>
              <Text color={focusedField === "model" ? "cyan" : "gray"}>
                {focusedField === "model" ? "▶ " : "  "}
              </Text>
              <Text
                color={focusedField === "model" ? "cyan" : "white"}
                bold={focusedField === "model"}
              >
                {"model".padEnd(7)}
              </Text>
              <Text color="gray"> </Text>
              <Text color="white">‹ {modelLabel(target.agent, model, config)} ›</Text>
            </Box>
            {fields.includes("effort") ? (
              <Box>
                <Text color={focusedField === "effort" ? "cyan" : "gray"}>
                  {focusedField === "effort" ? "▶ " : "  "}
                </Text>
                <Text
                  color={focusedField === "effort" ? "cyan" : "white"}
                  bold={focusedField === "effort"}
                >
                  {"effort".padEnd(7)}
                </Text>
                <Text color="gray"> </Text>
                <Text color="white">‹ {effort ?? EDITOR_EFFORT_NONE} ›</Text>
              </Box>
            ) : null}
          </>
        ) : null}

        {focusedField === "text" ? (
          <Box
            flexDirection="column"
            marginTop={1}
            borderStyle="round"
            borderColor={editingText ? "yellow" : "gray"}
            paddingX={1}
          >
            <Text color="gray">
              {textLabel} {editingText ? "(editing)" : "(Enter to edit)"} — applies when the step
              runs:
            </Text>
            <Box width={innerWidth}>
              <Text wrap="wrap">
                {value || "(blank)"}
                {editingText ? <Text color="cyan">▋</Text> : null}
              </Text>
            </Box>
          </Box>
        ) : null}
      </Box>
      <Box>
        <Text color="gray">
          {changed
            ? "Enter stages the edit as a recorded intervention · Esc discards it"
            : "unchanged — Enter/Esc closes"}
        </Text>
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
