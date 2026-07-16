import type { WorkflowSpec, WorkflowStep } from "./types";

/**
 * Workflow autonomy classification. Workflows with and without a human in the
 * loop are inherently different products: one can run unattended (CI, cron,
 * `--detach` and walk away), the other parks until a person shows up. Every
 * surface that lists or previews workflows shows this label so users know the
 * autonomy potential of a workflow BEFORE launching it.
 *
 * Three levels, ordered by how much attention a run demands:
 *
 *  - `"autonomous"`   — no human involvement declared anywhere; runs unattended.
 *  - `"approvals"`    — contains approval checkpoints (`approval` steps or
 *                       gates with `condition.human`): a human must consent at
 *                       fixed points, but never types anything.
 *  - `"interactive"`  — contains `human` steps or `canAsk` agent steps: the
 *                       run needs human *input* (answers, choices, data) to
 *                       finish. Strictly more demanding than approvals.
 *
 * Sub-workflow (`kind: "workflow"`) steps are resolved through `resolve` when
 * provided, so a checkpoint nested three workflows deep still surfaces on the
 * parent's label; unresolvable children contribute nothing (the child's own
 * listing carries its own label).
 */
export type WorkflowAutonomy = "autonomous" | "approvals" | "interactive";

/** Rank for combining: the most demanding level wins. */
const AUTONOMY_RANK: Record<WorkflowAutonomy, number> = {
  autonomous: 0,
  approvals: 1,
  interactive: 2,
};

function maxAutonomy(a: WorkflowAutonomy, b: WorkflowAutonomy): WorkflowAutonomy {
  return AUTONOMY_RANK[b] > AUTONOMY_RANK[a] ? b : a;
}

function stepAutonomy(step: WorkflowStep): WorkflowAutonomy {
  if (step.kind === "human") return "interactive";
  if (
    (step.kind === "worker" || step.kind === "processor" || !step.kind) &&
    "canAsk" in step &&
    step.canAsk === true
  ) {
    return "interactive";
  }
  if (step.kind === "approval") return "approvals";
  if (step.kind === "gate" && step.condition.human === true) return "approvals";
  return "autonomous";
}

/**
 * Classify a workflow's autonomy from its spec (recursing into resolvable
 * sub-workflows; `seen` guards cyclic references).
 */
export function workflowAutonomy(
  spec: WorkflowSpec,
  resolve?: (name: string) => WorkflowSpec | undefined,
  seen: Set<string> = new Set(),
): WorkflowAutonomy {
  let level: WorkflowAutonomy = "autonomous";
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      level = maxAutonomy(level, stepAutonomy(step));
      if (level === "interactive") return level; // already maximal
      if (step.kind === "workflow" && resolve && !seen.has(step.workflow)) {
        seen.add(step.workflow);
        const child = resolve(step.workflow);
        if (child) level = maxAutonomy(level, workflowAutonomy(child, resolve, seen));
        if (level === "interactive") return level;
      }
    }
  }
  return level;
}

/** Long-form label for detail views and help text. */
export function autonomyLabel(autonomy: WorkflowAutonomy): string {
  switch (autonomy) {
    case "autonomous":
      return "fully autonomous";
    case "approvals":
      return "needs approvals";
    case "interactive":
      return "needs human input";
  }
}

/**
 * Compact badge for list rows and cards. Icons are deliberately distinct from
 * status glyphs used elsewhere (⏳ pending, ✓ done): ▸ runs by itself, ✋ will
 * stop for consent, ✎ will ask for input.
 */
export function autonomyBadge(autonomy: WorkflowAutonomy): string {
  switch (autonomy) {
    case "autonomous":
      return "▸ autonomous";
    case "approvals":
      return "✋ approvals";
    case "interactive":
      return "✎ interactive";
  }
}

/**
 * One-line explanation of what the label means for a run, shown next to the
 * badge in detail/preview surfaces so the label teaches itself.
 */
export function autonomyDescription(autonomy: WorkflowAutonomy): string {
  switch (autonomy) {
    case "autonomous":
      return "runs unattended end-to-end — no human involvement declared";
    case "approvals":
      return "pauses at approval checkpoints — a human must approve or reject to continue";
    case "interactive":
      return "asks a human for input mid-run — answers or choices are required to finish";
  }
}
