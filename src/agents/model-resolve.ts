import type { SteamtrainConfig } from "../config/types";
import type { AgentInstanceId, AgentProviderId } from "../types/events";
import { resolveAgentInstance, resolveAgentInstances } from "./config";
import {
  MODEL_CLASS_IDS,
  type ModelClassId,
  candidateFamiliesForClass,
  isModelClassId,
  modelClassById,
} from "./model-classes";
import {
  AGENT_PREFERENCE_ORDER,
  type ModelFamily,
  type ModelOffering,
  familyForProviderModel,
  findDirectCatalogMatches,
  findModelFamily,
  modelFamilies,
  nativeModelForProvider,
  normalizeModelQuery,
  offeringModelMatchesQuery,
} from "./model-identity";
import { effortsForModel, modelIdsForAgent, modelNameForAgent } from "./models";

/** How a step asked to be bound before resolution. */
export type ModelBindingRequest = {
  agent?: AgentInstanceId;
  model?: string;
  modelClass?: string;
  /** Extra model queries to try if the primary binding cannot run. */
  fallbackModels?: string[];
  /** Explicit effort from the step; wins over class preferredEfforts. */
  effort?: string;
};

/** One concrete agent+model candidate, ready to spawn. */
export interface ResolvedModelCandidate {
  agent: AgentInstanceId;
  provider: AgentProviderId;
  model: string;
  /** Display name for the native model id. */
  modelName: string;
  /** Matched family id when known. */
  familyId?: string;
  familyName?: string;
  /** Matched model class when the request used one. */
  modelClass?: ModelClassId;
  /** Effort to apply (explicit step effort or class preferredEfforts). */
  effort?: string;
  /** True when this candidate uses the family's reference agent. */
  reference: boolean;
  /** Why this candidate is in the chain. */
  reason: "pinned" | "reference" | "preferred" | "fallback" | "catalog" | "class";
}

export type ResolveModelBindingResult =
  | {
      ok: true;
      /** Best candidate to run now. */
      primary: ResolvedModelCandidate;
      /** Ordered failover chain (primary first). */
      candidates: ResolvedModelCandidate[];
      /** Human summary suitable for notices / narration. */
      summary: string;
    }
  | { ok: false; error: string };

export interface ResolveModelBindingOptions {
  config?: SteamtrainConfig;
  /** Doctor/readiness gate. Defaults to "everything enabled is ready". */
  isReady?: (agent: AgentInstanceId) => boolean;
  /**
   * Prefer this agent instance when it can satisfy the request (session
   * continuity, sticky mid-run binding, explicit user preference).
   */
  preferAgent?: AgentInstanceId;
  /** Include disabled agents in the search (usually false). */
  includeDisabled?: boolean;
}

function agentProvider(
  agent: AgentInstanceId,
  config?: SteamtrainConfig,
): AgentProviderId | undefined {
  return resolveAgentInstance(config, agent, { includeDisabled: true })?.provider;
}

function enabledInstances(config?: SteamtrainConfig, includeDisabled = false) {
  return resolveAgentInstances(config, { includeDisabled });
}

function instancesForProvider(
  provider: AgentProviderId,
  config?: SteamtrainConfig,
  includeDisabled = false,
) {
  return enabledInstances(config, includeDisabled).filter((agent) => agent.provider === provider);
}

function sortAgentsByPreference(
  agents: Array<{ id: AgentInstanceId; provider: AgentProviderId }>,
  preferAgent?: AgentInstanceId,
): Array<{ id: AgentInstanceId; provider: AgentProviderId }> {
  return [...agents].sort((a, b) => {
    if (preferAgent) {
      if (a.id === preferAgent && b.id !== preferAgent) return -1;
      if (b.id === preferAgent && a.id !== preferAgent) return 1;
    }
    // Prefer built-in id matching provider (the "reference instance").
    const aRef = a.id === a.provider ? 0 : 1;
    const bRef = b.id === b.provider ? 0 : 1;
    if (aRef !== bRef) return aRef - bRef;
    const ap = AGENT_PREFERENCE_ORDER.indexOf(a.provider);
    const bp = AGENT_PREFERENCE_ORDER.indexOf(b.provider);
    if (ap !== bp) return (ap === -1 ? 99 : ap) - (bp === -1 ? 99 : bp);
    return a.id.localeCompare(b.id);
  });
}

function candidateKey(c: ResolvedModelCandidate): string {
  return `${c.agent}::${c.model}`;
}

