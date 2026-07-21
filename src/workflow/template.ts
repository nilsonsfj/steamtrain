/**
 * Prompt templating. A step prompt may reference:
 *   {{input}} / {{args}}    → the workflow's input (the user's prompt)
 *   {{inputs.<key>}}        → a declared workflow input parameter
 *   {{steps.<id>.output}}   → the output of an earlier step
 *   {{steps.<id>.items}}    → distributor items joined by newlines
 *   {{steps.<id>.ok}}       → "true" / "false"
 *   {{steps.<id>.error}}    → error text, if any
 *   {{steps.<id>.exitCode}} → a command step's exit code, e.g. "0"
 *   {{steps.<id>.json}}     → the step's parsed structured output, serialized
 *   {{steps.<id>.json.<path>}} → a field of it, e.g. json.verdict or json.targets[2]
 *   {{steps.<id>.artifacts.<name>}} → the snapshot path of a declared artifact
 *   {{steps.<id>.worktree.root}}   → the step's isolated git worktree directory
 *   {{steps.<id>.worktree.branch}} → the steamtrain branch checked out there
 *   {{steps.<id>.worktree.cwd}}    → the cwd the agent actually ran in
 *   {{item}} / {{item.value}} → current fan-out item, inside `forEach`
 * Unknown placeholders (and stray braces) are left untouched, so prompts that
 * legitimately contain `{{` survive.
 */

import { jsonFieldText, jsonPathGet } from "./structured";
import type {
  GateCondition,
  WorkflowCallStep,
  WorkflowItem,
  WorkflowSpec,
  WorkflowStep,
} from "./types";
import { workflowStepKind } from "./types";

