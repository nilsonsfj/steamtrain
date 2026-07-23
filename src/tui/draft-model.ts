import {
  defaultDraftModel,
  effortsForModel,
  findModelFamily,
  modelIdsForAgent,
  modelNameForAgent,
  resolveAgentInstances,
  resolveModelBinding,
  supportsEffort,
} from "../agents";
import type { SteamtrainConfig } from "../config/types";
import type { DoctorResult } from "../doctor";
import type { AgentInstanceId, AgentProviderId } from "../types/events";

/** Agent + model (+ optional effort) used to draft (LLM-author) a new workflow. */
export interface DraftTarget {
  agent: AgentInstanceId;
  model: string;
  effort?: string;
}

/**
 * Preference order for auto-picking a drafting agent: OpenCode first (free
 * models, no paid credentials), then Claude, then Codex. Shared by the auto
 * resolver and the single-token model lookup so both agree on precedence.
 */
const DRAFT_AGENT_ORDER: readonly AgentProviderId[] = [
  "opencode",
  "claude",
  "codex",
  "amp",
  "kiro",
  "mimo",
  "kimi",
  "cursor",
  "antigravity",
];

const draftOrderCache = new WeakMap<SteamtrainConfig, AgentInstanceId[]>();

function draftAgentOrder(config?: SteamtrainConfig): AgentInstanceId[] {
  if (config) {
    const cached = draftOrderCache.get(config);
    if (cached) return cached;
  }
  const instances = resolveAgentInstances(config);
  const order = [...instances]
    .sort((a, b) => {
      const ap = DRAFT_AGENT_ORDER.indexOf(a.provider);
      const bp = DRAFT_AGENT_ORDER.indexOf(b.provider);
      return (ap === -1 ? 99 : ap) - (bp === -1 ? 99 : bp);
    })
    .map((agent) => agent.id);
  if (config) draftOrderCache.set(config, order);
  return order;
}

/** The set of agents the doctor reports as healthy (runnable). */
export function healthyAgentSet(doctor: DoctorResult[] | null): Set<AgentInstanceId> {
  const set = new Set<AgentInstanceId>();
  if (!doctor) return set;
  for (const d of doctor) if (d.status === "ok") set.add(d.agent);
  return set;
}

/**
 * Auto-pick a drafting target among healthy agents, preferring OpenCode's free
 * model. Returns undefined when no agent is healthy (generation spawns a real
 * CLI, so an unhealthy agent can't draft).
 */
export function autoDraftTarget(
  healthy: ReadonlySet<AgentInstanceId>,
  config?: SteamtrainConfig,
): DraftTarget | undefined {
  for (const agent of draftAgentOrder(config)) {
    if (healthy.has(agent)) return { agent, model: defaultDraftModel(agent, config) };
  }
  return undefined;
}

/**
 * Resolve the effective drafting target: use the user's override when its agent
 * is healthy and its model is still valid for that agent; otherwise fall back to
 * the auto pick. `usingOverride` reports which one won, for display.
 */
export function resolveDraftTarget(
  healthy: ReadonlySet<AgentInstanceId>,
  override: DraftTarget | null,
  config?: SteamtrainConfig,
): { target?: DraftTarget; usingOverride: boolean } {
  if (
    override &&
    healthy.has(override.agent) &&
    modelIdsForAgent(override.agent, config).includes(override.model)
  ) {
    return { target: override, usingOverride: true };
  }
  return { target: autoDraftTarget(healthy, config), usingOverride: false };
}

