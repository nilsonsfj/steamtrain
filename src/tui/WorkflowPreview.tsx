import { Box, Text } from "ink";
import { useMemo } from "react";
import { truncate } from "../agents/util";
import type { DispatchCheck } from "../orchestrator";
import {
  type PlanResult,
  type ReroutePlan,
  type WorkflowSourceKind,
  type WorkflowSpec,
  autonomyBadge,
  formatReroutePlan,
  isAgentBackedStep,
  lintTemplateRefs,
  workflowAutonomy,
  workflowStepKind,
} from "../workflow";
import { AGENT_COLOR, AUTONOMY_COLOR, WORKFLOW_SOURCE_COLOR } from "./theme";
import { selectVisibleWindow } from "./workflow-list-window";
import {
  BLOCK_LABEL,
  type FlatSpecStep,
  blockSummary,
  distinctAgents,
  flattenSpecSteps,
  formatLlmTarget,
  formatWorkflowAgentTarget,
  promptForStep,
  specDetailLines,
  specStepRowMeta,
} from "./workflow-spec-ui";

export type { FlatSpecStep };
export { flattenSpecSteps };

interface WorkflowPreviewProps {
  spec: WorkflowSpec;
  source: WorkflowSourceKind;
  width: number;
  height: number;
  selectedIndex: number;
  dispatchCheck: DispatchCheck;
  /** Present when the blocked steps can be re-routed to a ready agent (`/reroute`). */
  reroutePlan?: ReroutePlan;
  canResume?: boolean;
  promptEditing?: boolean;
  planResult?: PlanResult | null;
  showStepDetail?: boolean;
  showPlanResult?: boolean;
  /**
   * Catalog lookup for `kind: "workflow"` steps, so the autonomy badge
   * reflects checkpoints nested inside sub-workflows (matching the picker,
   * CLI list/plan, and web cards). Omitted ⇒ own steps only.
   */
  resolveWorkflow?: (name: string) => WorkflowSpec | undefined;
}

type PreviewRow =
  | { kind: "phase"; phase: WorkflowSpec["phases"][number] }
  | { kind: "step"; entry: FlatSpecStep };

/**
 * Pre-run workflow visualization: full spec drill-down before dispatch.
 * Ctrl+R from the prompt runs the workflow; Enter resumes from cache; Esc backs out when idle.
 */
