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
  formatElapsed,
  formatReroutePlan,
  formatUsd,
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
  type PreviewRenderContext,
  blockSummary,
  distinctAgents,
  flattenSpecSteps,
  formatLlmTarget,
  formatWorkflowAgentTarget,
  previewInputValues,
  promptForStep,
  specDetailLines,
  specStepRowMeta,
} from "./workflow-spec-ui";

/** Cap description wrap so chrome cannot starve the step tree. */
const DESCRIPTION_MAX_LINES = 3;

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
  /** Workflow prompt text, used to resolve `{{input}}` in preview chrome. */
  input?: string;
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
  input = "",
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
  const agents = useMemo(() => distinctAgents(spec), [spec]);
  const blocks = useMemo(() => blockSummary(spec), [spec]);
  const autonomy = useMemo(() => workflowAutonomy(spec, resolveWorkflow), [spec, resolveWorkflow]);
  const templateWarnings = useMemo(() => lintTemplateRefs(spec), [spec]);
  const renderCtx = useMemo<PreviewRenderContext>(
    () => ({ input, inputs: previewInputValues(spec) }),
    [input, spec],
  );
  // Pre-wrap description into a fixed row budget so Ink never soft-wraps past
  // chromeLines (that overflow is what used to bleed into the step tree).
  const descriptionLines = useMemo(() => {
    const raw = spec.description?.trim();
    if (!raw) return [] as string[];
    return clipWrappedLines(wrapTextLines(raw, innerWidth), DESCRIPTION_MAX_LINES);
  }, [spec.description, innerWidth]);

  const showPlan =
    showPlanResult && planResult != null ? 1 + (planResult.ok && planResult.history ? 1 : 0) : 0;
  // Count chrome rows precisely so the detail panel never steals from the
  // tree (or vice versa) enough to force Ink wrap-overlap corruption.
  const chromeLines =
    1 + // title
    descriptionLines.length +
    1 + // phase/step summary
    1 + // ready / blocked
    (!dispatchCheck.ok && reroutePlan ? 1 : 0) +
    (templateWarnings.length > 0 ? 1 : 0) +
    showPlan +
    1; // spacer after the meta block (marginBottom)
  const detailDesired =
    selected && showStepDetail ? Math.min(9, Math.max(4, Math.floor((height - 2) * 0.35))) : 0;
  const listBudget = Math.max(1, height - 2 - chromeLines - detailDesired);
  const detailMaxHeight = Math.max(0, height - 2 - chromeLines - listBudget);
  const rowWindow = selectVisibleWindow(rows, selectedRowIndex, listBudget);
  const phaseCount = spec.phases.length;
  const stepCount = flat.length;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={dispatchCheck.ok ? "cyan" : "yellow"}
      paddingX={1}
      height={height}
      overflow="hidden"
    >
      <Box>
        <Box flexGrow={1} flexShrink={1} marginRight={1} overflow="hidden">
          <Text color="cyan" bold wrap="truncate-end">
            workflow preview · {spec.name}{" "}
            <Text color={WORKFLOW_SOURCE_COLOR[source]}>({source})</Text>
          </Text>
        </Box>
        <Box flexShrink={1} overflow="hidden">
          <Text color="gray" wrap="truncate-end">
            {promptEditing
              ? `↑/↓ history${canResume ? " · Enter resume" : ""} · Esc list`
              : `↑/↓ · Tab detail · → step details${canResume ? " · Enter resume" : ""} · Ctrl+R run · Ctrl+D plan · Esc`}
          </Text>
        </Box>
      </Box>

      {descriptionLines.map((line, lineNo) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: wrap order is the identity
        <Text key={lineNo} color="gray" wrap="truncate-end">
          {line || " "}
        </Text>
      ))}

      <Box flexDirection="column" marginBottom={1}>
        <Text color="gray" wrap="truncate-end">
          {phaseCount} phase{phaseCount === 1 ? "" : "s"} · {stepCount} step
          {stepCount === 1 ? "" : "s"} · ({source}) ·{" "}
          <Text color={AUTONOMY_COLOR[autonomy]}>{autonomyBadge(autonomy)}</Text>
          {agents.length > 0 ? ` · agents: ${agents.join(", ")}` : ""}
          {blocks ? ` · ${blocks}` : ""}
        </Text>
        <Text color={dispatchCheck.ok ? "green" : "yellow"} wrap="truncate-end">
          {dispatchCheck.ok ? "ready to run" : `blocked: ${dispatchCheck.reason}`}
        </Text>
        {!dispatchCheck.ok && reroutePlan ? (
          <Text color="cyan" wrap="truncate-end">
            ↷ /reroute — {formatReroutePlan(reroutePlan)}
          </Text>
        ) : null}
        {templateWarnings.length > 0 ? (
          <Text color="yellow" wrap="truncate-end">
            ⚠ {templateWarnings.length} template warning{templateWarnings.length === 1 ? "" : "s"}
          </Text>
        ) : null}
        {showPlanResult && planResult?.ok ? (
          <PlanResultView plan={planResult} width={innerWidth} />
        ) : showPlanResult && planResult && !planResult.ok ? (
          <Text color="red" wrap="truncate-end">
            plan failed: {planResult.error}
          </Text>
        ) : null}
      </Box>

      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {rows.length === 0 ? (
          <Text color="gray">No phases defined.</Text>
        ) : (
          <>
            {rowWindow.hiddenBefore > 0 ? (
              <Text color="gray" wrap="truncate-end">
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
                  renderCtx={renderCtx}
                />
              ),
            )}
            {rowWindow.hiddenAfter > 0 ? (
              <Text color="gray" wrap="truncate-end">
                {rowWindow.hiddenAfter} later row{rowWindow.hiddenAfter === 1 ? "" : "s"} hidden ↓
              </Text>
            ) : null}
          </>
        )}
      </Box>

      {showStepDetail && selected && detailMaxHeight > 0 ? (
        <SpecStepDetail
          entry={selected}
          width={innerWidth}
          maxHeight={detailMaxHeight}
          renderCtx={renderCtx}
        />
      ) : null}
    </Box>
  );
}