/** `agent · model-name` (falls back to the raw id when no friendly name), plus effort if set. */
export function formatDraftTarget(target: DraftTarget, config?: SteamtrainConfig): string {
  const name = modelNameForAgent(target.agent, target.model, config);
  const base =
    name === target.model ? `${target.agent} · ${target.model}` : `${target.agent} · ${name}`;
  return target.effort ? `${base} · effort ${target.effort}` : base;
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
  healthy: ReadonlySet<AgentInstanceId>,
  config?: SteamtrainConfig,
): DraftModelRequest {
  if (args.length === 0) return { kind: "show" };

  const first = args[0]!;
  const lowered = first.toLowerCase();
  if (lowered === "auto" || lowered === "reset" || lowered === "default") {
    return { kind: "reset" };
  }

  // `<agent>` or `<agent> <model>`
  if (draftAgentOrder(config).includes(first)) {
    if (!healthy.has(first)) return unhealthyAgentError(first, healthy);
    if (args.length === 1)
      return { kind: "set", target: { agent: first, model: defaultDraftModel(first, config) } };
    const model = args[1]!;
    const ids = modelIdsForAgent(first, config);
    if (!ids.includes(model)) {
      return {
        kind: "error",
        message: `unknown model '${model}' for ${first}; try: ${ids.join(", ")}`,
      };
    }
    return { kind: "set", target: { agent: first, model } };
  }

  // `<model-id>` — resolve via the shared model-binding registry (family
  // aliases, reference-agent preference, catalog matches).
  {
    const resolved = resolveModelBinding(
      { model: first },
      {
        config,
        isReady: (agent) => healthy.has(agent),
      },
    );
    if (resolved.ok) {
      return {
        kind: "set",
        target: { agent: resolved.primary.agent, model: resolved.primary.model },
      };
    }
  }

  // Not runnable on any healthy agent — prefer naming the would-be owner.
  const owner = draftAgentOrder(config).find((agent) =>
    modelIdsForAgent(agent, config).includes(first),
  );
  if (owner) {
    return {
      kind: "error",
      message: `model '${first}' belongs to ${owner}, which isn't healthy (check the doctor panel)`,
    };
  }
  const family = findModelFamily(first);
  if (family) {
    const providers = family.offerings.map((o) => o.provider).join(", ");
    return {
      kind: "error",
      message: `no healthy agent can provide '${first}' (offered by: ${providers}); ${healthyHint(healthy)}`,
    };
  }
  return {
    kind: "error",
    message: `unknown model '${first}'; ${healthyHint(healthy)}`,
  };
}

function unhealthyAgentError(
  agent: AgentInstanceId,
  healthy: ReadonlySet<AgentInstanceId>,
): DraftModelRequest {
  return {
    kind: "error",
    message: `${agent} isn't healthy (check the doctor panel); ${healthyHint(healthy)}`,
  };
}

function healthyHint(healthy: ReadonlySet<AgentInstanceId>): string {
  const agents = [...healthy];
  if (agents.length === 0) return "no agents are healthy";
  return `healthy: ${agents.join(", ")}`;
}

/** Completion candidates for `/model` in the workflow picker. */
export function draftModelCompletions(
  healthy: ReadonlySet<AgentInstanceId>,
  config?: SteamtrainConfig,
): string[] {
  const out = ["auto"];
  for (const agent of draftAgentOrder(config)) {
    if (!healthy.has(agent)) continue;
    out.push(agent);
    out.push(...modelIdsForAgent(agent, config));
  }
  return out;
}

export type DraftEffortRequest =
  | { kind: "show"; current: string; efforts: readonly string[] }
  | { kind: "clear" }
  | { kind: "set"; effort: string }
  | { kind: "error"; message: string };

/**
 * Parse `/effort` args (in the workflow picker) into a draft-effort action:
 *
 * - no args → show the current effort
 * - `clear` / `default` → clear the effort override
 * - `<level>` → set the effort level (validated against the current target)
 */
export function parseDraftEffortRequest(
  args: string[],
  current: DraftTarget | undefined,
  config?: SteamtrainConfig,
): DraftEffortRequest {
  if (!current) {
    return { kind: "error", message: "no draft target set (use /model first)" };
  }

  if (args.length === 0) {
    const currentEffort = current.effort ?? "default";
    if (!supportsEffort(current.agent, current.model, config)) {
      return {
        kind: "error",
        message: `${current.model} does not support effort levels (current: ${currentEffort})`,
      };
    }
    const efforts = effortsForModel(current.agent, current.model, config);
    return { kind: "show", current: currentEffort, efforts };
  }

  const next = args[0]!;
  const lowered = next.toLowerCase();
  if (lowered === "clear" || lowered === "default") {
    return { kind: "clear" };
  }

  if (!supportsEffort(current.agent, current.model, config)) {
    return {
      kind: "error",
      message: `${current.model} does not support effort levels`,
    };
  }

  const efforts = effortsForModel(current.agent, current.model, config);
  if (!efforts.includes(next)) {
    return {
      kind: "error",
      message: `unknown effort '${next}' for ${current.model}; try: ${efforts.join(", ")} or clear`,
    };
  }

  return { kind: "set", effort: next };
}

/** Completion candidates for `/effort` in the workflow picker. */
export function draftEffortCompletions(
  current: DraftTarget | undefined,
  config?: SteamtrainConfig,
): string[] {
  if (!current || !supportsEffort(current.agent, current.model, config)) return ["clear"];
  const efforts = effortsForModel(current.agent, current.model, config);
  return efforts.length > 0 ? [...efforts, "clear"] : ["clear"];
}
