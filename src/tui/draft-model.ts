import { defaultDraftModel, isAgentId, modelIdsForAgent, modelNameForAgent } from "../agents";
import type { DoctorResult } from "../doctor";
import type { AgentId } from "../types/events";

/** Agent + model used to draft (LLM-author) a new workflow. */
export interface DraftTarget {
  agent: AgentId;
  model: string;
}

/**
 * Preference order for auto-picking a drafting agent: OpenCode first (free
 * models, no paid credentials), then Claude, then Codex. Shared by the auto
 * resolver and the single-token model lookup so both agree on precedence.
 */
const DRAFT_AGENT_ORDER: readonly AgentId[] = ["opencode", "claude", "codex"];

/** The set of agents the doctor reports as healthy (runnable). */
export function healthyAgentSet(doctor: DoctorResult[] | null): Set<AgentId> {
  const set = new Set<AgentId>();
  if (!doctor) return set;
  for (const d of doctor) if (d.status === "ok") set.add(d.agent);
  return set;
}

/**
 * Auto-pick a drafting target among healthy agents, preferring OpenCode's free
 * model. Returns undefined when no agent is healthy (generation spawns a real
 * CLI, so an unhealthy agent can't draft).
 */
export function autoDraftTarget(healthy: ReadonlySet<AgentId>): DraftTarget | undefined {
  for (const agent of DRAFT_AGENT_ORDER) {
    if (healthy.has(agent)) return { agent, model: defaultDraftModel(agent) };
  }
  return undefined;
}

/**
 * Resolve the effective drafting target: use the user's override when its agent
 * is healthy and its model is still valid for that agent; otherwise fall back to
 * the auto pick. `usingOverride` reports which one won, for display.
 */
export function resolveDraftTarget(
  healthy: ReadonlySet<AgentId>,
  override: DraftTarget | null,
): { target?: DraftTarget; usingOverride: boolean } {
  if (
    override &&
    healthy.has(override.agent) &&
    modelIdsForAgent(override.agent).includes(override.model)
  ) {
    return { target: override, usingOverride: true };
  }
  return { target: autoDraftTarget(healthy), usingOverride: false };
}

/** `agent · model-name` (falls back to the raw id when no friendly name). */
export function formatDraftTarget(target: DraftTarget): string {
  const name = modelNameForAgent(target.agent, target.model);
  return name === target.model ? `${target.agent} · ${target.model}` : `${target.agent} · ${name}`;
}

export type DraftModelRequest =
  | { kind: "show" }
  | { kind: "reset" }
  | { kind: "set"; target: DraftTarget }
  | { kind: "error"; message: string };

/**
 * Parse `/model` args (in the workflow picker) into a draft-model action:
 *
 * - no args → show the current target
 * - `auto` / `reset` / `default` → clear the override
 * - `<agent>` → that agent's default draft model
 * - `<agent> <model>` → an explicit pair
 * - `<model-id>` → infer the owning agent (preference order) among healthy ones
 *
 * Validation is health-aware: a target is only accepted when its agent is
 * healthy, so a draft can't be pinned to an agent that cannot run.
 */
export function parseDraftModelRequest(
  args: string[],
  healthy: ReadonlySet<AgentId>,
): DraftModelRequest {
  if (args.length === 0) return { kind: "show" };

  const first = args[0]!;
  const lowered = first.toLowerCase();
  if (lowered === "auto" || lowered === "reset" || lowered === "default") {
    return { kind: "reset" };
  }

  // `<agent>` or `<agent> <model>`
  if (isAgentId(first)) {
    if (!healthy.has(first)) return unhealthyAgentError(first, healthy);
    if (args.length === 1)
      return { kind: "set", target: { agent: first, model: defaultDraftModel(first) } };
    const model = args[1]!;
    const ids = modelIdsForAgent(first);
    if (!ids.includes(model)) {
      return {
        kind: "error",
        message: `unknown model '${model}' for ${first}; try: ${ids.join(", ")}`,
      };
    }
    return { kind: "set", target: { agent: first, model } };
  }

  // `<model-id>` — find the healthy agent that owns it (preference order).
  for (const agent of DRAFT_AGENT_ORDER) {
    if (healthy.has(agent) && modelIdsForAgent(agent).includes(first)) {
      return { kind: "set", target: { agent, model: first } };
    }
  }

  // Not owned by any healthy agent — give the most useful reason we can.
  const owner = DRAFT_AGENT_ORDER.find((agent) => modelIdsForAgent(agent).includes(first));
  if (owner) {
    return {
      kind: "error",
      message: `model '${first}' belongs to ${owner}, which isn't healthy (check the doctor panel)`,
    };
  }
  return {
    kind: "error",
    message: `unknown model '${first}'; ${healthyHint(healthy)}`,
  };
}

function unhealthyAgentError(agent: AgentId, healthy: ReadonlySet<AgentId>): DraftModelRequest {
  return {
    kind: "error",
    message: `${agent} isn't healthy (check the doctor panel); ${healthyHint(healthy)}`,
  };
}

function healthyHint(healthy: ReadonlySet<AgentId>): string {
  const agents = DRAFT_AGENT_ORDER.filter((a) => healthy.has(a));
  if (agents.length === 0) return "no agents are healthy";
  return `healthy: ${agents.join(", ")}`;
}

/** Completion candidates for `/model` in the workflow picker. */
export function draftModelCompletions(healthy: ReadonlySet<AgentId>): string[] {
  const out = ["auto"];
  for (const agent of DRAFT_AGENT_ORDER) {
    if (!healthy.has(agent)) continue;
    out.push(agent);
    out.push(...modelIdsForAgent(agent));
  }
  return out;
}