function PhaseRow({ phase, width }: { phase: WorkflowSpec["phases"][number]; width: number }) {
  const phaseText = `─ ${phase.title}`;
  const metaText = `  ${phase.id} · ${phase.steps.length} step${phase.steps.length === 1 ? "" : "s"}`;
  const remainingWidth = Math.max(0, width - phaseText.length - metaText.length);
  return (
    <Text wrap="truncate-end">
      <Text color="cyan" bold>
        {phaseText}
      </Text>
      <Text color="gray">
        {metaText}
        {" ".repeat(remainingWidth)}
      </Text>
    </Text>
  );
}

function SpecStepRow({
  step,
  selected,
  renderCtx,
}: {
  step: FlatSpecStep["step"];
  selected: boolean;
  renderCtx: PreviewRenderContext;
}) {
  const kind = workflowStepKind(step);
  const agentColor = isAgentBackedStep(step)
    ? step.agent
      ? (AGENT_COLOR[step.agent] ?? "white")
      : "cyan"
    : "gray";
  const runner = isAgentBackedStep(step)
    ? formatWorkflowAgentTarget(
        {
          agent: step.agent,
          model: step.model,
          modelClass: step.modelClass,
          effort: step.effort,
        },
        renderCtx,
      )
    : step.kind === "llm"
      ? formatLlmTarget(step, renderCtx)
      : BLOCK_LABEL[kind];
  const meta = specStepRowMeta(step, renderCtx);
  // Single truncate-end Text: independent sibling Text nodes with separate
  // truncate budgets were overflowing into neighboring rows (Ink wrap overlap).
  return (
    <Text wrap="truncate-end">
      <Text color={selected ? "cyan" : "gray"}>{selected ? "▶ " : "  "}</Text>
      <Text color="magenta">{BLOCK_LABEL[kind]} </Text>
      <Text color="white" bold={selected}>
        {step.id}
      </Text>
      <Text color="gray">{"  "}</Text>
      <Text color={agentColor}>{runner}</Text>
      {meta ? <Text color="gray">{`  ${meta}`}</Text> : null}
    </Text>
  );
}

