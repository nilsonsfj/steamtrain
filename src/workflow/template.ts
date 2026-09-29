/**
 * Prompt templating. A step prompt may reference:
 *   {{input}} / {{args}}    → the workflow's input (the user's prompt)
 *   {{inputs.<key>}}        → a declared workflow input parameter
 *   {{steps.<id>.output}}   → the output of an earlier step
 *   {{steps.<id>.items}}    → the step's fan-out items joined by newlines
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
 *
 * Command steps use {@link renderCmd}, which shell-quotes interpolated values
 * unless `allowShellTemplates` is set on the step (raw Makefile-style mode).
 */

import { randomBytes } from "node:crypto";
import { redactSecrets } from "../util/redact";
import { type ShellQuoteContext, shellQuoteInContext } from "../util/shell-quote";
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

export interface RenderPromptOptions {
  /**
   * When true (default for agent/LLM prompts), scrub high-confidence secret
   * shapes from interpolated values before embedding them.
   */
  redact?: boolean;
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

/**
 * The items a step fans out as when it never declared any of its own: one per
 * non-blank output line. Shared with the engine's `forEach` expansion so
 * `{{steps.<id>.items}}` can never disagree with what `forEach` actually
 * iterated.
 */
export function splitItemsFromOutput(output: string | undefined): string[] {
  return output
    ? output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
}

function resolveTemplateValue(expr: string, ctx: TemplateContext): string | undefined {
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
    // Same fallback `forEach` uses when it fans out over a step that never
    // declared `items` (a `command` step listing PR numbers, say). Without it
    // `{{steps.x.items}}` rendered empty for exactly the steps a `forEach`
    // happily expanded — a summary claiming nothing was considered while the
    // fan-out beside it processed six of them.
    if (field === "items")
      return (result.items ?? splitItemsFromOutput(ctx.outputs.get(id))).join("\n");
    if (field === "ok") return String(result.ok);
    if (field === "error") return result.error ?? "";
    if (field === "target") return result.target ?? "";
    if (field === "iteration")
      return result.iteration !== undefined ? String(result.iteration) : "";
    if (field === "exitCode") return result.exitCode !== undefined ? String(result.exitCode) : "";
  }
  return undefined;
}

export function renderPrompt(
  template: string,
  ctx: TemplateContext,
  options: RenderPromptOptions = {},
): string {
  const redact = options.redact !== false;
  return template.replace(PLACEHOLDER, (match, exprRaw: string) => {
    const expr = exprRaw.trim();
    const value = resolveTemplateValue(expr, ctx);
    if (value === undefined) return match;
    return redact ? redactSecrets(value) : value;
  });
}

export interface RenderCmdOptions {
  /**
   * When true, interpolate template values raw (Makefile-style). Default
   * false: values are {@link shellQuote}'d so metacharacters cannot inject
   * shell syntax. Prefer passing data via templated `env` instead.
   */
  allowShellTemplates?: boolean;
  platform?: NodeJS.Platform;
}

/**
 * Render a command-step `cmd` template. Interpolated values are shell-quoted
 * for the quote context they sit in (unquoted / `'…'` / `"…"`), unless
 * `allowShellTemplates` is set (opt-in raw mode for intentional full command
 * injection like `cmd: "{{inputs.testCmd}}"`).
 */
export function renderCmd(
  template: string,
  ctx: TemplateContext,
  options: RenderCmdOptions = {},
): string {
  if (options.allowShellTemplates) {
    // Raw mode: still redact secrets from values, but do not quote.
    return renderPrompt(template, ctx, { redact: true });
  }
  const platform = options.platform ?? process.platform;
  return platform === "win32"
    ? renderCmdWindows(template, ctx, platform)
    : renderCmdPosix(template, ctx, platform);
}

/**
 * POSIX quote / substitution tracker. Unquoted `\` escapes the next character
 * (so `\"` does not open a string). `$(...)` and backticks push a nested
 * unquoted frame, because the shell parses a new quoting context inside them.
 * Unquoted `#` at a word break starts a comment through the next newline.
 * `<<` / `<<-` here-documents collect a body where quotes are literal. A
 * placeholder there is inserted with the original delimiter's expansion
 * rules (escaped in an unquoted document, raw in a quoted one). The
 * delimiter is rewritten when any complete rendered line — including
 * template text already on that line — would close the document.
 */
