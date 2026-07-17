/** Minimal step shape for agentless detection (avoids importing zod-backed types). */
interface SpecStep {
  kind?: string;
  agent?: string;
}

interface SpecPhase {
  steps: SpecStep[];
}

/** Minimal spec shape — compatible with WorkflowSpec without importing it. */
export interface AgentlessSpecView {
  phases: SpecPhase[];
}

/** The bundled agentless onboarding ride. */
export const TOUR_WORKFLOW_NAME = "tour";

/**
 * Walk a spec without importing the heavy zod-backed helpers in `types.ts`
 * (those pull the whole schema module into the browser reducer bundle).
 */
function stepNeedsAgentCli(step: SpecStep): boolean {
  if (step.kind === "worker" || step.kind === "processor") return true;
  if ((step.kind === "distributor" || step.kind === "consolidator") && step.agent) return true;
  return false;
}

/**
 * True when the workflow never spawns an agent CLI. Direct `llm` API steps may
 * still require a key - use {@link isCredentialFreeWorkflow} for the $0 tour case.
 */
export function isAgentlessWorkflow(spec: AgentlessSpecView): boolean {
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      if (stepNeedsAgentCli(step)) return false;
    }
  }
  return true;
}

/**
 * True when a workflow needs neither an agent CLI nor an LLM API key - the
 * pure command/distributor/gate/consolidator path that powers the tour.
 */
export function isCredentialFreeWorkflow(spec: AgentlessSpecView): boolean {
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      if (stepNeedsAgentCli(step) || step.kind === "llm") return false;
    }
  }
  return true;
}

/**
 * Prefer auto-selecting the tour on first open only when the user has never
 * run anything and has no remembered selection. Once history exists, leave
 * them where they left off.
 */
export function shouldOfferStationLanding(opts: {
  hasRunHistory: boolean;
  rememberedSelection?: string | null;
}): boolean {
  if (opts.hasRunHistory) return false;
  if (opts.rememberedSelection) return false;
  return true;
}

/** Index of the tour in a catalog listing, or -1 when absent. */
export function tourWorkflowIndex(entries: ReadonlyArray<{ name: string }>): number {
  return entries.findIndex((entry) => entry.name === TOUR_WORKFLOW_NAME);
}

/**
 * Initial picker index: tour on a Station landing, otherwise 0 (or the
 * remembered name when provided).
 */
export function initialWorkflowIndex(
  entries: ReadonlyArray<{ name: string }>,
  opts: { preferTour: boolean; rememberedName?: string | null } = { preferTour: false },
): number {
  if (entries.length === 0) return 0;
  if (opts.rememberedName) {
    const remembered = entries.findIndex((entry) => entry.name === opts.rememberedName);
    if (remembered >= 0) return remembered;
  }
  if (opts.preferTour) {
    const tour = tourWorkflowIndex(entries);
    if (tour >= 0) return tour;
  }
  return 0;
}
