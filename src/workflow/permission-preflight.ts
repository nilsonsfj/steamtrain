import { resolveAgentInstance } from "../agents/config";
import {
  type PermissionProfile,
  type PermissionsSpec,
  type ResolvedPermissions,
  effectivePermissions,
  permissionPlan,
  permissionsLabel,
} from "../agents/permissions";
import type { SteamtrainConfig } from "../config/types";
import { isAgentBackedStep, workflowStepKind } from "./step-kind";
import type { WorkflowSpec, WorkflowStep } from "./types";

/**
 * Pre-dispatch answer to "will this workflow's declared permissions actually
 * hold?", computed from the spec + config alone — no agent is spawned.
 *
 * The mapping in `agents/permissions.ts` is honest about what each CLI can
 * enforce, which means a workflow can be *authored* with a profile its pinned
 * agent cannot honor. Discovering that at step 7 of 9 is a waste; this reports
 * it before the run starts, in the same shape (`string[]`) the API-key
 * preflight uses, so the existing dispatch gate can refuse the run and the UIs
 * can explain why.
 */
export interface PermissionPreflight {
  /**
   * Blocking problems: a restricted profile whose agent cannot enforce it, with
   * `onUnsupported: "fail"` (the default). The run must not start — a lock icon
   * over an unrestricted agent is worse than no lock at all.
   */
  errors: string[];
  /**
   * Non-blocking: profiles running unenforced by explicit opt-in
   * (`onUnsupported: "warn"`), and partial enforcement where the CLI honors the
   * profile but not every part of the request.
   */
  warnings: string[];
}

/** Effective permissions for one step under a spec + config. */
export function stepEffectivePermissions(
  step: WorkflowStep,
  spec: WorkflowSpec,
  config?: SteamtrainConfig,
): ResolvedPermissions | undefined {
  if (!isAgentBackedStep(step)) return undefined;
  return effectivePermissions([
    (step as { permissions?: PermissionsSpec }).permissions,
    spec.permissions,
    config?.permissions,
  ]);
}

/**
 * Per-step enforcement verdict for preview surfaces: what the step asked for,
 * and what its agent will actually do about it. `provider` is undefined when
 * the step's agent binding is not concrete yet (a `modelClass` step resolved at
 * run time) — the run-time gate still applies.
 */
export interface StepPermissionVerdict {
  stepId: string;
  permissions: ResolvedPermissions;
  provider?: string;
  agent?: string;
  enforcement: "native" | "partial" | "none" | "unknown";
  gaps: string[];
  /** True when this step would be refused at dispatch time. */
  blocking: boolean;
}

/** Verdicts for every agent-backed step that declares (or inherits) a profile. */
export function workflowPermissionVerdicts(
  spec: WorkflowSpec,
  config?: SteamtrainConfig,
): StepPermissionVerdict[] {
  const verdicts: StepPermissionVerdict[] = [];
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      const perms = stepEffectivePermissions(step, spec, config);
      if (!perms) continue;
      const agent = (step as { agent?: string }).agent;
      const instance = agent ? resolveAgentInstance(config, agent) : undefined;
      if (!instance) {
        verdicts.push({
          stepId: step.id,
          permissions: perms,
          agent,
          enforcement: "unknown",
          gaps: [],
          blocking: false,
        });
        continue;
      }
      const plan = permissionPlan(instance.provider, perms);
      verdicts.push({
        stepId: step.id,
        permissions: perms,
        provider: instance.provider,
        agent,
        enforcement: plan.enforcement,
        gaps: plan.gaps,
        blocking: plan.enforcement === "none" && perms.onUnsupported === "fail",
      });
    }
  }
  return verdicts;
}

/** Blocking errors + non-blocking warnings for a workflow's permissions. */
export function workflowPermissionPreflight(
  spec: WorkflowSpec,
  config?: SteamtrainConfig,
): PermissionPreflight {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const verdict of workflowPermissionVerdicts(spec, config)) {
    const label = permissionsLabel(verdict.permissions);
    const where = `step '${verdict.stepId}'`;
    const who = verdict.agent
      ? `agent '${verdict.agent}'${verdict.provider && verdict.provider !== verdict.agent ? ` (provider '${verdict.provider}')` : ""}`
      : "its agent";
    if (verdict.blocking) {
      errors.push(
        `${where} requires permissions '${label}' but ${who} cannot enforce it: ${verdict.gaps.join("; ")}`,
      );
      continue;
    }
    if (verdict.enforcement === "none") {
      warnings.push(
        `${where} runs UNENFORCED at permissions '${label}' (onUnsupported: "warn"): ${verdict.gaps.join("; ")}`,
      );
      continue;
    }
    if (verdict.enforcement === "partial") {
      warnings.push(
        `${where} permissions '${label}' is partially enforced: ${verdict.gaps.join("; ")}`,
      );
    }
  }
  return { errors, warnings };
}

