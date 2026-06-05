/**
 * Prompt templating. A step prompt may reference:
 *   {{input}} / {{args}}    → the workflow's input (the user's prompt)
 *   {{steps.<id>.output}}   → the output of an earlier step
 * Unknown placeholders (and stray braces) are left untouched, so prompts that
 * legitimately contain `{{` survive.
 */

export interface TemplateContext {
  input: string;
  /** stepId → output text, accumulated as the run progresses. */
  outputs: Map<string, string>;
}

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;
const STEP_OUTPUT = /^steps\.(.+)\.output$/;

export function renderPrompt(template: string, ctx: TemplateContext): string {
  return template.replace(PLACEHOLDER, (match, exprRaw: string) => {
    const expr = exprRaw.trim();
    if (expr === "input" || expr === "args") return ctx.input;
    const step = STEP_OUTPUT.exec(expr);
    if (step) {
      const id = step[1] as string;
      return ctx.outputs.get(id) ?? "";
    }
    return match;
  });
}