export function WorkflowPreview({
  spec,
  source,
  width,
  height,
  selectedIndex,
  dispatchCheck,
  reroutePlan,
  canResume = false,
  promptEditing = false,
  planResult = null,
  showStepDetail = true,
  showPlanResult = true,
  resolveWorkflow,
}: WorkflowPreviewProps) {
  const innerWidth = Math.max(20, width - 4);
  const flat = useMemo(() => flattenSpecSteps(spec), [spec]);
  const clampedIndex = Math.min(selectedIndex, Math.max(0, flat.length - 1));
  const selected = flat[clampedIndex];
  const rows = useMemo<PreviewRow[]>(
    () =>
      spec.phases.flatMap((phase) => [
        { kind: "phase" as const, phase },
        ...flat
          .filter((entry) => entry.phase.id === phase.id)
          .map((entry) => ({ kind: "step" as const, entry })),
      ]),
    [spec.phases, flat],
  );
  const foundIndex = rows.findIndex(
    (row) => row.kind === "step" && row.entry.flatIndex === clampedIndex,
  );
  const selectedRowIndex = foundIndex >= 0 ? foundIndex : 0;
  const listBudget = Math.max(1, height - (selected && showStepDetail ? 13 : 8));
  const detailMaxHeight = Math.max(1, height - listBudget - 4);
  const rowWindow = selectVisibleWindow(rows, selectedRowIndex, listBudget);
  const phaseCount = spec.phases.length;
  const stepCount = flat.length;
  const agents = useMemo(() => distinctAgents(spec), [spec]);
  const blocks = useMemo(() => blockSummary(spec), [spec]);
  const autonomy = useMemo(() => workflowAutonomy(spec, resolveWorkflow), [spec, resolveWorkflow]);
  const templateWarnings = useMemo(() => lintTemplateRefs(spec), [spec]);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={dispatchCheck.ok ? "cyan" : "yellow"}
      paddingX={1}
      height={height}
    >
      <Box justifyContent="space-between">
        <Text color="cyan" bold>
          workflow preview · {spec.name}{" "}
          <Text color={WORKFLOW_SOURCE_COLOR[source]}>({source})</Text>
        </Text>
        <Text color="gray">
          {promptEditing
            ? `↑/↓ history${canResume ? " · Enter resume" : ""} · Esc list`
            : `↑/↓ · Tab detail · → step details${canResume ? " · Enter resume" : ""} · Ctrl+R run · Ctrl+D plan · Esc`}
        </Text>
      </Box>

      {spec.description ? (
        <Text color="gray" wrap="truncate-end">
          {spec.description}
        </Text>
      ) : null}

      <Box flexDirection="column" marginBottom={1}>
        <Text color="gray">
          {phaseCount} phase{phaseCount === 1 ? "" : "s"} · {stepCount} step
          {stepCount === 1 ? "" : "s"} · ({source}) ·{" "}
          <Text color={AUTONOMY_COLOR[autonomy]}>{autonomyBadge(autonomy)}</Text>
          {agents.length > 0 ? ` · agents: ${agents.join(", ")}` : ""}
          {blocks ? ` · ${blocks}` : ""}
        </Text>
        <Text color={dispatchCheck.ok ? "green" : "yellow"}>
          {dispatchCheck.ok ? "ready to run" : `blocked: ${dispatchCheck.reason}`}
        </Text>
        {!dispatchCheck.ok && reroutePlan ? (
          <Text color="cyan">
            ↷ /reroute — {formatReroutePlan(reroutePlan)} (this session only)
          </Text>
        ) : null}
        {templateWarnings.length > 0 ? (
          <Text color="yellow">
            ⚠ {templateWarnings.length} template warning{templateWarnings.length === 1 ? "" : "s"}
          </Text>
        ) : null}
        {showPlanResult && planResult?.ok ? (
          <PlanResultView plan={planResult} width={innerWidth} />
        ) : showPlanResult && planResult && !planResult.ok ? (
          <Text color="red">plan failed: {planResult.error}</Text>
        ) : null}
      </Box>

      <Box flexDirection="column" flexGrow={1}>
        {rows.length === 0 ? (
          <Text color="gray">No phases defined.</Text>
        ) : (
          <>
            {rowWindow.hiddenBefore > 0 ? (
              <Text color="gray">
                {rowWindow.hiddenBefore} earlier row{rowWindow.hiddenBefore === 1 ? "" : "s"} hidden
                ↑
              </Text>
            ) : null}
            {rowWindow.visible.map((row, offset) =>
              row.kind === "phase" ? (
                <PhaseRow key={`phase-${row.phase.id}`} phase={row.phase} width={innerWidth} />
              ) : (
                <SpecStepRow
                  key={`step-${row.entry.step.id}`}
                  step={row.entry.step}
                  selected={rowWindow.start + offset === selectedRowIndex}
                  width={innerWidth}
                />
              ),
            )}
            {rowWindow.hiddenAfter > 0 ? (
              <Text color="gray">
                {rowWindow.hiddenAfter} later row{rowWindow.hiddenAfter === 1 ? "" : "s"} hidden ↓
              </Text>
            ) : null}
          </>
        )}
      </Box>

      {showStepDetail && selected ? (
        <SpecStepDetail entry={selected} width={innerWidth} maxHeight={detailMaxHeight} />
      ) : null}
    </Box>
  );
}

function PhaseRow({ phase, width }: { phase: WorkflowSpec["phases"][number]; width: number }) {
  const phaseText = `─ ${phase.title}`;
  const metaText = `  ${phase.id} · ${phase.steps.length} step${phase.steps.length === 1 ? "" : "s"}`;
  const remainingWidth = Math.max(0, width - phaseText.length - metaText.length);
  return (
    <Box>
      <Text color="cyan" bold>
        {phaseText}
      </Text>
      <Text color="gray">
        {metaText}
        {" ".repeat(remainingWidth)}
      </Text>
    </Box>
  );
}

