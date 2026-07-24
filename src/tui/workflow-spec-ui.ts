import { basename } from "node:path";
import {
  AMP_MODELS,
  ANTIGRAVITY_MODELS,
  CLAUDE_MODELS,
  CODEX_MODELS,
  CURSOR_MODELS,
  KIMI_MODELS,
  KIRO_MODELS,
  MIMO_MODELS,
  OPENCODE_MODELS,
  formatAgentTarget,
} from "../agents";
import { truncate } from "../agents/util";
import type { AgentInstanceId } from "../types/events";
import {
  type GateCondition,
  type LlmStep,
  type SubWorkflowView,
  type WorkflowPhase,
  type WorkflowSpec,
  type WorkflowStep,
  describeSubWorkflow,
  formatSubWorkflowTarget,
  isAgentBackedStep,
  llmStepApiId,
  renderPrompt,
  resolveInputs,
  subWorkflowRollup,
  workflowStepKind,
} from "../workflow";

/** Resolver for `kind: "workflow"` steps, threaded into row/detail rendering. */
export type ResolveWorkflow = (name: string) => WorkflowSpec | undefined;

/** Values used to resolve `{{inputs.*}}` / `{{input}}` for TUI preview chrome. */
export interface PreviewRenderContext {
  input?: string;
  inputs?: Record<string, string | number | boolean>;
}

/**
 * Resolve declared workflow inputs (defaults applied) for pre-run preview.
 * Does not require the user to have filled the input form yet.
 */
export function previewInputValues(
  spec: WorkflowSpec,
  params: Record<string, string> = {},
): Record<string, string | number | boolean> {
  return resolveInputs(spec, params).values;
}

/**
 * Best-effort template render for preview display. Step/item refs that cannot
 * be known pre-run are left untouched by `renderPrompt`.
 */
export function previewRender(template: string, ctx: PreviewRenderContext = {}): string {
  if (!template.includes("{{")) return template;
  return renderPrompt(template, {
    input: ctx.input ?? "",
    inputs: ctx.inputs,
    outputs: new Map(),
  });
}

/** Like `previewRender`, but maps empty results to `undefined` for optional fields. */
export function previewRenderOptional(
  template: string | undefined,
  ctx: PreviewRenderContext = {},
): string | undefined {
  if (template === undefined) return undefined;
  const rendered = previewRender(template, ctx);
  return rendered.length > 0 ? rendered : undefined;
}

export interface FlatSpecStep {
  phase: WorkflowPhase;
  phaseIndex: number;
  step: WorkflowStep;
  stepIndex: number;
  flatIndex: number;
}

/** Human-readable block kind labels shared by picker, preview, and live view. */
export const BLOCK_LABEL: Record<ReturnType<typeof workflowStepKind>, string> = {
  distributor: "fan-out",
  worker: "worker",
  processor: "process",
  consolidator: "merge",
  gate: "gate",
  approval: "approval",
  human: "human",
  merge: "merge-back",
  command: "command",
  llm: "llm",
  workflow: "sub-workflow",
  issues: "issues",
};

/** Cumulative flat step index at the start of each phase. */
export function phaseStepOffsets(phases: { steps: unknown[] }[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const phase of phases) {
    offsets.push(offset);
    offset += phase.steps.length;
  }
  return offsets;
}

/** Flatten a workflow spec into a navigable step list (for ↑/↓ drill-in). */
export function flattenSpecSteps(spec: WorkflowSpec): FlatSpecStep[] {
  const flat: FlatSpecStep[] = [];
  let flatIndex = 0;
  spec.phases.forEach((phase, phaseIndex) => {
    phase.steps.forEach((step, stepIndex) => {
      flat.push({ phase, phaseIndex, step, stepIndex, flatIndex });
      flatIndex += 1;
    });
  });
  return flat;
}

export function blockSummary(spec: WorkflowSpec): string {
  const counts = new Map<string, number>();
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      const kind = workflowStepKind(step);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([kind, count]) => `${kind}:${count}`).join(" · ");
}

export function distinctAgents(spec: WorkflowSpec): string[] {
  const set = new Set<string>();
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      if (isAgentBackedStep(step) && typeof step.agent === "string") set.add(step.agent);
    }
  }
  return [...set];
}

