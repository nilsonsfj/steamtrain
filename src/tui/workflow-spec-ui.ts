import { basename } from "node:path";
import {
  AMP_MODELS,
  CLAUDE_MODELS,
  CODEX_MODELS,
  OPENCODE_MODELS,
  formatAgentTarget,
} from "../agents";
import { truncate } from "../agents/util";
import type { AgentId } from "../types/events";
import {
  type GateCondition,
  type WorkflowPhase,
  type WorkflowSpec,
  type WorkflowStep,
  isAgentBackedStep,
  workflowStepKind,
} from "../workflow";

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
      if (isAgentBackedStep(step)) set.add(step.agent);
    }
  }
  return [...set];
}

export function formatWorkflowAgentTarget(target: {
  agent: AgentId;
  model: string;
  effort?: string;
}): string {
  const formatted = formatAgentTarget(target);
  const staticName = staticModelName(target.agent, target.model);
  return staticName && !formatted.includes(staticName) ? `${formatted} · ${staticName}` : formatted;
}

export function formatGateCondition(condition: GateCondition): string {
  const parts: string[] = [];
  if (condition.step) parts.push(`step=${condition.step}`);
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

export function specStepRowMeta(step: WorkflowStep): string {
  const bits: string[] = [];
  if (step.dependsOn?.length) bits.push(`deps: ${step.dependsOn.join(", ")}`);
  if ("forEach" in step && step.forEach) bits.push(`forEach: ${step.forEach}`);
  if ("cwd" in step && step.cwd) bits.push(`cwd: ${basename(step.cwd)}`);
  if (step.kind === "distributor" && step.items?.length) bits.push(`${step.items.length} items`);
  if (step.kind === "gate") bits.push(formatGateCondition(step.condition));
  if (step.kind === "gate" && step.loopTo) bits.push(formatGateLoop(step));
  return bits.join(" · ");
}

export function specDetailLines(step: WorkflowStep): string[] {
  const lines: string[] = [];
  if (step.dependsOn?.length) lines.push(`dependsOn: ${step.dependsOn.join(", ")}`);
  if ("forEach" in step && step.forEach) lines.push(`forEach: ${step.forEach}`);
  if ("cwd" in step && step.cwd) lines.push(`cwd: ${step.cwd}`);
  if ("env" in step && step.env && Object.keys(step.env).length > 0) {
    lines.push(
      `env: ${Object.entries(step.env)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}`,
    );
  }
  if ("extraArgs" in step && step.extraArgs?.length) {
    lines.push(`extraArgs: ${step.extraArgs.join(" ")}`);
  }
  if ("effort" in step && step.effort) {
    lines.push(`effort: ${step.effort}`);
  }
  if (step.kind === "distributor") {
    if (step.separator) lines.push(`separator: ${JSON.stringify(step.separator)}`);
    if (step.items?.length) {
      lines.push(`items (${step.items.length}):`);
      for (const [i, item] of step.items.entries()) {
        lines.push(`  [${i}] ${truncate(item, 120)}`);
      }
    }
  }
  if (step.kind === "consolidator" && step.separator) {
    lines.push(`separator: ${JSON.stringify(step.separator)}`);
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
  return lines;
}

export function promptForStep(step: WorkflowStep): string | undefined {
  if ("prompt" in step && typeof step.prompt === "string" && step.prompt.length > 0) {
    return step.prompt;
  }
  return undefined;
}

function staticModelName(agent: AgentId, model: string): string | undefined {
  switch (agent) {
    case "claude":
      return CLAUDE_MODELS.find((entry) => entry.id === model)?.name;
    case "codex":
      return CODEX_MODELS.find((entry) => entry.id === model)?.name;
    case "opencode":
      return OPENCODE_MODELS.find((entry) => entry.id === model)?.name;
    case "amp":
      return AMP_MODELS.find((entry) => entry.id === model)?.name;
  }
}