function pushUnique(
  list: ResolvedModelCandidate[],
  seen: Set<string>,
  candidate: ResolvedModelCandidate | undefined,
): void {
  if (!candidate) return;
  const key = candidateKey(candidate);
  if (seen.has(key)) return;
  seen.add(key);
  list.push(candidate);
}

function makeCandidate(opts: {
  agent: AgentInstanceId;
  provider: AgentProviderId;
  model: string;
  config?: SteamtrainConfig;
  family?: ModelFamily;
  modelClass?: ModelClassId;
  effort?: string;
  reference: boolean;
  reason: ResolvedModelCandidate["reason"];
}): ResolvedModelCandidate {
  return {
    agent: opts.agent,
    provider: opts.provider,
    model: opts.model,
    modelName: modelNameForAgent(opts.agent, opts.model, opts.config),
    familyId: opts.family?.id,
    familyName: opts.family?.name,
    modelClass: opts.modelClass,
    effort: opts.effort,
    reference: opts.reference,
    reason: opts.reason,
  };
}

/**
 * Pick the best effort for a resolved binding: explicit step effort wins;
 * otherwise walk the class preferredEfforts ladder against supported levels.
 */
export function resolveEffortForBinding(opts: {
  agent: AgentInstanceId;
  model: string;
  modelClass?: ModelClassId;
  explicitEffort?: string;
  config?: SteamtrainConfig;
}): string | undefined {
  if (opts.explicitEffort) return opts.explicitEffort;
  if (!opts.modelClass) return undefined;
  const def = modelClassById(opts.modelClass, opts.config);
  const preferred = def?.preferredEfforts;
  if (!preferred || preferred.length === 0) return undefined;
  const supported = effortsForModel(opts.agent, opts.model, opts.config);
  for (const effort of preferred) {
    if (supported.includes(effort)) return effort;
  }
  return undefined;
}

function withResolvedEffort(
  candidate: ResolvedModelCandidate,
  request: ModelBindingRequest,
  config?: SteamtrainConfig,
): ResolvedModelCandidate {
  const effort = resolveEffortForBinding({
    agent: candidate.agent,
    model: candidate.model,
    modelClass: candidate.modelClass ?? (request.modelClass as ModelClassId | undefined),
    explicitEffort: request.effort,
    config,
  });
  if (!effort) return candidate;
  return { ...candidate, effort };
}

function offeringsToCandidates(
  offerings: readonly ModelOffering[],
  opts: {
    config?: SteamtrainConfig;
    isReady: (agent: AgentInstanceId) => boolean;
    preferAgent?: AgentInstanceId;
    includeDisabled?: boolean;
    family?: ModelFamily;
    modelClass?: ModelClassId;
    reason: ResolvedModelCandidate["reason"];
    /** When set, only consider this agent instance. */
    onlyAgent?: AgentInstanceId;
  },
): ResolvedModelCandidate[] {
  const out: ResolvedModelCandidate[] = [];
  const seen = new Set<string>();

  for (const offering of offerings) {
    const instances = opts.onlyAgent
      ? (() => {
          const inst = resolveAgentInstance(opts.config, opts.onlyAgent, {
            includeDisabled: opts.includeDisabled,
          });
          return inst && inst.provider === offering.provider ? [inst] : [];
        })()
      : instancesForProvider(offering.provider, opts.config, opts.includeDisabled);

    const sorted = sortAgentsByPreference(instances, opts.preferAgent);
    for (const inst of sorted) {
      if (!opts.isReady(inst.id)) continue;
      // Registry offerings are authoritative even when a live catalog refresh
      // has not listed the id yet.
      pushUnique(
        out,
        seen,
        makeCandidate({
          agent: inst.id,
          provider: inst.provider,
          model: offering.modelId,
          config: opts.config,
          family: opts.family,
          modelClass: opts.modelClass,
          reference: offering.reference && inst.id === offering.provider,
          reason: offering.reference ? "reference" : opts.reason,
        }),
      );
    }
  }
  return out;
}