export function formatWorkflowAgentTarget(
  target: {
    agent?: AgentInstanceId;
    model?: string;
    modelClass?: string;
    effort?: string;
  },
  ctx: PreviewRenderContext = {},
): string {
  const model = previewRenderOptional(target.model, ctx) ?? target.model;
  const modelClass = previewRenderOptional(target.modelClass, ctx) ?? target.modelClass;
  const effort = previewRenderOptional(target.effort, ctx);
  if (!target.agent && modelClass && !model) {
    return `auto · class:${modelClass}${effort ? ` · ${effort}` : ""}`;
  }
  if (!target.agent && model) {
    return `auto · ${model}${effort ? ` · ${effort}` : ""}`;
  }
  if (!target.agent || !model) {
    const parts = [target.agent ?? "auto", model ?? (modelClass ? `class:${modelClass}` : "?")];
    return parts.join("/") + (effort ? ` · ${effort}` : "");
  }
  const formatted = formatAgentTarget({
    agent: target.agent,
    model,
    effort,
  });
  const staticName = staticModelName(target.agent, model);
  return staticName && !formatted.includes(staticName) ? `${formatted} · ${staticName}` : formatted;
}

/**
 * `api/model` display target for a direct-API `llm` step: the configured
 * instance id (or inferred built-in provider), plus the step's model when it
 * names one — a step inheriting the instance's `defaultModel` shows just the
 * api id.
 */
export function formatLlmTarget(step: LlmStep, ctx: PreviewRenderContext = {}): string {
  const api = llmStepApiId(step);
  const model = previewRenderOptional(step.model, ctx) ?? step.model;
  return model ? `${api}/${model}` : api;
}

export function formatGateCondition(condition: GateCondition): string {
  const parts: string[] = [];
  if (condition.step) parts.push(`step=${condition.step}`);
  if (condition.value !== undefined) parts.push(`value=${condition.value}`);
  if (condition.ok !== undefined) parts.push(`ok=${condition.ok}`);
  if (condition.contains !== undefined)
    parts.push(`contains=${JSON.stringify(condition.contains)}`);
  if (condition.matches !== undefined) parts.push(`matches=${condition.matches}`);
  if (condition.equals !== undefined) parts.push(`equals=${JSON.stringify(condition.equals)}`);
  if (condition.not) parts.push("not");
  return parts.join(" ");
}

/** Compact loop summary for a gate, or "" when it is not a loop. The `phase:`
 * prefix distinguishes the loop target (a phase id) from the step-id references
 * used elsewhere in the row meta (`deps:`, `forEach:`), so a reader can tell at
 * a glance what `↺` refers to. */
export function formatGateLoop(step: WorkflowStep): string {
  if (step.kind !== "gate" || step.loopTo === undefined) return "";
  const max = step.maxIterations !== undefined ? ` · max ${step.maxIterations}` : "";
  return `↺ phase:${step.loopTo}${max}`;
}

export function specStepRowMeta(
  step: WorkflowStep,
  ctx: PreviewRenderContext = {},
  resolve?: ResolveWorkflow,
): string {
  const bits: string[] = [];
  if (step.dependsOn?.length) bits.push(`deps: ${step.dependsOn.join(", ")}`);
  if ("forEach" in step && step.forEach) bits.push(`forEach: ${step.forEach}`);
  if ("workspace" in step && step.workspace) bits.push(`workspace: ${step.workspace}`);
  if ("cwd" in step && step.cwd) bits.push(`cwd: ${basename(step.cwd)}`);
  if (step.kind === "distributor" && step.items?.length) bits.push(`${step.items.length} items`);
  if (step.kind === "command") bits.push(`$ ${truncate(previewRender(step.cmd, ctx), 60)}`);
  if (step.kind === "llm") bits.push(`api: ${formatLlmTarget(step, ctx)}`);
  if (step.kind === "gate") bits.push(formatGateCondition(step.condition));
  if (step.kind === "gate" && step.loopTo) bits.push(formatGateLoop(step));
  if (step.kind === "merge") {
    const mode = previewRenderOptional(step.mode, ctx) ?? step.mode ?? "apply";
    bits.push(`mode: ${mode}`);
    if (step.from?.length) bits.push(`from: ${step.from.join(", ")}`);
    if (step.onConflict && step.onConflict !== "fail") bits.push(`onConflict: ${step.onConflict}`);
  }
  if (step.kind === "workflow") {
    // With a resolver, show the run-time rollup (models that actually run,
    // step count, override marker) rather than just the bare name — this is
    // the at-a-glance insight the sub-workflow row was missing.
    bits.push(resolve ? subWorkflowRollup(describeSubWorkflow(step, resolve)) : step.workflow);
    if (step.outputStep) bits.push(`out: ${step.outputStep}`);
    if (step.worktreeStep) bits.push(`worktree: ${step.worktreeStep}`);
  }
  if (step.kind === "issues") {
    const mode = previewRenderOptional(step.mode, ctx) ?? step.mode ?? "report";
    bits.push(`mode: ${mode}`);
    if (step.from?.length) bits.push(`from: ${step.from.join(", ")}`);
  }
  return bits.join(" · ");
}