interface PosixFrame {
  quote: ShellQuoteContext;
  extraParens: number;
  kind: "root" | "cmdsub" | "backtick";
  pendingHeredocs: PendingHeredoc[];
}

interface PendingHeredoc {
  delimiter: string;
  stripTabs: boolean;
  /** True when the original delimiter was quoted (`<<'END'`, `<<"END"`, `<<\END`). */
  quoted: boolean;
  delimOutStart: number;
  delimOutEnd: number;
  closer?: string;
}

function newFrame(kind: PosixFrame["kind"]): PosixFrame {
  return { quote: null, extraParens: 0, kind, pendingHeredocs: [] };
}

function renderCmdPosix(template: string, ctx: TemplateContext, platform: NodeJS.Platform): string {
  const stack: PosixFrame[] = [newFrame("root")];
  const allHeredocs: PendingHeredoc[] = [];
  const top = (): PosixFrame => stack[stack.length - 1]!;
  let out = "";
  let i = 0;
  let comment = false;
  let heredoc: PendingHeredoc | undefined;
  let atLineStart = true;
  /** True when the previous unquoted character was escaped (`foo\ #` is one word). */
  let prevEscaped = false;

  while (i < template.length) {
    if (heredoc) {
      if (atLineStart && atHeredocClose(template, i, heredoc)) {
        if (heredoc.stripTabs) {
          while (template[i] === "\t") i += 1;
        }
        i += heredoc.delimiter.length;
        out += heredoc.closer ?? heredoc.delimiter;
        heredoc = top().pendingHeredocs.shift();
        atLineStart = false;
        continue;
      }
      const ph = matchPlaceholder(template, i);
      if (ph) {
        const value = resolveTemplateValue(ph[1]!.trim(), ctx);
        if (value === undefined) {
          out += ph[0];
        } else {
          const after = i + ph[0].length;
          const nl = template.indexOf("\n", after);
          const suffix = nl === -1 ? template.slice(after) : template.slice(after, nl);
          out = insertHeredocValue(heredoc, allHeredocs, out, redactSecrets(value), suffix);
        }
        i += ph[0].length;
        atLineStart = false;
        continue;
      }
      const ch = template[i]!;
      out += ch;
      i += 1;
      atLineStart = ch === "\n";
      continue;
    }

    const frame = top();
    const ph = matchPlaceholder(template, i);
    if (ph) {
      const value = resolveTemplateValue(ph[1]!.trim(), ctx);
      if (value === undefined) {
        out += ph[0];
      } else if (comment) {
        // A newline would end the comment and execute the rest of the value.
        out += shellQuoteInContext(redactSecrets(value).replace(/[\r\n]/g, " "), null, platform);
      } else {
        out += shellQuoteInContext(redactSecrets(value), frame.quote, platform);
      }
      i += ph[0].length;
      atLineStart = false;
      prevEscaped = false;
      continue;
    }

    const ch = template[i]!;
    const nxt = template[i + 1];

    if (comment) {
      out += ch;
      i += 1;
      prevEscaped = false;
      if (ch === "\n") {
        comment = false;
        atLineStart = true;
        heredoc = frame.pendingHeredocs.shift();
      } else {
        atLineStart = false;
      }
      continue;
    }

    if (frame.quote === "'") {
      if (ch === "'") frame.quote = null;
      out += ch;
      i += 1;
      atLineStart = ch === "\n";
      prevEscaped = false;
      continue;
    }

    if (ch === "\\" && i + 1 < template.length) {
      if (frame.quote === null && (nxt === "\n" || nxt === "\r")) {
        i += nxt === "\r" && template[i + 2] === "\n" ? 3 : 2;
        atLineStart = false;
        continue;
      }
      out += ch + nxt;
      i += 2;
      prevEscaped = frame.quote === null;
      atLineStart = false;
      continue;
    }

    if (frame.quote === '"') {
      if (ch === '"') {
        frame.quote = null;
        out += ch;
        i += 1;
        atLineStart = false;
        prevEscaped = false;
        continue;
      }
    } else if (ch === "'" || ch === '"') {
      frame.quote = ch;
      out += ch;
      i += 1;
      atLineStart = false;
      prevEscaped = false;
      continue;
    }

    if (frame.quote === null && ch === "#" && !prevEscaped && isCommentStart(out)) {
      comment = true;
      out += ch;
      i += 1;
      atLineStart = false;
      prevEscaped = false;
      continue;
    }

    if (ch === "$" && nxt === "(") {
      out += "$(";
      i += 2;
      stack.push(newFrame("cmdsub"));
      atLineStart = false;
      prevEscaped = false;
      continue;
    }

    if (ch === "`") {
      out += ch;
      i += 1;
      atLineStart = false;
      prevEscaped = false;
      if (frame.kind === "backtick" && frame.quote === null) stack.pop();
      else stack.push(newFrame("backtick"));
      continue;
    }

    if (frame.quote === null && ch === "<" && nxt === "<" && template[i + 2] !== "<") {
      const parsed = consumeHeredocOpener(template, i, out.length);
      out += parsed.emitted;
      i = parsed.nextI;
      atLineStart = false;
      prevEscaped = false;
      if (parsed.doc) {
        frame.pendingHeredocs.push(parsed.doc);
        allHeredocs.push(parsed.doc);
      }
      continue;
    }

    if (frame.kind === "cmdsub" && frame.quote === null) {
      if (ch === "(") {
        frame.extraParens += 1;
        out += ch;
        i += 1;
        atLineStart = false;
        prevEscaped = false;
        continue;
      }
      if (ch === ")") {
        if (frame.extraParens > 0) frame.extraParens -= 1;
        else stack.pop();
        out += ch;
        i += 1;
        atLineStart = false;
        prevEscaped = false;
        continue;
      }
    }

    out += ch;
    i += 1;
    prevEscaped = false;
    if (ch === "\n") {
      atLineStart = true;
      heredoc = frame.pendingHeredocs.shift();
    } else {
      atLineStart = false;
    }
  }
  return out;
}

