/**
 * Helpers for typed workflow inputs (`model` / `agent` / `enum`) and the
 * per-input `fallbackModels` safety net that keeps a run alive when the
 * primary model hits quota or rate limits.
 */
import type { WorkflowInputSpec, WorkflowSpec } from "./types";

/** All supported workflow input parameter types. */
export const WORKFLOW_INPUT_TYPES = [
  "string",
  "number",
  "boolean",
  "model",
  "agent",
  "enum",
] as const;

export type WorkflowInputType = (typeof WORKFLOW_INPUT_TYPES)[number];

/** Resolve the effective type for an input (default `"string"`). */
export function workflowInputType(spec: WorkflowInputSpec): WorkflowInputType {
  return spec.type ?? "string";
}

/** True when the type is a free-text or catalog-backed string-like value. */
export function isStringLikeInputType(type: WorkflowInputType): boolean {
  return type === "string" || type === "model" || type === "agent" || type === "enum";
}

/** Match `{{inputs.key}}` placeholders (optional whitespace inside braces). */
const INPUT_PLACEHOLDER_RE = /\{\{\s*inputs\.([a-zA-Z_][a-zA-Z0-9_-]*)\s*\}\}/g;

/**
 * Collect every `inputs.<key>` referenced by a template string, in order of
 * first appearance (deduped).
 */
export function inputKeysReferencedInTemplate(template: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  INPUT_PLACEHOLDER_RE.lastIndex = 0;
  for (const match of template.matchAll(INPUT_PLACEHOLDER_RE)) {
    const key = match[1]!;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * Collect ordered failover model queries declared on `model`-typed inputs that
 * a step's `model` template references. Authors put the safety net next to the
 * parameter the user picks, so switching the primary model at run time still
 * carries its declared fallbacks.
 *
 * Order: first-referenced input's fallbacks, then the next, … Dedup is
 * case-insensitive; first spelling wins.
 */
export function fallbackModelsFromInputRefs(
  inputs: Record<string, WorkflowInputSpec> | undefined,
  modelTemplate: string | undefined,
): string[] | undefined {
  if (!inputs || !modelTemplate) return undefined;
  const keys = inputKeysReferencedInTemplate(modelTemplate);
  if (keys.length === 0) return undefined;

  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of keys) {
    const input = inputs[key];
    if (!input) continue;
    if (workflowInputType(input) !== "model") continue;
    for (const entry of input.fallbackModels ?? []) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const dedupe = trimmed.toLowerCase();
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push(trimmed);
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Merge several ordered fallback-model lists. Earlier lists win on
 * case-insensitive collision; empty/whitespace entries are dropped.
 * Returns `undefined` when nothing remains.
 */
export function mergeFallbackModelLists(
  ...lists: Array<string[] | undefined>
): string[] | undefined {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    if (!list) continue;
    for (const entry of list) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Build the effective `fallbackModels` chain for a step that may use a
 * templated `model: "{{inputs.*}}"`. Precedence (first wins on collision):
 *   1. Input-declared `fallbackModels` (from referenced model-typed params)
 *   2. Step-level `fallbackModels`
 *   3. Workflow-level `fallbackModels`
 */
export function effectiveFallbackModelsForStep(
  spec: Pick<WorkflowSpec, "inputs" | "fallbackModels">,
  step: { model?: string; fallbackModels?: string[] },
): string[] | undefined {
  return mergeFallbackModelLists(
    fallbackModelsFromInputRefs(spec.inputs, step.model),
    step.fallbackModels,
    spec.fallbackModels,
  );
}