export function specDetailLines(
  step: WorkflowStep,
  ctx: PreviewRenderContext = {},
  resolve?: ResolveWorkflow,
): string[] {
  const lines: string[] = [];
  if (step.dependsOn?.length) lines.push(`dependsOn: ${step.dependsOn.join(", ")}`);
  if ("forEach" in step && step.forEach) lines.push(`forEach: ${step.forEach}`);
  if ("workspace" in step && step.workspace) lines.push(`workspace: ${step.workspace}`);
  if ("artifacts" in step && step.artifacts?.length) {
    lines.push(`artifacts: ${step.artifacts.join(", ")}`);
  }
  if ("cwd" in step && step.cwd) lines.push(`cwd: ${step.cwd}`);
  if ("env" in step && step.env && Object.keys(step.env).length > 0) {
    lines.push(
      `env: ${Object.entries(step.env)
        .map(([k, v]) => `${k}=${previewRender(String(v), ctx)}`)
        .join(", ")}`,
    );
  }
  if ("extraArgs" in step && step.extraArgs?.length) {
    lines.push(`extraArgs: ${step.extraArgs.map((arg) => previewRender(arg, ctx)).join(" ")}`);
  }
  if ("effort" in step && step.effort) {
    const effort = previewRenderOptional(step.effort, ctx);
    if (effort) lines.push(`effort: ${effort}`);
  }
  if (step.kind === "distributor") {
    if (step.separator) lines.push(`separator: ${JSON.stringify(step.separator)}`);
    if (step.items?.length) {
      lines.push(`items (${step.items.length}):`);
      for (const [i, item] of step.items.entries()) {
        lines.push(`  [${i}] ${truncate(previewRender(item, ctx), 120)}`);
      }
    }
  }
  if (step.kind === "consolidator" && step.separator) {
    lines.push(`separator: ${JSON.stringify(step.separator)}`);
  }
  if (step.kind === "merge") {
    const mode = previewRenderOptional(step.mode, ctx) ?? step.mode ?? "apply";
    lines.push(`mode: ${mode}`);
    if (step.from?.length) lines.push(`from: ${step.from.join(", ")}`);
    lines.push(`onConflict: ${step.onConflict ?? "fail"}`);
    if (step.branch) lines.push(`branch: ${previewRender(step.branch, ctx)}`);
    if (step.perSource) lines.push("perSource: true (one branch/PR per source worktree)");
    if (step.cleanup) lines.push("cleanup: true (prune source worktrees after delivery)");
    if (step.prTitle) lines.push(`prTitle: ${truncate(previewRender(step.prTitle, ctx), 120)}`);
  }
  if (step.kind === "command") {
    lines.push(`cmd: ${truncate(previewRender(step.cmd, ctx), 200)}`);
  }
  if (step.kind === "llm") {
    lines.push(`api: ${formatLlmTarget(step, ctx)} (direct inference, no agent CLI)`);
    if (step.system) lines.push(`system: ${truncate(previewRender(step.system, ctx), 200)}`);
    if (step.maxTokens !== undefined) lines.push(`maxTokens: ${step.maxTokens}`);
    if (step.temperature !== undefined) lines.push(`temperature: ${step.temperature}`);
    if (step.apiKeyEnv) lines.push(`apiKeyEnv: ${step.apiKeyEnv}`);
    if (step.baseUrl) lines.push(`baseUrl: ${step.baseUrl}`);
    if (step.itemsPath) lines.push(`itemsPath: ${step.itemsPath}`);
  }
  if (step.kind === "gate") {
    lines.push(`condition: ${formatGateCondition(step.condition)}`);
    if (step.target) lines.push(`target: ${step.target}`);
    if (step.onFalse) lines.push(`onFalse: ${step.onFalse}`);
    if (step.loopTo) {
      const max =
        step.maxIterations !== undefined
          ? ` (max ${step.maxIterations})`
          : " (max: config default)";
      lines.push(`loops back to ${step.loopTo}${max}`);
    }
  }
  if (step.kind === "workflow") {
    lines.push(`workflow: ${step.workflow}`);
    if (step.input) lines.push(`input: ${truncate(previewRender(step.input, ctx), 200)}`);
    if (step.outputStep) lines.push(`outputStep: ${step.outputStep}`);
    if (step.worktreeStep) lines.push(`worktreeStep: ${step.worktreeStep}`);
    if (step.params && Object.keys(step.params).length > 0) {
      lines.push(
        `params: ${Object.entries(step.params)
          .map(([k, v]) => `${k}=${truncate(previewRender(v, ctx), 60)}`)
          .join(", ")}`,
      );
    }
    // The heart of the sub-workflow insight fix: when the child workflow can be
    // resolved, unfold what actually runs inside it — its steps, the models
    // that will run each one (overrides applied), and the autonomy it drags in.
    if (resolve) lines.push(...subWorkflowDetailLines(describeSubWorkflow(step, resolve), ctx));
  }
  if (step.kind === "issues") {
    const mode = previewRenderOptional(step.mode, ctx) ?? step.mode ?? "report";
    lines.push(`mode: ${mode}`);
    if (step.from?.length) lines.push(`from: ${step.from.join(", ")}`);
    lines.push(`findingsPath: ${step.findingsPath ?? "findings"}`);
    if (step.titlePrefix) lines.push(`titlePrefix: ${step.titlePrefix}`);
    if (step.labels?.length) lines.push(`labels: ${step.labels.join(", ")}`);
    if (step.repo) lines.push(`repo: ${step.repo}`);
    lines.push(`limit: ${step.limit ?? 20}`);
  }
  return lines;
}