export interface TemplateContext {
  input: string;
  /** Resolved workflow input parameters (`{{inputs.<key>}}`). */
  inputs?: Record<string, string | number | boolean>;
  /** stepId → output text, accumulated as the run progresses. */
  outputs: Map<string, string>;
  /** Full step results, when templates need status or structured payloads. */
  results?: Map<
    string,
    {
      ok: boolean;
      error?: string;
      items?: string[];
      target?: string;
      iteration?: number;
      /** A command step's subprocess exit code. */
      exitCode?: number;
      /** Declared artifacts snapshotted for the step (name → snapshot path). */
      artifacts?: { name: string; path: string }[];
      json?: unknown;
      /** Isolated git worktree metadata, when the step ran in one. */
      worktree?: { root: string; branch: string; cwd: string };
    }
  >;
  /** Current dynamic fan-out item for `forEach` worker/processor runs. */
  item?: WorkflowItem;
  /** Current loop iteration (1-based); default 1. */
  iteration?: number;
}

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;
const INPUT_REF = /^inputs\.(.+)$/;
// NOTE: STEP_FIELD's greedy `(.+)` id group means it also matches worktree/
// artifact/json refs whose trailing part happens to end in a plain field name
// (`steps.foo.artifacts.output` → id "foo.artifacts", field "output"), so
// renderPrompt MUST test the more specific worktree/artifact/json regexes
// before this one — the check order is load-bearing.
const STEP_FIELD = /^steps\.(.+)\.(output|items|ok|error|target|iteration|exitCode)$/;
const STEP_WORKTREE_FIELD = /^steps\.(.+)\.worktree\.(root|branch|cwd)$/;
/** `steps.<id>.json` with an optional `.field`/`[index]` path after it. */
const STEP_JSON_FIELD = /^steps\.(.+?)\.json((?:\.|\[).+)?$/;
/** `steps.<id>.artifacts.<name>` — the snapshot path of one declared artifact. */
const STEP_ARTIFACT_FIELD = /^steps\.(.+?)\.artifacts\.(.+)$/;

export function renderPrompt(template: string, ctx: TemplateContext): string {
  return template.replace(PLACEHOLDER, (match, exprRaw: string) => {
    const expr = exprRaw.trim();
    if (expr === "input" || expr === "args") return ctx.input;
    const inputRef = INPUT_REF.exec(expr);
    if (inputRef) {
      const key = inputRef[1] as string;
      const val = ctx.inputs?.[key];
      return val !== undefined ? String(val) : "";
    }
    if (expr === "item" || expr === "item.value") return ctx.item?.value ?? "";
    if (expr === "item.index") return ctx.item ? String(ctx.item.index) : "";
    if (expr === "item.sourceStepId") return ctx.item?.sourceStepId ?? "";
    if (expr === "iteration") return String(ctx.iteration ?? 1);
    const worktreeRef = STEP_WORKTREE_FIELD.exec(expr);
    if (worktreeRef) {
      const worktree = ctx.results?.get(worktreeRef[1] as string)?.worktree;
      if (!worktree) return "";
      return worktree[worktreeRef[2] as "root" | "branch" | "cwd"] ?? "";
    }
    const artifactRef = STEP_ARTIFACT_FIELD.exec(expr);
    if (artifactRef) {
      const artifacts = ctx.results?.get(artifactRef[1] as string)?.artifacts;
      return artifacts?.find((artifact) => artifact.name === artifactRef[2])?.path ?? "";
    }
    const jsonRef = STEP_JSON_FIELD.exec(expr);
    if (jsonRef) {
      const json = ctx.results?.get(jsonRef[1] as string)?.json;
      if (json === undefined) return "";
      const path = jsonRef[2];
      return jsonFieldText(
        path === undefined ? json : jsonPathGet(json, path.startsWith(".") ? path.slice(1) : path),
      );
    }
    const step = STEP_FIELD.exec(expr);
    if (step) {
      const id = step[1] as string;
      const field = step[2];
      if (field === "output") return ctx.outputs.get(id) ?? "";
      const result = ctx.results?.get(id);
      if (!result) return "";
      if (field === "items") return result.items?.join("\n") ?? "";
      if (field === "ok") return String(result.ok);
      if (field === "error") return result.error ?? "";
      if (field === "target") return result.target ?? "";
      if (field === "iteration")
        return result.iteration !== undefined ? String(result.iteration) : "";
      if (field === "exitCode") return result.exitCode !== undefined ? String(result.exitCode) : "";
    }
    return match;
  });
}

// ---- Template reference linting (2.8) ----

function isCommandStep(step: WorkflowStep): boolean {
  return workflowStepKind(step) === "command";
}

function hasArtifacts(step: WorkflowStep): boolean {
  return "artifacts" in step && Array.isArray(step.artifacts) && step.artifacts.length > 0;
}

function hasWorkspace(step: WorkflowStep): boolean {
  const kind = workflowStepKind(step);
  if (kind === "worker" || kind === "processor" || kind === "command") return true;
  // A merge step only leaves a worktree behind in `mode: "worktree"` —
  // apply/branch/pr deliver the merge and record no worktree.
  if (kind === "merge" && (step as { mode?: string }).mode === "worktree") return true;
  // A `workflow` call step with `worktreeStep` (and no `forEach`) surfaces a
  // named child step's worktree as its own — see `WorkflowCallStep.worktreeStep`.
  if (kind === "workflow") {
    const ws = step as WorkflowCallStep;
    return Boolean(ws.worktreeStep) && !ws.forEach;
  }
  return false;
}

function extractRefs(text: string | undefined): string[] {
  if (!text) return [];
  const refs: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    const expr = (match[1] as string).trim();
    // Only flag references that look like steamtrain-specific patterns.
    // Generic mustache templates (e.g. {{name}}) are left alone.
    if (
      expr === "input" ||
      expr === "args" || // alias for {{input}} in renderPrompt
      expr.startsWith("steps.") ||
      expr.startsWith("inputs.") ||
      expr === "item" ||
      expr === "item.value" ||
      expr === "item.index" ||
      expr === "item.sourceStepId" ||
      expr === "iteration"
    ) {
      refs.push(expr);
    }
  }
  return refs;
}

/** Scan condition text fields for template refs. `condition.step` is intentionally skipped — it's a plain step id, not a template string. */
function scanConditionRefs(condition: GateCondition | undefined, refs: string[]): void {
  if (!condition) return;
  if (condition.value) refs.push(...extractRefs(condition.value));
  if (condition.contains) refs.push(...extractRefs(condition.contains));
  if (condition.equals) refs.push(...extractRefs(condition.equals));
  if (condition.matches) refs.push(...extractRefs(condition.matches));
}