function candidatesForModelQuery(
  modelQuery: string,
  opts: {
    config?: SteamtrainConfig;
    isReady: (agent: AgentInstanceId) => boolean;
    preferAgent?: AgentInstanceId;
    includeDisabled?: boolean;
    onlyAgent?: AgentInstanceId;
    modelClass?: ModelClassId;
    reason?: ResolvedModelCandidate["reason"];
  },
): ResolvedModelCandidate[] {
  const family = findModelFamily(modelQuery);
  if (family) {
    // Prefer offerings that literally match the query (e.g. keep
    // `gemini-3.6-flash-medium` instead of collapsing to the family reference).
    const exact: ModelOffering[] = [];
    const rest: ModelOffering[] = [];
    for (const offering of family.offerings) {
      if (offeringModelMatchesQuery(offering.modelId, modelQuery)) exact.push(offering);
      else rest.push(offering);
    }
    return offeringsToCandidates(exact.length > 0 ? [...exact, ...rest] : family.offerings, {
      ...opts,
      family,
      reason: opts.reason ?? "preferred",
    });
  }

  // No family — match raw catalog ids / names across providers.
  const matches = findDirectCatalogMatches(modelQuery);
  const out: ResolvedModelCandidate[] = [];
  const seen = new Set<string>();
  const sortedMatches = [...matches].sort((a, b) => {
    const ap = AGENT_PREFERENCE_ORDER.indexOf(a.provider);
    const bp = AGENT_PREFERENCE_ORDER.indexOf(b.provider);
    return (ap === -1 ? 99 : ap) - (bp === -1 ? 99 : bp);
  });

  for (const match of sortedMatches) {
    const instances = opts.onlyAgent
      ? (() => {
          const inst = resolveAgentInstance(opts.config, opts.onlyAgent, {
            includeDisabled: opts.includeDisabled,
          });
          return inst && inst.provider === match.provider ? [inst] : [];
        })()
      : instancesForProvider(match.provider, opts.config, opts.includeDisabled);
    for (const inst of sortAgentsByPreference(instances, opts.preferAgent)) {
      if (!opts.isReady(inst.id)) continue;
      pushUnique(
        out,
        seen,
        makeCandidate({
          agent: inst.id,
          provider: inst.provider,
          model: match.modelId,
          config: opts.config,
          modelClass: opts.modelClass,
          reference: inst.id === match.provider,
          reason: opts.reason ?? "catalog",
        }),
      );
    }
  }

  // Last resort: if an agent is pinned, accept the raw model string on it
  // (custom / not-yet-catalogued models).
  if (opts.onlyAgent && out.length === 0) {
    const inst = resolveAgentInstance(opts.config, opts.onlyAgent, {
      includeDisabled: opts.includeDisabled,
    });
    if (inst && opts.isReady(inst.id)) {
      pushUnique(
        out,
        seen,
        makeCandidate({
          agent: inst.id,
          provider: inst.provider,
          model: modelQuery,
          config: opts.config,
          modelClass: opts.modelClass,
          reference: false,
          reason: "pinned",
        }),
      );
    }
  }

  return out;
}

function candidatesForClass(
  classId: ModelClassId,
  opts: {
    config?: SteamtrainConfig;
    isReady: (agent: AgentInstanceId) => boolean;
    preferAgent?: AgentInstanceId;
    includeDisabled?: boolean;
    onlyAgent?: AgentInstanceId;
  },
): ResolvedModelCandidate[] {
  const out: ResolvedModelCandidate[] = [];
  const seen = new Set<string>();
  for (const family of candidateFamiliesForClass(classId, opts.config)) {
    const batch = offeringsToCandidates(family.offerings, {
      ...opts,
      family,
      modelClass: classId,
      reason: "class",
    });
    for (const c of batch) pushUnique(out, seen, c);
  }
  return out;
}

function formatSummary(primary: ResolvedModelCandidate, request: ModelBindingRequest): string {
  const via = primary.reference ? `${primary.agent} (reference)` : primary.agent;
  // More-specific agent+class before bare class (order matters).
  if (request.agent && request.modelClass && !request.model) {
    return `class '${request.modelClass}' → ${primary.modelName} on ${primary.agent}`;
  }
  if (request.modelClass && !request.model) {
    const label = primary.familyName ?? primary.modelName;
    return `class '${request.modelClass}' → ${label} via ${via}`;
  }
  if (!request.agent && request.model) {
    const label = primary.familyName ?? primary.modelName;
    return `${label} via ${via}`;
  }
  return `${primary.agent} · ${primary.modelName}`;
}

/**
 * Resolve a workflow step's agent/model/modelClass request into a concrete
 * runnable binding plus an ordered failover chain.
 *
 * Preference rules:
 * 1. Explicit agent pin is honored when that agent can satisfy the model/class.
 * 2. Otherwise the family's reference agent wins when healthy.
 * 3. Otherwise {@link AGENT_PREFERENCE_ORDER}, with built-in instance ids
 *    preferred over custom forks of the same provider.
 * 4. `fallbackModels` append additional chains after the primary family.
 */
