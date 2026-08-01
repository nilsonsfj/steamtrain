/**
 * Pure helpers for the web plan editor (st-plan.js).
 *
 * Kept as TypeScript so unit tests can cover rename ref-rewriting and the
 * client-side validity lamp without a DOM. st-plan.js mirrors these
 * algorithms — keep the two in sync when changing either.
 */

export type PlanStep = {
  id: string;
  kind?: string;
  dependsOn?: string[];
  from?: string[];
  forEach?: string;
  when?: { step?: string; value?: string; equals?: string; [k: string]: unknown };
  condition?: { step?: string; [k: string]: unknown };
  step?: string;
  [k: string]: unknown;
};

export type PlanPhase = {
  id?: string;
  title?: string;
  steps?: PlanStep[];
};

export type PlanSpec = {
  name?: string;
  description?: string;
  phases?: PlanPhase[];
  [k: string]: unknown;
};

type FlatStep = { phase: PlanPhase; phaseIdx: number; step: PlanStep; stepIdx: number };

function flatSteps(spec: PlanSpec): FlatStep[] {
  const out: FlatStep[] = [];
  (spec.phases || []).forEach((p, pi) => {
    (p.steps || []).forEach((s, si) => {
      out.push({ phase: p, phaseIdx: pi, step: s, stepIdx: si });
    });
  });
  return out;
}

/**
 * Extract the source step id from a `forEach` value (`steps.<id>.items` or
 * `<id>.items`). Mirrors `parseForEachSource` in workflow/types.ts — keep the
 * regexes in sync (st-plan.js has a third copy).
 */
export function parsePlanForEachSource(source: string): string | undefined {
  const explicit = /^steps\.(.+)\.items$/.exec(source);
  if (explicit) return explicit[1];
  const shorthand = /^(.+)\.items$/.exec(source);
  return shorthand?.[1];
}

/** Rewrite a forEach value when its source step id changes. */
function rewriteForEachRef(forEach: string, oldId: string, newId: string): string {
  const source = parsePlanForEachSource(forEach);
  if (source !== oldId) return forEach;
  return forEach.startsWith("steps.") ? `steps.${newId}.items` : `${newId}.items`;
}

/** Rewrite every step-id reference in a draft when a step is renamed. */
export function rewriteStepRefs(spec: PlanSpec, oldId: string, newId: string): void {
  for (const f of flatSteps(spec)) {
    if (f.step.id === oldId) f.step.id = newId;
    if (Array.isArray(f.step.dependsOn)) {
      f.step.dependsOn = f.step.dependsOn.map((dep) => (dep === oldId ? newId : dep));
    }
    if (Array.isArray(f.step.from)) {
      f.step.from = f.step.from.map((ref) => (ref === oldId ? newId : ref));
    }
    if (f.step.forEach) f.step.forEach = rewriteForEachRef(f.step.forEach, oldId, newId);
    const c = f.step.condition;
    if (c && c.step === oldId) c.step = newId;
    if (f.step.when && f.step.when.step === oldId) f.step.when.step = newId;
    if (f.step.step === oldId && (f.step.kind === "approval" || f.step.kind === "merge")) {
      f.step.step = newId;
    }
  }
}

/**
 * Client-side sanity checks for the plan footer's "plan valid" lamp.
 * The server re-validates with the real schema on save; these catch the
 * structural mistakes the plan editor itself can produce.
 */
export function validatePlanStructure(spec: PlanSpec): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const seen: Record<string, true> = {};
  const phaseOf: Record<string, number> = {};
  (spec.phases || []).forEach((p, i) => {
    (p.steps || []).forEach((s) => {
      if (!s.id || !String(s.id).trim()) errors.push("a step has an empty id");
      else if (seen[s.id] !== undefined) errors.push(`duplicate step id '${s.id}'`);
      seen[s.id] = true;
      phaseOf[s.id] = i;
    });
  });
  (spec.phases || []).forEach((p, i) => {
    (p.steps || []).forEach((s) => {
      (s.dependsOn || []).forEach((dep) => {
        if (!seen[dep]) errors.push(`${s.id} depends on unknown step '${dep}'`);
        else if ((phaseOf[dep] ?? -1) >= i) {
          errors.push(`${s.id} depends on '${dep}', which is not in an earlier phase`);
        }
      });
      if (s.when?.step) {
        if (!seen[s.when.step]) {
          errors.push(`${s.id} when condition references unknown step '${s.when.step}'`);
        } else if ((phaseOf[s.when.step] ?? -1) >= i) {
          errors.push(
            `${s.id} when condition references '${s.when.step}', which is not in an earlier phase`,
          );
        }
      }
      if (s.condition?.step && !seen[s.condition.step]) {
        errors.push(`${s.id} condition references unknown step '${s.condition.step}'`);
      }
      if (s.forEach) {
        const sourceStepId = parsePlanForEachSource(s.forEach);
        if (!sourceStepId) {
          errors.push(
            `${s.id} has invalid forEach '${s.forEach}' (expected steps.<id>.items)`,
          );
        } else if (!seen[sourceStepId]) {
          errors.push(`${s.id} forEach references unknown step '${sourceStepId}'`);
        } else if ((phaseOf[sourceStepId] ?? -1) >= i) {
          errors.push(
            `${s.id} forEach references '${sourceStepId}', which is not in an earlier phase`,
          );
        }
      }
      (s.from || []).forEach((ref) => {
        if (!seen[ref]) errors.push(`${s.id} from references unknown step '${ref}'`);
      });
    });
  });
  return { ok: errors.length === 0, errors: errors };
}
