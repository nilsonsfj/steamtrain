/**
 * Structured step outputs: a step may declare an `output` JSON schema. The
 * agent is prompted to end its reply with JSON matching the schema; the engine
 * extracts, parses, and validates it (with one bounded "fix your JSON" retry)
 * and stores the parsed value on `StepResult.json` for templates
 * (`{{steps.<id>.json.<path>}}`), gate `path` conditions, and distributor
 * array fan-out.
 *
 * The validator implements a deliberate JSON Schema *subset* — enough for
 * verdicts, lists, and scores without pulling in a full validator dependency:
 * `type`, `enum`, `const`, `properties`, `required`,
 * `additionalProperties: false`, `items`, `minItems`/`maxItems`,
 * `minLength`/`maxLength`, `pattern`, `minimum`/`maximum`. Unknown keywords
 * are ignored, matching JSON Schema's own convention.
 */

import { stripAnsi } from "../text";
import { safeRegexTest } from "../util/safe-regex";

/** A JSON Schema object (subset; see module docs for supported keywords). */
export type JsonSchema = Record<string, unknown>;

/** Cap on reported validation issues so a huge mismatched payload stays readable. */
const MAX_ISSUES = 10;
/** Cap on the previous-output excerpt echoed back in the fix prompt. */
const FIX_PROMPT_OUTPUT_CAP = 4000;

// ---------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------