function stepRefs(step: WorkflowStep): string[] {
  const refs: string[] = [];
  const kind = workflowStepKind(step);

  if ("prompt" in step && typeof step.prompt === "string") refs.push(...extractRefs(step.prompt));
  if (kind === "llm" && "system" in step && typeof step.system === "string") {
    refs.push(...extractRefs(step.system));
  }
  if (kind === "distributor" && "items" in step && Array.isArray(step.items)) {
    for (const item of step.items) refs.push(...extractRefs(item));
  }
  if (kind === "gate" && "condition" in step) scanConditionRefs(step.condition, refs);
  if (step.when) scanConditionRefs(step.when, refs);
  if (kind === "merge") {
    const ms = step as {
      branch?: string;
      commitMessage?: string;
      prTitle?: string;
      prBody?: string;
    };
    if (ms.branch) refs.push(...extractRefs(ms.branch));
    if (ms.commitMessage) refs.push(...extractRefs(ms.commitMessage));
    if (ms.prTitle) refs.push(...extractRefs(ms.prTitle));
    if (ms.prBody) refs.push(...extractRefs(ms.prBody));
  }
  if (kind === "command" && "cmd" in step && typeof step.cmd === "string") {
    refs.push(...extractRefs(step.cmd));
  }
  if (kind === "issues") {
    const is = step as { mode?: string; titlePrefix?: string };
    if (is.mode) refs.push(...extractRefs(is.mode));
    if (is.titlePrefix) refs.push(...extractRefs(is.titlePrefix));
  }
  if (kind === "workflow" && "input" in step && typeof step.input === "string") {
    refs.push(...extractRefs(step.input));
  }
  if (kind === "workflow") {
    const ws = step as WorkflowCallStep;
    if (ws.params) {
      for (const value of Object.values(ws.params)) refs.push(...extractRefs(value));
    }
  }
  // Templated model/effort (building block 5): scan like any other renderable
  // field so unknown step refs / undeclared inputs surface at spec-validate
  // time instead of silently rendering empty at run time.
  if ("model" in step && typeof step.model === "string") refs.push(...extractRefs(step.model));
  if ("effort" in step && typeof step.effort === "string") refs.push(...extractRefs(step.effort));

  return refs;
}

/**
 * Lint all `{{...}}` template references in a workflow spec.
 *
 * Returns an array of non-fatal warning strings for references that will
 * silently render as empty at runtime — unknown step ids, invalid step fields,
 * undeclared input keys, and contextual misuse of `{{item}}` / `{{iteration}}`.
 *
 * Unknown placeholders that do not match any steamtrain-specific pattern
 * (e.g. `{{name}}` in a mustache-style prompt) are intentionally ignored.
 */