/**
 * Whole-workflow permission posture: how many agent steps run under each
 * profile, and how many run with no profile at all. This is the single line a
 * user wants before pressing run on a real repository — "4 read-only, 1 full,
 * nothing unrestricted" is a different proposition from "7 unrestricted".
 */
export interface PermissionSummary {
  /** Agent-backed steps per declared/inherited profile. */
  counts: Record<PermissionProfile, number>;
  /** Agent-backed steps with no profile anywhere (historical full power). */
  unrestricted: number;
  /** Total agent-backed steps considered. */
  agentSteps: number;
  /** Steps that would be refused at dispatch (unenforceable restriction). */
  blocking: number;
  /** Steps knowingly running unenforced (`onUnsupported: "warn"`). */
  unenforced: number;
}

export function workflowPermissionSummary(
  spec: WorkflowSpec,
  config?: SteamtrainConfig,
): PermissionSummary {
  const counts: Record<PermissionProfile, number> = { "read-only": 0, edit: 0, full: 0 };
  let agentSteps = 0;
  let unrestricted = 0;
  let blocking = 0;
  let unenforced = 0;
  const verdicts = new Map(workflowPermissionVerdicts(spec, config).map((v) => [v.stepId, v]));
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      if (!isAgentBackedStep(step)) continue;
      agentSteps += 1;
      const perms = stepEffectivePermissions(step, spec, config);
      if (!perms) {
        unrestricted += 1;
        continue;
      }
      counts[perms.profile] += 1;
      const verdict = verdicts.get(step.id);
      if (verdict?.blocking) blocking += 1;
      else if (verdict?.enforcement === "none") unenforced += 1;
    }
  }
  return { counts, unrestricted, agentSteps, blocking, unenforced };
}

/**
 * One-line rendering of {@link workflowPermissionSummary}, or `undefined` when
 * the workflow has no agent steps at all (an agentless pipeline has nothing to
 * sandbox, and a "0 steps" line would be noise).
 */
export function formatPermissionSummary(summary: PermissionSummary): string | undefined {
  if (summary.agentSteps === 0) return undefined;
  const bits: string[] = [];
  for (const profile of ["read-only", "edit", "full"] as const) {
    if (summary.counts[profile] > 0) bits.push(`${summary.counts[profile]} ${profile}`);
  }
  if (summary.unrestricted > 0) bits.push(`${summary.unrestricted} unrestricted`);
  const tail: string[] = [];
  if (summary.blocking > 0) tail.push(`${summary.blocking} unenforceable`);
  if (summary.unenforced > 0) tail.push(`${summary.unenforced} unenforced`);
  return `${bits.join(" · ")}${tail.length > 0 ? ` · ⚠ ${tail.join(" · ")}` : ""}`;
}

/** True when at least one agent step in the workflow declares a profile. */
export function permissionSummaryDeclared(summary: PermissionSummary): boolean {
  return Object.values(summary.counts).some((count) => count > 0);
}

/**
 * Glyph for a summary line: a closed lock only when something is actually
 * sandboxed. `🔒 sandbox: 7 unrestricted` would be a lie told by an icon.
 */
export function permissionSummaryGlyph(summary: PermissionSummary): string {
  if (summary.blocking > 0 || summary.unenforced > 0) return "🔓";
  return permissionSummaryDeclared(summary) ? "🔒" : "🔓";
}

/**
 * Short per-step enforcement note for preview/detail surfaces, e.g.
 * `enforced by codex (--sandbox)` or `NOT enforced by amp`.
 */
export function permissionEnforcementNote(verdict: StepPermissionVerdict): string {
  switch (verdict.enforcement) {
    case "native":
      return `enforced by ${verdict.provider}`;
    case "partial":
      return `partly enforced by ${verdict.provider}: ${verdict.gaps.join("; ")}`;
    case "none":
      return verdict.blocking
        ? `NOT enforceable by ${verdict.provider} — this step is blocked before it spawns`
        : `NOT enforced by ${verdict.provider} (running unenforced by opt-in)`;
    case "unknown":
      return "enforcement resolved at run time (agent not pinned yet)";
  }
}

/** True when the step kind can carry a `permissions` profile at all. */
export function permissionsApplyToStep(step: WorkflowStep): boolean {
  return workflowStepKind(step) === "workflow" || isAgentBackedStep(step);
}