export function resolveModelBinding(
  request: ModelBindingRequest,
  options: ResolveModelBindingOptions = {},
): ResolveModelBindingResult {
  const config = options.config;
  const isReady = options.isReady ?? (() => true);
  const includeDisabled = options.includeDisabled ?? false;
  const preferAgent = options.preferAgent ?? request.agent;

  const hasAgent = typeof request.agent === "string" && request.agent.length > 0;
  const hasModel = typeof request.model === "string" && request.model.trim().length > 0;
  const hasClass = typeof request.modelClass === "string" && request.modelClass.trim().length > 0;

  if (!hasAgent && !hasModel && !hasClass) {
    return { ok: false, error: "step needs agent+model, model, or modelClass" };
  }

  if (hasClass && !isModelClassId(request.modelClass!)) {
    return {
      ok: false,
      error: `unknown modelClass '${request.modelClass}'; try: ${MODEL_CLASS_HINT}`,
    };
  }

  if (hasAgent) {
    const inst = resolveAgentInstance(config, request.agent!, { includeDisabled });
    if (!inst) {
      return {
        ok: false,
        error: `agent '${request.agent}' is disabled or not configured`,
      };
    }
    if (!isReady(inst.id) && !hasModel && !hasClass) {
      // Pinned agent-only with no model to remap — cannot run.
      return {
        ok: false,
        error: `agent '${request.agent}' is not ready`,
      };
    }
  }

  const seen = new Set<string>();
  const candidates: ResolvedModelCandidate[] = [];

  const baseOpts = {
    config,
    isReady,
    preferAgent,
    includeDisabled,
    onlyAgent: hasAgent ? request.agent : undefined,
  };

  // ── Primary binding ──────────────────────────────────────────────────
  if (hasAgent && hasModel) {
    const provider = agentProvider(request.agent!, config);
    if (!provider) {
      return { ok: false, error: `agent '${request.agent}' is disabled or not configured` };
    }
    const family = findModelFamily(request.model!);
    // Only pin the model on this agent when it can actually run there:
    // translated family offering, catalog membership, or unknown custom id.
    const translated = nativeModelForProvider(provider, request.model!);
    const inCatalog = modelIdsForAgent(request.agent!, config).includes(request.model!);
    const pinnedModel =
      translated ?? (inCatalog ? request.model! : family ? undefined : request.model!);

    if (pinnedModel && isReady(request.agent!)) {
      const pinnedFamily = familyForProviderModel(provider, pinnedModel) ?? family ?? undefined;
      pushUnique(
        candidates,
        seen,
        makeCandidate({
          agent: request.agent!,
          provider,
          model: pinnedModel,
          config,
          family: pinnedFamily,
          reference:
            pinnedFamily?.offerings.some(
              (o) => o.reference && o.provider === provider && o.modelId === pinnedModel,
            ) ?? false,
          reason: "pinned",
        }),
      );
    }
    // Also add remapped offerings of the same family on other agents for failover.
    if (family) {
      for (const c of offeringsToCandidates(family.offerings, {
        ...baseOpts,
        onlyAgent: undefined,
        family,
        reason: "fallback",
      })) {
        pushUnique(candidates, seen, c);
      }
    }
  } else if (hasModel) {
    for (const c of candidatesForModelQuery(request.model!, {
      ...baseOpts,
      reason: "preferred",
    })) {
      pushUnique(candidates, seen, c);
    }
  } else if (hasClass) {
    for (const c of candidatesForClass(request.modelClass as ModelClassId, baseOpts)) {
      pushUnique(candidates, seen, c);
    }
  }

  // If agent was pinned but not ready, and we have model/class, allow
  // other agents (already collected above when onlyAgent was set and yielded
  // nothing). Re-run without onlyAgent when empty.
  if (candidates.length === 0 && hasAgent && (hasModel || hasClass)) {
    const relaxed = { ...baseOpts, onlyAgent: undefined };
    if (hasModel) {
      for (const c of candidatesForModelQuery(request.model!, {
        ...relaxed,
        reason: "fallback",
      })) {
        pushUnique(candidates, seen, c);
      }
    } else if (hasClass) {
      for (const c of candidatesForClass(request.modelClass as ModelClassId, relaxed)) {
        pushUnique(candidates, seen, c);
      }
    }
  }

  // ── Explicit fallbackModels ──────────────────────────────────────────
  for (const fb of request.fallbackModels ?? []) {
    if (!fb || !fb.trim()) continue;
    for (const c of candidatesForModelQuery(fb, {
      config,
      isReady,
      preferAgent,
      includeDisabled,
      reason: "fallback",
    })) {
      pushUnique(candidates, seen, c);
    }
  }

  // Filter to ready agents only (defensive — builders already gate).
  const ready = candidates.filter((c) => isReady(c.agent));
  if (ready.length === 0) {
    const want = hasClass
      ? `modelClass '${request.modelClass}'`
      : hasModel
        ? `model '${request.model}'`
        : `agent '${request.agent}'`;
    const hint = hasAgent
      ? ` (pinned agent '${request.agent}' unavailable; no alternate agent provides ${want})`
      : "";
    return {
      ok: false,
      error: `no ready agent can provide ${want}${hint}`,
    };
  }

  // Prefer preferAgent if present in the ready list.
  if (preferAgent) {
    const idx = ready.findIndex((c) => c.agent === preferAgent);
    if (idx > 0) {
      const [preferred] = ready.splice(idx, 1);
      if (preferred) ready.unshift(preferred);
    }
  }

  const primary = withResolvedEffort(ready[0]!, request, config);
  const withEffort = ready.map((c) => withResolvedEffort(c, request, config));
  return {
    ok: true,
    primary,
    candidates: withEffort,
    summary: formatSummary(primary, request),
  };
}