function SpecStepDetail({
  entry,
  width,
  maxHeight,
  renderCtx,
}: {
  entry: FlatSpecStep;
  width: number;
  maxHeight?: number;
  renderCtx: PreviewRenderContext;
}) {
  const { step, phase } = entry;
  const kind = workflowStepKind(step);
  const lines = specDetailLines(step, renderCtx);
  const prompt = promptForStep(step, renderCtx);
  const runner = isAgentBackedStep(step)
    ? formatWorkflowAgentTarget(
        {
          agent: step.agent,
          model: step.model,
          modelClass: step.modelClass,
          effort: step.effort,
        },
        renderCtx,
      )
    : step.kind === "llm"
      ? formatLlmTarget(step, renderCtx)
      : undefined;
  const runnerColor = isAgentBackedStep(step)
    ? step.agent
      ? (AGENT_COLOR[step.agent] ?? "white")
      : "cyan"
    : "gray";

  // Stay inside the reserved height: border (2) + header + optional runner +
  // detail lines + optional prompt label/body. Pre-wrap the prompt into the
  // leftover rows so long prompts fill empty panel space instead of sitting
  // on a single truncated line.
  const border = 2;
  const headerLines = 1 + (runner ? 1 : 0);
  const available = Math.max(0, (maxHeight ?? Number.POSITIVE_INFINITY) - border - headerLines);
  // Reserve at least label + one body row when a prompt exists; give the rest
  // to structured detail lines first, then expand the prompt into leftovers.
  const promptMin = prompt ? 2 : 0;
  const bodyBudget = Math.max(0, available - promptMin);
  const visibleLines = lines.slice(0, Math.max(0, bodyBudget));
  const promptRows = Math.max(0, available - visibleLines.length);
  const showPrompt = Boolean(prompt) && promptRows >= 2;
  const promptBodyBudget = showPrompt ? promptRows - 1 : 0;
  const promptText = prompt?.trim() ?? "";
  const promptLines = showPrompt
    ? clipWrappedLines(wrapTextLines(promptText, Math.max(4, width - 2)), promptBodyBudget)
    : [];

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      overflow="hidden"
      {...(maxHeight != null ? { height: maxHeight } : {})}
    >
      <Text color="cyan" wrap="truncate-end">
        {step.id} · {kind} · phase {phase.title}
      </Text>
      {runner ? (
        <Text color={runnerColor} wrap="truncate-end">
          runner: {runner}
        </Text>
      ) : null}
      {visibleLines.map((line, lineNo) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: wrap order is the identity
        <Text key={lineNo} color="gray" wrap="truncate-end">
          {line}
        </Text>
      ))}
      {showPrompt ? (
        <>
          <Text color="gray" wrap="truncate-end">
            prompt:
          </Text>
          {promptLines.map((line, lineNo) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: wrap order is the identity
            <Text key={lineNo} wrap="truncate-end">
              {line || " "}
            </Text>
          ))}
        </>
      ) : null}
    </Box>
  );
}

/**
 * Take the first `maxLines` wrapped rows. When content is clipped, mark the
 * last visible row with an ellipsis so the truncation is obvious.
 */
function clipWrappedLines(lines: string[], maxLines: number): string[] {
  if (maxLines <= 0 || lines.length === 0) return [];
  if (lines.length <= maxLines) return lines;
  const visible = lines.slice(0, maxLines);
  const last = visible[maxLines - 1] ?? "";
  visible[maxLines - 1] = `${last.slice(0, Math.max(0, last.length - 1))}…`;
  return visible;
}

/**
 * Soft-wrap `text` at word boundaries into fixed-width rows. Falls back to hard
 * slices for tokens longer than `width`. Preserves explicit newlines as row
 * breaks so multi-line prompts keep paragraph structure.
 */