export function lintTemplateRefs(spec: WorkflowSpec): string[] {
  const warnings: string[] = [];

  const inputKeys = new Set(Object.keys(spec.inputs ?? {}));
  const stepIds = new Set<string>();
  const forEachChildIds = new Set<string>();

  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      stepIds.add(step.id);
    }
  }

  // Build a set of phase indices that fall inside loop regions.
  const phaseIndex = new Map<string, number>();
  spec.phases.forEach((p, i) => phaseIndex.set(p.id, i));
  const loopPhaseIndices = new Set<number>();
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      if (step.kind === "gate" && step.loopTo) {
        const targetIdx = phaseIndex.get(step.loopTo);
        const gateIdx = phaseIndex.get(phase.id);
        if (targetIdx !== undefined && gateIdx !== undefined) {
          for (let i = targetIdx; i <= gateIdx; i++) loopPhaseIndices.add(i);
        }
      }
    }
  }

  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      if (
        (step.kind === "worker" ||
          step.kind === "processor" ||
          step.kind === "llm" ||
          step.kind === "workflow" ||
          !step.kind) &&
        "forEach" in step &&
        step.forEach
      ) {
        forEachChildIds.add(step.id);
      }
    }
  }

  for (let pi = 0; pi < spec.phases.length; pi++) {
    const phase = spec.phases[pi];
    if (!phase) continue;
    const inLoop = loopPhaseIndices.has(pi);
    for (const step of phase.steps) {
      const inForEach = forEachChildIds.has(step.id);
      const refs = stepRefs(step);

      for (const ref of refs) {
        // {{inputs.<key>}}
        if (ref.startsWith("inputs.")) {
          const key = ref.slice(7);
          if (!inputKeys.has(key)) {
            warnings.push(
              `step '${step.id}' references undeclared input '${key}' (available: ${[...inputKeys].join(", ") || "none"})`,
            );
          }
          continue;
        }

        // {{item}} / {{item.*}} — only valid inside forEach
        if (ref === "item" || ref.startsWith("item.")) {
          if (!inForEach) {
            warnings.push(
              `step '${step.id}' uses '{{${ref}}}' but is not a forEach child (only forEach steps have access to item context)`,
            );
          }
          continue;
        }

        // {{iteration}} — only valid inside a loop region
        if (ref === "iteration") {
          if (!inLoop) {
            if (inForEach) {
              warnings.push(
                `step '${step.id}' uses '{{iteration}}' but forEach children don't have loop iteration context (use {{item.index}} for item position)`,
              );
            } else {
              warnings.push(
                `step '${step.id}' uses '{{iteration}}' but is not inside a loop region (add a gate with loopTo, or use {{steps.<gateId>.iteration}} instead)`,
              );
            }
          }
          continue;
        }

        // {{steps.<id>.<field>}}
        if (!ref.startsWith("steps.")) continue;
        const stepFieldMatch = STEP_FIELD.exec(ref);
        if (stepFieldMatch) {
          const refId = stepFieldMatch[1] as string;
          const field = stepFieldMatch[2] as string;
          if (!stepIds.has(refId)) {
            warnings.push(`step '${step.id}' references unknown step '${refId}'`);
          } else if (field === "exitCode") {
            const refStep = findStep(spec, refId);
            if (refStep && !isCommandStep(refStep)) {
              warnings.push(
                `step '${step.id}' references '${refId}.exitCode' but '${refId}' is not a command step (exitCode is only available on command steps)`,
              );
            }
          }
          continue;
        }

        const worktreeMatch = STEP_WORKTREE_FIELD.exec(ref);
        if (worktreeMatch) {
          const refId = worktreeMatch[1] as string;
          if (!stepIds.has(refId)) {
            warnings.push(`step '${step.id}' references unknown step '${refId}'`);
          } else {
            const refStep = findStep(spec, refId);
            if (refStep && !hasWorkspace(refStep)) {
              warnings.push(
                `step '${step.id}' references '${refId}.worktree.${worktreeMatch[2]}' but '${refId}' does not have workspace isolation (only worker, processor, and command steps — or a merge step with mode "worktree" — have worktrees)`,
              );
            }
          }
          continue;
        }

        const artifactMatch = STEP_ARTIFACT_FIELD.exec(ref);
        if (artifactMatch) {
          const refId = artifactMatch[1] as string;
          if (!stepIds.has(refId)) {
            warnings.push(`step '${step.id}' references unknown step '${refId}'`);
          } else {
            const refStep = findStep(spec, refId);
            if (refStep && !hasArtifacts(refStep)) {
              warnings.push(
                `step '${step.id}' references '${refId}.artifacts.${artifactMatch[2]}' but '${refId}' has no declared artifacts`,
              );
            }
          }
          continue;
        }

        const jsonMatch = STEP_JSON_FIELD.exec(ref);
        if (jsonMatch) {
          const refId = jsonMatch[1] as string;
          if (!stepIds.has(refId)) {
            warnings.push(`step '${step.id}' references unknown step '${refId}'`);
          }
          continue;
        }

        // Fallback: starts with "steps." but doesn't match any known pattern.
        // Try to extract the step id and warn if unknown.
        const looseId = /^steps\.([^.[\s]+)/.exec(ref);
        if (looseId) {
          const refId = looseId[1] as string;
          if (!stepIds.has(refId)) {
            warnings.push(`step '${step.id}' references unknown step '${refId}'`);
          } else {
            warnings.push(`step '${step.id}' uses invalid template reference '{{${ref}}}'`);
          }
        }
      }
    }
  }

  // Command steps run through the platform shell with templates expanded raw —
  // flag embeddings of workflow input / step output so authors treat them like
  // a Makefile (see SECURITY.md).
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      if (
        workflowStepKind(step) !== "command" ||
        !("cmd" in step) ||
        typeof step.cmd !== "string"
      ) {
        continue;
      }
      const cmdRefs = extractRefs(step.cmd);
      const risky = cmdRefs.filter(
        (ref) =>
          ref === "input" ||
          ref === "args" ||
          ref.startsWith("inputs.") ||
          ref.startsWith("steps.") ||
          ref === "item" ||
          ref.startsWith("item."),
      );
      if (risky.length > 0) {
        warnings.push(
          `step '${step.id}' is a command step whose cmd embeds template data ({{${risky[0]}}}); values are interpolated into the shell unsanitized — review like a Makefile`,
        );
      }
    }
  }

  return warnings;
}

function findStep(spec: WorkflowSpec, id: string): WorkflowStep | undefined {
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      if (step.id === id) return step;
    }
  }
  return undefined;
}