function matchPlaceholder(template: string, i: number): RegExpMatchArray | null {
  return template.slice(i).match(/^\{\{\s*([^{}]+?)\s*\}\}/);
}

/** `#` starts a comment when it begins a word (POSIX token recognition). */
function isCommentStart(out: string): boolean {
  if (out.length === 0) return true;
  // `{` / `}` are not word breaks: `${#param}` is length, not a comment.
  return /[\s;|&()]/.test(out[out.length - 1]!);
}

function atHeredocClose(template: string, i: number, doc: PendingHeredoc): boolean {
  let j = i;
  if (doc.stripTabs) {
    while (template[j] === "\t") j += 1;
  }
  if (!template.startsWith(doc.delimiter, j)) return false;
  const after = template[j + doc.delimiter.length];
  return after === undefined || after === "\n" || after === "\r";
}

function consumeHeredocOpener(
  template: string,
  start: number,
  outLen: number,
): { nextI: number; emitted: string; doc?: PendingHeredoc } {
  let pos = start + 2; // skip <<
  let stripTabs = false;
  if (template[pos] === "-") {
    stripTabs = true;
    pos += 1;
  }
  while (template[pos] === " " || template[pos] === "\t") pos += 1;
  const delimStart = pos;
  let delimiter = "";
  let quoted = false;
  if (template[pos] === "'" || template[pos] === '"') {
    quoted = true;
    const q = template[pos]!;
    pos += 1;
    while (pos < template.length && template[pos] !== q && template[pos] !== "\n") {
      delimiter += template[pos];
      pos += 1;
    }
    if (template[pos] === q) pos += 1;
  } else {
    while (pos < template.length && template[pos] !== "\n" && !/[\s;|&()<>]/.test(template[pos]!)) {
      if (template[pos] === "\\") {
        quoted = true;
        pos += 1;
        if (pos < template.length) {
          delimiter += template[pos];
          pos += 1;
        }
      } else {
        delimiter += template[pos];
        pos += 1;
      }
    }
  }
  const emitted = template.slice(start, pos);
  if (!delimiter) return { nextI: pos, emitted };
  const prefixLen = delimStart - start;
  return {
    nextI: pos,
    emitted,
    doc: {
      delimiter,
      stripTabs,
      quoted,
      delimOutStart: outLen + prefixLen,
      delimOutEnd: outLen + emitted.length,
    },
  };
}