function wrapTextLines(text: string, width: number): string[] {
  const cols = Math.max(4, width);
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const paragraph = raw.replace(/\t/g, " ").replace(/ +/g, " ").trim();
    if (paragraph.length === 0) {
      if (raw.length > 0) out.push("");
      continue;
    }
    let current = "";
    for (const word of paragraph.split(" ")) {
      if (word.length > cols) {
        if (current) {
          out.push(current);
          current = "";
        }
        for (let i = 0; i < word.length; i += cols) out.push(word.slice(i, i + cols));
        continue;
      }
      const next = current ? `${current} ${word}` : word;
      if (next.length <= cols) {
        current = next;
      } else {
        out.push(current);
        current = word;
      }
    }
    if (current) out.push(current);
  }
  return out;
}

function PlanResultView({ plan, width }: { plan: PlanResult; width: number }) {
  const promptSteps = useMemo(() => plan.steps.filter((s) => s.renderedPrompt), [plan.steps]);
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold wrap="truncate-end">
        dry-run plan
      </Text>
      <Text color="white" wrap="truncate-end">
        {plan.phaseCount} phase{plan.phaseCount === 1 ? "" : "s"} · {plan.staticStepCount} step
        {plan.staticStepCount === 1 ? "" : "s"} · {plan.agentCallCount} agent call
        {plan.agentCallCount === 1 ? "" : "s"} · {plan.llmCallCount} llm call
        {plan.llmCallCount === 1 ? "" : "s"} · {plan.deterministicCount} deterministic
      </Text>
      {plan.agents.length > 0 ? (
        <Text color="gray" wrap="truncate-end">
          agents: {plan.agents.join(", ")}
        </Text>
      ) : null}
      {plan.apis.length > 0 ? (
        <Text color="gray" wrap="truncate-end">
          apis: {plan.apis.join(", ")}
        </Text>
      ) : null}
      {plan.maxCostUsd !== undefined ? (
        <Text color="gray" wrap="truncate-end">
          budget: ${plan.maxCostUsd.toFixed(2)}
        </Text>
      ) : null}
      {plan.history ? (
        <Text color="gray" wrap="truncate-end">
          observed across {plan.history.runs} completed run{plan.history.runs === 1 ? "" : "s"}: avg{" "}
          {formatUsd(plan.history.avgCostUsd)}
          {plan.history.runs > 1
            ? ` (${formatUsd(plan.history.minCostUsd)}–${formatUsd(plan.history.maxCostUsd)})`
            : ""}
          {" · "}
          {formatElapsed(plan.history.avgDurationMs)}
        </Text>
      ) : null}
      {plan.forEachSteps.length > 0 || plan.forEachDynamicSteps.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">fan-out:</Text>
          {plan.forEachSteps.map((fe) => (
            <Text key={fe.stepId} color="gray" wrap="truncate-end">
              {"  "}
              {fe.stepId} → {fe.source} ({fe.count} items)
            </Text>
          ))}
          {plan.forEachDynamicSteps.map((fe) => (
            <Text key={fe.stepId} color="gray" wrap="truncate-end">
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
            <Text key={lg.gateId} color="gray" wrap="truncate-end">
              {"  "}
              {lg.gateId} → {lg.loopTo} (max {lg.maxIterations} iterations)
            </Text>
          ))}
        </Box>
      ) : null}
      {promptSteps.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray" wrap="truncate-end">
            rendered prompts ({promptSteps.length}):
          </Text>
          {promptSteps.slice(0, 5).map((s) => (
            <Box key={s.stepId} flexDirection="column">
              <Text color="white" wrap="truncate-end">
                {"  "}
                {s.stepId}: {truncate(s.renderedPrompt ?? "", Math.max(40, width - 12))}
              </Text>
            </Box>
          ))}
          {promptSteps.length > 5 ? (
            <Text color="gray" wrap="truncate-end">
              {"  "}... and {promptSteps.length - 5} more
            </Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}
