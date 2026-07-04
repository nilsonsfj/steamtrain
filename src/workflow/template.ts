/**
 * Prompt templating. A step prompt may reference:
 *   {{input}} / {{args}}    → the workflow's input (the user's prompt)
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
import type { WorkflowItem } from "./types";

export interface TemplateContext {
  input: string;
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
