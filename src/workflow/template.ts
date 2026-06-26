/**
 * Prompt templating. A step prompt may reference:
 *   {{input}} / {{args}}    → the workflow's input (the user's prompt)
 *   {{steps.<id>.output}}   → the output of an earlier step
 *   {{steps.<id>.items}}    → distributor items joined by newlines
 *   {{steps.<id>.ok}}       → "true" / "false"
 *   {{steps.<id>.error}}    → error text, if any
 *   {{item}} / {{item.value}} → current fan-out item, inside `forEach`
 * Unknown placeholders (and stray braces) are left untouched, so prompts that
 * legitimately contain `{{` survive.
 */

import type { WorkflowItem } from "./types";

export interface TemplateContext {
  input: string;
  /** stepId → output text, accumulated as the run progresses. */
  outputs: Map<string, string>;
  /** Full step results, when templates need status or structured payloads. */
  results?: Map<
    string,
    { ok: boolean; error?: string; items?: string[]; target?: string; iteration?: number }
  >;
  /** Current dynamic fan-out item for `forEach` worker/processor runs. */
  item?: WorkflowItem;
  /** Current loop iteration (1-based); default 1. */
  iteration?: number;
}

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;
const STEP_FIELD = /^steps\.(.+)\.(output|items|ok|error|target|iteration)$/;

export function renderPrompt(template: string, ctx: TemplateContext): string {
  return template.replace(PLACEHOLDER, (match, exprRaw: string) => {
    const expr = exprRaw.trim();
    if (expr === "input" || expr === "args") return ctx.input;
    if (expr === "item" || expr === "item.value") return ctx.item?.value ?? "";
    if (expr === "item.index") return ctx.item ? String(ctx.item.index) : "";
    if (expr === "item.sourceStepId") return ctx.item?.sourceStepId ?? "";
    if (expr === "iteration") return String(ctx.iteration ?? 1);
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
    }
    return match;
  });
}