function insertHeredocValue(
  doc: PendingHeredoc,
  all: PendingHeredoc[],
  out: string,
  value: string,
  suffix: string,
): string {
  const closer = doc.closer ?? doc.delimiter;
  const lineStart = out.lastIndexOf("\n") + 1;
  const prefix = out.slice(lineStart);
  const rendered = prefix + value + suffix;
  const next = valueClosesHeredoc(rendered, closer, doc.stripTabs)
    ? rewriteHeredocOpener(doc, all, out, rendered)
    : out;
  return next + (doc.quoted ? value : value.replace(/[\\$`]/g, (ch) => `\\${ch}`));
}

function valueClosesHeredoc(value: string, delimiter: string, stripTabs: boolean): boolean {
  for (const line of value.split(/\r?\n/)) {
    const candidate = stripTabs ? line.replace(/^\t+/, "") : line;
    if (candidate === delimiter) return true;
  }
  return false;
}

function rewriteHeredocOpener(
  doc: PendingHeredoc,
  all: PendingHeredoc[],
  out: string,
  rendered: string,
): string {
  let unique = `STEAMTRAIN_EOF_${randomBytes(16).toString("hex")}`;
  while (valueClosesHeredoc(rendered, unique, doc.stripTabs)) {
    unique = `STEAMTRAIN_EOF_${randomBytes(16).toString("hex")}`;
  }
  const replacement = doc.quoted ? `'${unique}'` : unique;
  const origEnd = doc.delimOutEnd;
  const delta = replacement.length - (origEnd - doc.delimOutStart);
  const next = out.slice(0, doc.delimOutStart) + replacement + out.slice(origEnd);
  doc.delimOutEnd = doc.delimOutStart + replacement.length;
  doc.closer = unique;
  for (const other of all) {
    if (other === doc) continue;
    if (other.delimOutStart >= origEnd) {
      other.delimOutStart += delta;
      other.delimOutEnd += delta;
    }
  }
  return next;
}

function renderCmdWindows(
  template: string,
  ctx: TemplateContext,
  platform: NodeJS.Platform,
): string {
  let out = "";
  let quote: ShellQuoteContext = null;
  let i = 0;
  while (i < template.length) {
    const ph = template.slice(i).match(/^\{\{\s*([^{}]+?)\s*\}\}/);
    if (ph) {
      const value = resolveTemplateValue(ph[1]!.trim(), ctx);
      out +=
        value === undefined ? ph[0] : shellQuoteInContext(redactSecrets(value), quote, platform);
      i += ph[0].length;
      continue;
    }
    const ch = template[i]!;
    if (quote === '"' && ch === '"' && template[i + 1] === '"') {
      out += '""';
      i += 2;
      continue;
    }
    if (ch === '"') quote = quote === '"' ? null : '"';
    out += ch;
    i += 1;
  }
  return out;
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
  if (kind === "command" && "env" in step && step.env && typeof step.env === "object") {
    for (const value of Object.values(step.env as Record<string, string>)) {
      refs.push(...extractRefs(value));
    }
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

        // {{steps.<id>.<field>}} — json/worktree/artifact MUST be matched
        // before STEP_FIELD; its greedy id group also eats `json.output`.
        if (!ref.startsWith("steps.")) continue;
        const jsonMatch = STEP_JSON_FIELD.exec(ref);
        if (jsonMatch) {
          const refId = jsonMatch[1] as string;
          if (!stepIds.has(refId)) {
            warnings.push(`step '${step.id}' references unknown step '${refId}'`);
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

  // Command steps run through the platform shell. By default interpolated
  // values are shell-quoted; `allowShellTemplates: true` opts into raw
  // Makefile-style expansion and is flagged as such (see SECURITY.md).
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
      if (risky.length === 0) continue;
      const allowRaw =
        "allowShellTemplates" in step &&
        (step as { allowShellTemplates?: boolean }).allowShellTemplates === true;
      if (allowRaw) {
        warnings.push(
          `step '${step.id}' is a command step with allowShellTemplates whose cmd embeds template data ({{${risky[0]}}}); values are interpolated into the shell unsanitized — review like a Makefile`,
        );
      } else {
        warnings.push(
          `step '${step.id}' is a command step whose cmd embeds template data ({{${risky[0]}}}); values are shell-quoted on expansion — prefer templated env vars for structured data`,
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