const MODEL_CLASS_HINT = MODEL_CLASS_IDS.join(", ");

/**
 * Whether a step request needs runtime resolution (missing agent, uses a
 * class, or declares fallbacks). Pinned agent+model with no fallbacks still
 * benefit from family-aware remapping on reroute, but are "bound".
 */
export function needsModelResolution(request: ModelBindingRequest): boolean {
  const hasAgent = typeof request.agent === "string" && request.agent.length > 0;
  const hasModel = typeof request.model === "string" && request.model.trim().length > 0;
  const hasClass = typeof request.modelClass === "string" && request.modelClass.trim().length > 0;
  const hasFallbacks = (request.fallbackModels?.length ?? 0) > 0;
  if (hasClass) return true;
  if (hasFallbacks) return true;
  if (hasModel && !hasAgent) return true;
  return false;
}

/**
 * Extract the binding request from a workflow step-like object.
 */
export function bindingRequestFromStep(step: {
  agent?: string;
  model?: string;
  modelClass?: string;
  fallbackModels?: string[];
  effort?: string;
}): ModelBindingRequest {
  return {
    agent: step.agent,
    model: step.model,
    modelClass: step.modelClass,
    fallbackModels: step.fallbackModels,
    effort: step.effort,
  };
}

/**
 * Resolve and materialize agent+model onto a step copy. Returns the original
 * step unchanged when resolution fails (caller should surface the error).
 */
export function materializeStepBinding<T extends ModelBindingRequest>(
  step: T,
  options: ResolveModelBindingOptions = {},
):
  | {
      ok: true;
      step: T & { agent: AgentInstanceId; model: string };
      summary: string;
      candidates: ResolvedModelCandidate[];
    }
  | { ok: false; error: string } {
  const resolved = resolveModelBinding(bindingRequestFromStep(step), options);
  if (!resolved.ok) return resolved;
  const next = {
    ...step,
    agent: resolved.primary.agent,
    model: resolved.primary.model,
  } as T & { agent: AgentInstanceId; model: string; effort?: string };
  if (resolved.primary.effort && !step.effort) {
    next.effort = resolved.primary.effort;
  }
  return {
    ok: true,
    step: next,
    summary: resolved.summary,
    candidates: resolved.candidates,
  };
}

/** Describe a model class for API / UI surfaces. */
export function describeModelClass(id: string, config?: SteamtrainConfig) {
  const def = modelClassById(id, config);
  if (!def) return undefined;
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    preferred: [...def.preferred],
    preferredEfforts: def.preferredEfforts ? [...def.preferredEfforts] : [],
    families: candidateFamiliesForClass(def.id, config).map((family) => ({
      id: family.id,
      name: family.name,
      offerings: family.offerings.map((o) => ({
        provider: o.provider,
        modelId: o.modelId,
        reference: o.reference,
      })),
    })),
  };
}

/** List all model classes for API / UI. */
export function listModelClasses(config?: SteamtrainConfig) {
  return MODEL_CLASS_IDS.map((id) => describeModelClass(id, config)).filter(
    (entry): entry is NonNullable<typeof entry> => entry !== undefined,
  );
}

/** List families (compact) for API / UI meta. */
export function listModelFamilyMeta() {
  return modelFamilies().map((family) => ({
    id: family.id,
    name: family.name,
    aliases: [...family.aliases],
    classes: [...family.classes],
    offerings: family.offerings.map((o) => ({
      provider: o.provider,
      modelId: o.modelId,
      reference: o.reference,
    })),
  }));
}

export { findModelFamily, nativeModelForProvider, normalizeModelQuery };