/**
 * Detail-panel breakdown of a resolved sub-workflow: a header rollup line, then
 * one indented line per child step showing its kind, effective run target
 * (model that will actually run), and an override marker (`*`). Nested
 * sub-workflows indent further. Returns `[]` when the child couldn't be
 * resolved (the row rollup already says so).
 */
export function subWorkflowDetailLines(
  view: SubWorkflowView,
  _ctx: PreviewRenderContext = {},
): string[] {
  if (!view.resolved) {
    return view.cyclic
      ? ["contains: (cyclic reference — see its own listing)"]
      : ["contains: (workflow not resolvable here — see its own listing)"];
  }
  const lines: string[] = [];
  const rollup = [
    `contains ${view.stepCount} step${view.stepCount === 1 ? "" : "s"}`,
    `${view.phaseCount} phase${view.phaseCount === 1 ? "" : "s"}`,
  ];
  if (view.agents.length > 0) rollup.push(`agents: ${view.agents.join(", ")}`);
  rollup.push(`autonomy: ${view.autonomy}`);
  if (view.overrideCount > 0) {
    rollup.push(`${view.overrideCount} override${view.overrideCount === 1 ? "" : "s"} *`);
  }
  lines.push(rollup.join(" · "));
  for (const s of view.steps) {
    const indent = "  ".repeat(s.depth);
    const target = s.agentBacked
      ? (formatSubWorkflowTarget(s) ?? "auto")
      : s.kind === "workflow"
        ? `→ ${s.workflow}`
        : BLOCK_LABEL[s.kind];
    const mark = s.overridden ? " *" : "";
    lines.push(`${indent}${BLOCK_LABEL[s.kind]} ${s.id}  ${target}${mark}`);
  }
  return lines;
}

export function promptForStep(
  step: WorkflowStep,
  ctx: PreviewRenderContext = {},
): string | undefined {
  if ("prompt" in step && typeof step.prompt === "string" && step.prompt.length > 0) {
    return previewRender(step.prompt, ctx);
  }
  return undefined;
}

function staticModelName(agent: AgentInstanceId, model: string): string | undefined {
  switch (agent) {
    case "claude":
      return CLAUDE_MODELS.find((entry) => entry.id === model)?.name;
    case "codex":
      return CODEX_MODELS.find((entry) => entry.id === model)?.name;
    case "opencode":
      return OPENCODE_MODELS.find((entry) => entry.id === model)?.name;
    case "amp":
      return AMP_MODELS.find((entry) => entry.id === model)?.name;
    case "kiro":
      return KIRO_MODELS.find((entry) => entry.id === model)?.name;
    case "mimo":
      return MIMO_MODELS.find((entry) => entry.id === model)?.name;
    case "kimi":
      return KIMI_MODELS.find((entry) => entry.id === model)?.name;
    case "cursor":
      return CURSOR_MODELS.find((entry) => entry.id === model)?.name;
    case "antigravity":
      return ANTIGRAVITY_MODELS.find((entry) => entry.id === model)?.name;
  }
}
