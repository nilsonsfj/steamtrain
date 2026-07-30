import { Box, Text, useInput } from "ink";
import { useCallback, useMemo, useState } from "react";
import { agentUiLabel, modelIdsForAgent } from "../agents";
import { truncate } from "../agents/util";
import { MAX_PROMPT_CHARS, type SteamtrainConfig } from "../config";
import { shouldAcceptTextInput } from "./text-input-filter";
import { AGENT_COLOR } from "./theme";
import {
  EDITOR_EFFORT_NONE,
  type EditorField,
  type RetargetableStep,
  type StepEditorPatch,
  type StepEditorTarget,
  agentChangePatch,
  agentOptions,
  buildBulkRetargetPatches,
  cycleOption,
  editorFieldsFor,
  effortChangePatch,
  effortOptions,
  modelChangePatch,
  modelLabel,
  summarizeBulkRetarget,
} from "./workflow-step-editor";

interface WorkflowStepEditorProps {
  target: StepEditorTarget;
  config: SteamtrainConfig;
  width: number;
  height: number;
  /** Other agent-backed steps in the same workflow (for apply-to-all). */
  siblings?: readonly RetargetableStep[];
  /** Stage a session override for the focused step (merged into existing overrides). */
  onApply: (patch: StepEditorPatch) => void;
  /**
   * Stage the same agent/model/effort triad onto every agent-backed step.
   * When omitted, `A` is a no-op hint only.
   */
  onApplyAll?: (patches: Record<string, StepEditorPatch>, summary: string) => void;
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
 * Enter edits the prompt; `A` applies the current agent/model/effort to every
 * agent-backed step in the workflow. Every change stages a session override
 * immediately (persist with `/save-workflows`).
 */
export function WorkflowStepEditor({
  target,
  config,
  width,
  height,
  siblings = [],
  onApply,
  onApplyAll,
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
  const [flash, setFlash] = useState<string | undefined>(undefined);

  // Recompute available fields against the *working* copy: switching agents can
  // add or remove the effort row (e.g. haiku has no effort levels).
  const fields = useMemo(
    () => editorFieldsFor({ ...target, ...working }, config),
    [target, working, config],
  );
  const clampedFocus = Math.min(focusIndex, Math.max(0, fields.length - 1));
  const focusedField = fields[clampedFocus];

  const retargetableCount = siblings.length;
  const canApplyAll =
    Boolean(onApplyAll) &&
    target.agentBacked &&
    Boolean(working.agent) &&
    Boolean(working.model) &&
    retargetableCount > 0;

  const apply = useCallback(
    (patch: StepEditorPatch) => {
      setWorking((prev) => ({ ...prev, ...patch }));
      onApply(patch);
      setFlash(undefined);
    },
    [onApply],
  );

  const applyToAll = useCallback(() => {
    if (!canApplyAll || !working.agent || !working.model || !onApplyAll) return;
    const desire = {
      agent: working.agent,
      model: working.model,
      effort: working.effort,
    };
    const patches = buildBulkRetargetPatches(siblings, desire, config);
    // Always include the focused step so the working copy and disk stay aligned
    // even when siblings already matched and patches was empty for them.
    patches[target.stepId] = {
      agent: desire.agent,
      model: desire.model,
      effort: desire.effort,
    };
    const summary = summarizeBulkRetarget(patches, desire, config);
    onApplyAll(patches, summary);
    setFlash(`applied to all · ${summary}`);
  }, [canApplyAll, working, onApplyAll, siblings, config, target.stepId]);

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
        if (working.prompt.length > 0) apply({ prompt: working.prompt.slice(0, -1) });
        return;
      }
      if (shouldAcceptTextInput(input, key)) {
        if (working.prompt.length >= MAX_PROMPT_CHARS) return;
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
    // `A` / `a` — apply the current agent/model/effort triad to every agent step.
    if ((input === "a" || input === "A") && focusedField && focusedField !== "prompt") {
      applyToAll();
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
  const optionHint = focusedField ? fieldOptionHint(focusedField, working, config) : undefined;

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

      {target.agentBacked && retargetableCount > 1 ? (
        <Box marginTop={0}>
          <Text color="gray">
            {retargetableCount} agent steps in this workflow
            {canApplyAll ? (
              <Text color="cyan">
                {" "}
                · press <Text bold>A</Text> to retarget all to ‹{agentUiLabel(working.agent)}/
                {working.model}›
              </Text>
            ) : null}
          </Text>
        </Box>
      ) : null}

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
                    <Text color={agentColor}>‹ {agentUiLabel(working.agent)} ›</Text>
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
                  {focused && optionHint && field !== "prompt" ? (
                    <Text color="gray"> {optionHint}</Text>
                  ) : null}
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
            borderColor={editingPrompt ? "cyan" : "gray"}
            paddingX={1}
          >
            <Text color="gray">
              prompt {editingPrompt ? "(editing — append/backspace)" : "(Enter to edit)"}:
            </Text>
            <Box width={innerWidth}>
              <Text wrap="wrap">
                {working.prompt || (editingPrompt ? "" : "(blank)")}
                {editingPrompt ? <Text color="cyan">▋</Text> : null}
              </Text>
            </Box>
          </Box>
        ) : null}
      </Box>

      <Box flexDirection="column">
        {flash ? (
          <Text color="green">{flash}</Text>
        ) : (
          <Text color="gray">
            changes stage as session overrides · /save-workflows to persist
            {canApplyAll ? " · A = apply agent/model/effort to all steps" : ""}
          </Text>
        )}
      </Box>
    </Box>
  );
}

function fieldOptionHint(
  field: EditorField,
  working: Working,
  config: SteamtrainConfig,
): string | undefined {
  if (field === "agent") {
    const n = agentOptions(config).length;
    return n > 1 ? `(${n} agents)` : undefined;
  }
  if (field === "model" && working.agent) {
    const n = modelIdsForAgent(working.agent, config).length;
    return n > 1 ? `(${n} models)` : undefined;
  }
  if (field === "effort" && working.agent && working.model) {
    const n = effortOptions(working.agent, working.model, config).length;
    return n > 1 ? `(${n} levels)` : undefined;
  }
  return undefined;
}

function promptPreview(prompt: string, width: number): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  if (!oneLine) return "(blank)";
  return truncate(oneLine, Math.max(24, width - 16));
}