function tryParse(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

/**
 * Top-level balanced `{…}` / `[…]` spans in `text`, in order. Tracks string
 * and escape state so braces inside JSON strings don't end a span early.
 */
function balancedJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (start === -1) {
      if (ch === "{" || ch === "[") {
        start = i;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) {
        candidates.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return candidates;
}

/**
 * Find the JSON value an agent reply contains. ANSI escape sequences are
 * stripped first: plain-text CLIs (kiro headless chat) style their markdown
 * even on a pipe, and a `\x1b[…m` color code contains a `[` that otherwise
 * hijacks the balanced-span scanner (SGR sequences never close the bracket,
 * so the real JSON gets swallowed into an unterminated candidate). Tries, in
 * order: the whole (trimmed) text; fenced ``` blocks, last first (agents put
 * the final answer last); top-level balanced `{…}`/`[…]` spans, last
 * parseable first. Returns undefined when nothing parses.
 */
export function extractJsonValue(text: string): { value: unknown } | undefined {
  const trimmed = stripAnsi(text).trim();
  if (!trimmed) return undefined;
  const direct = tryParse(trimmed);
  if (direct) return direct;
  const fences = [...trimmed.matchAll(/```(?:json)?[^\S\n]*\n([\s\S]*?)```/gi)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const parsed = tryParse((fences[i]?.[1] ?? "").trim());
    if (parsed) return parsed;
  }
  const candidates = balancedJsonCandidates(trimmed);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const parsed = tryParse(candidates[i] as string);
    if (parsed) return parsed;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Schema validation (subset)
// ---------------------------------------------------------------------------

function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value: unknown, declared: string): boolean {
  if (declared === "integer") return typeof value === "number" && Number.isInteger(value);
  return jsonTypeOf(value) === declared;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate `value` against the supported JSON Schema subset. Returns
 * human-readable issues like `$.verdict: expected string, got number`; empty
 * means valid. Unknown/unsupported keywords are ignored.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  path = "$",
  issues: string[] = [],
): string[] {
  if (issues.length >= MAX_ISSUES) return issues;
  const add = (message: string): void => {
    if (issues.length < MAX_ISSUES) issues.push(`${path}: ${message}`);
  };

  const declaredType = schema.type;
  if (typeof declaredType === "string" || Array.isArray(declaredType)) {
    const types = (Array.isArray(declaredType) ? declaredType : [declaredType]).filter(
      (t): t is string => typeof t === "string",
    );
    if (types.length > 0 && !types.some((t) => matchesType(value, t))) {
      add(`expected ${types.join(" or ")}, got ${jsonTypeOf(value)}`);
      return issues; // structural mismatch — deeper checks would just cascade
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((option) => deepEqual(option, value))) {
    add(`expected one of ${schema.enum.map((o) => JSON.stringify(o)).join(", ")}`);
  }
  if (schema.const !== undefined && !deepEqual(schema.const, value)) {
    add(`expected ${JSON.stringify(schema.const)}`);
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      add(`string is shorter than minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      add(`string is longer than maxLength ${schema.maxLength}`);
    }
    if (typeof schema.pattern === "string") {
      const match = safeRegexTest(schema.pattern, value);
      if (!match.ok) {
        // Unsafe / invalid patterns are treated as a schema error rather than
        // silently ignored — an imported workflow must not ship ReDoS bombs.
        add(`string pattern is unsafe or invalid: ${match.error}`);
      } else if (!match.matched) {
        add(`string does not match pattern ${schema.pattern}`);
      }
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      add(`number is below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      add(`number is above maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      add(`array has fewer than minItems ${schema.minItems}`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      add(`array has more than maxItems ${schema.maxItems}`);
    }
    if (isPlainObject(schema.items)) {
      for (let i = 0; i < value.length; i++) {
        if (issues.length >= MAX_ISSUES) break;
        validateAgainstSchema(value[i], schema.items, `${path}[${i}]`, issues);
      }
    }
  }

  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : undefined;
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !(key in value)) add(`missing required property '${key}'`);
      }
    }
    if (properties) {
      for (const [key, propSchema] of Object.entries(properties)) {
        if (issues.length >= MAX_ISSUES) break;
        if (key in value && isPlainObject(propSchema)) {
          validateAgainstSchema(value[key], propSchema, `${path}.${key}`, issues);
        }
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in properties)) add(`unexpected property '${key}'`);
        }
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Parse + validate
// ---------------------------------------------------------------------------

export type StructuredParseResult = { ok: true; value: unknown } | { ok: false; error: string };

/** Extract JSON from `text` and validate it against `schema`. */
export function parseStructuredOutput(text: string, schema: JsonSchema): StructuredParseResult {
  const extracted = extractJsonValue(text);
  if (!extracted) return { ok: false, error: "no parseable JSON found in the step output" };
  const issues = validateAgainstSchema(extracted.value, schema);
  if (issues.length > 0) {
    return { ok: false, error: `JSON does not match the output schema: ${issues.join("; ")}` };
  }
  return { ok: true, value: extracted.value };
}

// ---------------------------------------------------------------------------
// JSON path access ({{steps.<id>.json.<path>}}, gate `path`, itemsPath)
// ---------------------------------------------------------------------------

/**
 * Parse a field path like `verdict`, `targets[2]`, `[0].name`, or
 * `report.items[1].severity` into segments. Returns undefined for malformed
 * paths (unclosed/non-numeric brackets).
 */
export function parseJsonPath(path: string): (string | number)[] | undefined {
  const segments: (string | number)[] = [];
  let i = 0;
  while (i < path.length) {
    const ch = path[i];
    if (ch === ".") {
      i += 1;
      continue;
    }
    if (ch === "[") {
      const end = path.indexOf("]", i);
      if (end === -1) return undefined;
      const raw = path.slice(i + 1, end);
      if (!/^\d+$/.test(raw)) return undefined;
      segments.push(Number.parseInt(raw, 10));
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < path.length && path[j] !== "." && path[j] !== "[") j += 1;
    segments.push(path.slice(i, j));
    i = j;
  }
  return segments;
}

/** Resolve `path` against a parsed JSON value; undefined when any hop is missing. */
export function jsonPathGet(value: unknown, path: string): unknown {
  const segments = parseJsonPath(path);
  if (!segments) return undefined;
  let current: unknown = value;
  for (const segment of segments) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
    } else {
      if (!isPlainObject(current)) return undefined;
      current = current[segment];
    }
    if (current === undefined) return undefined;
  }
  return current;
}

/**
 * Render a JSON field as template/gate text: strings stay raw (so
 * `equals: "pass"` matches `"pass"` without quotes), everything else is
 * JSON-serialized, and a missing value is empty text.
 */
export function jsonFieldText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/** Append the "emit JSON matching this schema" contract to a rendered prompt. */
export function withStructuredOutputInstructions(prompt: string, schema: JsonSchema): string {
  return [
    prompt,
    "",
    "## Required output format",
    "End your reply with a single JSON value that matches this JSON Schema:",
    "",
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
    "",
    "Emit the JSON itself (optionally inside a ```json fenced block) as the last thing in your reply, with no text after it.",
  ].join("\n");
}

/**
 * The one bounded "fix your JSON" retry prompt: the schema, what was wrong,
 * and a capped excerpt of the previous reply to correct.
 */
export function structuredOutputFixPrompt(
  schema: JsonSchema,
  previousOutput: string,
  error: string,
): string {
  const excerpt =
    previousOutput.length > FIX_PROMPT_OUTPUT_CAP
      ? `${previousOutput.slice(0, FIX_PROMPT_OUTPUT_CAP)}\n… (truncated)`
      : previousOutput;
  return [
    "Your previous reply did not contain valid JSON matching the required schema.",
    "",
    `Problem: ${error}`,
    "",
    "Required JSON Schema:",
    "",
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
    "",
    "Your previous reply was:",
    '"""',
    excerpt,
    '"""',
    "",
    "Reply with ONLY a corrected JSON value that matches the schema — no commentary before or after it.",
  ].join("\n");
}
