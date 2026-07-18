import { defaultModelForAgent, modelNameForAgent, resolveAgentInstances } from "../agents";
import type { SteamtrainConfig } from "../config";
import type { AgentInstanceId } from "../types/events";
import type { WorkflowStepOverrides } from "./overrides";
import type { WorkflowSpec } from "./types";
import { isAgentBackedStep } from "./types";

/**
 * A per-run plan that re-routes agent-backed steps whose pinned agent is not
 * ready (not installed, unauthenticated, disabled) to an agent that is.
 *
 * Scope rules, deliberately narrow:
 * - Only steps whose own agent is blocked are re-routed. Steps already pinned
 *   to a ready agent keep their agent and model, so a mixed-agent workflow
 *   keeps as much of its cross-model diversity as possible.
 * - `llm` steps are never touched — they call an API directly and need no
 *   agent CLI, so a missing agent binary cannot block them.
 * - The plan is meant to be applied per run (session overrides / spec
 *   overrides), never persisted into the workflow definition.
 */
export interface ReroutePlan {
  /** Ready agent every blocked step is re-routed to. */
  target: AgentInstanceId;
  /** The target agent's default model (each re-routed step runs on it). */
  targetModel: string;
  /** Display name for {@link targetModel}. */
  targetModelName: string;
  /** Distinct agents that were pinned but are not ready, in spec order. */
  blockedAgents: AgentInstanceId[];
  /** Ids of the steps being re-routed, in spec order. */
  stepIds: string[];
  /** Per-step overrides implementing the re-route (agent + default model, effort reset). */
  overrides: WorkflowStepOverrides;
}

export interface PlanRerouteOptions {
  /**
   * Re-route blocked steps to this agent instead of the automatic pick. The
   * agent must be enabled and ready or planning fails (returns an error).
   */
  target?: AgentInstanceId;
}

export type PlanRerouteResult =
  | { ok: true; plan: ReroutePlan }
  | { ok: false; error: string }
  /** Nothing to do: no agent-backed step is blocked. */
  | { ok: false; error?: undefined };

/**
 * Plan a re-route of blocked agent steps onto a ready agent. Returns
 * `{ ok: false }` (no error) when the spec has no blocked agent steps, an
 * error when steps are blocked but no ready agent exists (or the requested
 * target is not ready), and a {@link ReroutePlan} otherwise.
 *
 * Target selection is deterministic: an explicitly requested target wins,
 * else a ready agent the spec already uses (preserving intent), else the
 * first ready agent in config order.
 */
export function planAgentReroute(
  spec: WorkflowSpec,
  config: SteamtrainConfig,
  isReady: (agent: AgentInstanceId) => boolean,
  options: PlanRerouteOptions = {},
): PlanRerouteResult {
  const enabledIds = resolveAgentInstances(config).map((agent) => agent.id);
  const enabled = new Set<string>(enabledIds);
  // A step's agent is usable when it is configured/enabled AND doctor-ready —
  // exactly the conditions canDispatchWorkflowSpec gates on.
  const agentUsable = (agent: AgentInstanceId) => enabled.has(agent) && isReady(agent);

  const blockedStepIds: string[] = [];
  const blockedAgents: AgentInstanceId[] = [];
  const usedReadyAgents: AgentInstanceId[] = [];
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      if (!isAgentBackedStep(step)) continue;
      if (!agentUsable(step.agent)) {
        blockedStepIds.push(step.id);
        if (!blockedAgents.includes(step.agent)) blockedAgents.push(step.agent);
      } else if (!usedReadyAgents.includes(step.agent)) {
        usedReadyAgents.push(step.agent);
      }
    }
  }
  if (blockedStepIds.length === 0) return { ok: false };

  const readyAgents = enabledIds.filter((agent) => isReady(agent));
  let target: AgentInstanceId;
  if (options.target !== undefined) {
    if (!enabled.has(options.target)) {
      return { ok: false, error: `agent '${options.target}' is disabled or not configured` };
    }
    if (!isReady(options.target)) {
      return { ok: false, error: `agent '${options.target}' is not ready (doctor check failed)` };
    }
    target = options.target;
  } else {
    const pick = usedReadyAgents[0] ?? readyAgents[0];
    if (!pick) {
      return {
        ok: false,
        error: `no ready agent to re-route to (blocked: ${blockedAgents.join(", ")})`,
      };
    }
    target = pick;
  }

  const targetModel = defaultModelForAgent(target, config);
  const overrides: WorkflowStepOverrides = {};
  for (const stepId of blockedStepIds) {
    // effort is explicitly cleared — levels are model-specific and must not
    // leak across a model change (same rule as the `/agent` step command).
    overrides[stepId] = { agent: target, model: targetModel, effort: undefined };
  }

  return {
    ok: true,
    plan: {
      target,
      targetModel,
      targetModelName: modelNameForAgent(target, targetModel, config),
      blockedAgents,
      stepIds: blockedStepIds,
      overrides,
    },
  };
}

/** One-line human description of a plan, e.g. "re-route 3 steps (opencode) to claude · Claude Sonnet 5". */
export function formatReroutePlan(plan: ReroutePlan): string {
  const steps = plan.stepIds.length === 1 ? "1 step" : `${plan.stepIds.length} steps`;
  return `re-route ${steps} (${plan.blockedAgents.join(", ")}) to ${plan.target} · ${plan.targetModelName}`;
}