function SpecStepRow({
  step,
  selected,
  width,
}: {
  step: FlatSpecStep["step"];
  selected: boolean;
  width: number;
}) {
  const kind = workflowStepKind(step);
  const agentColor = isAgentBackedStep(step) ? (AGENT_COLOR[step.agent] ?? "white") : "gray";
  const runner = isAgentBackedStep(step)
    ? formatWorkflowAgentTarget({ agent: step.agent, model: step.model, effort: step.effort })
    : step.kind === "llm"
      ? formatLlmTarget(step)
      : BLOCK_LABEL[kind];
  const meta = specStepRowMeta(step);
  return (
    <Box paddingLeft={1}>
      <Text color={selected ? "cyan" : "gray"}>{selected ? "▶ " : "  "}</Text>
      <Text color="magenta">{BLOCK_LABEL[kind]} </Text>
      <Text color="white" bold={selected}>
        {step.id}
      </Text>
      <Text color="gray">{"  "}</Text>
      <Text color={agentColor}>{truncate(runner, width - 30)}</Text>
      {meta ? <Text color="gray">{truncate(`  ${meta}`, Math.max(8, width - 44))}</Text> : null}
    </Box>
  );
}

function SpecStepDetail({
  entry,
  width,
  maxHeight,
}: { entry: FlatSpecStep; width: number; maxHeight?: number }) {
  const { step, phase } = entry;
  const kind = workflowStepKind(step);
  const lines = specDetailLines(step);
  const prompt = promptForStep(step);
  const runner = isAgentBackedStep(step)
    ? formatWorkflowAgentTarget({ agent: step.agent, model: step.model, effort: step.effort })
    : step.kind === "llm"
      ? formatLlmTarget(step)
      : undefined;
  const runnerColor = isAgentBackedStep(step) ? (AGENT_COLOR[step.agent] ?? "white") : "gray";

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      overflow="hidden"
      {...(maxHeight != null ? { height: maxHeight } : {})}
    >
      <Text color="cyan">
        {step.id} · {kind} · phase {phase.title}
      </Text>
      {runner ? <Text color={runnerColor}>runner: {runner}</Text> : null}
      {lines.map((line) => (
        <Text key={line} color="gray" wrap="truncate-end">
          {line}
        </Text>
      ))}
      {prompt ? (
        <Box width={width} flexDirection="column">
          <Text color="gray">prompt:</Text>
          <Text wrap="wrap">{truncate(prompt, 900)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function PlanResultView({ plan, width }: { plan: PlanResult; width: number }) {
  const promptSteps = useMemo(() => plan.steps.filter((s) => s.renderedPrompt), [plan.steps]);
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>
        dry-run plan
      </Text>
      <Text color="white">
        {plan.phaseCount} phase{plan.phaseCount === 1 ? "" : "s"} · {plan.staticStepCount} step
        {plan.staticStepCount === 1 ? "" : "s"} · {plan.agentCallCount} agent call
        {plan.agentCallCount === 1 ? "" : "s"} · {plan.llmCallCount} llm call
        {plan.llmCallCount === 1 ? "" : "s"} · {plan.deterministicCount} deterministic
      </Text>
      {plan.agents.length > 0 ? <Text color="gray">agents: {plan.agents.join(", ")}</Text> : null}
      {plan.apis.length > 0 ? <Text color="gray">apis: {plan.apis.join(", ")}</Text> : null}
      {plan.maxCostUsd !== undefined ? (
        <Text color="gray">budget: ${plan.maxCostUsd.toFixed(2)}</Text>
      ) : null}
      {plan.forEachSteps.length > 0 || plan.forEachDynamicSteps.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">fan-out:</Text>
          {plan.forEachSteps.map((fe) => (
            <Text key={fe.stepId} color="gray">
              {"  "}
              {fe.stepId} → {fe.source} ({fe.count} items)
            </Text>
          ))}
          {plan.forEachDynamicSteps.map((fe) => (
            <Text key={fe.stepId} color="gray">
              {"  "}
              {fe.stepId} → {fe.source} (dynamic)
            </Text>
          ))}
        </Box>
      ) : null}
      {plan.loopGates.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">loops:</Text>
          {plan.loopGates.map((lg) => (
            <Text key={lg.gateId} color="gray">
              {"  "}
              {lg.gateId} → {lg.loopTo} (max {lg.maxIterations} iterations)
            </Text>
          ))}
        </Box>
      ) : null}
      {promptSteps.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">rendered prompts ({promptSteps.length}):</Text>
          {promptSteps.slice(0, 5).map((s) => (
            <Box key={s.stepId} flexDirection="column">
              <Text color="white">
                {"  "}
                {s.stepId}: {truncate(s.renderedPrompt ?? "", Math.max(40, width - 12))}
              </Text>
            </Box>
          ))}
          {promptSteps.length > 5 ? (
            <Text color="gray">
              {"  "}... and {promptSteps.length - 5} more
            </Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}
