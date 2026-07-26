/**
 * Regex safety helpers (ReDoS defense).
 *
 * Gate `matches` patterns and JSON Schema `pattern` fields can come from
 * workflow specs or (for gates) prior step output via templates. Catastrophic
 * backtracking like `(a+)+$` can freeze the event loop — reject those shapes
 * before compiling, and cap subject length at match time.
 */

/** Hard cap on pattern source length (chars). */
export const MAX_SAFE_REGEX_PATTERN_LENGTH = 256;

/** Hard cap on the text fed to `.test()` / `.exec()`. */
export const MAX_SAFE_REGEX_SUBJECT_LENGTH = 100_000;

/**
 * Heuristic: nested quantifiers (`(a+)+`, `(a|b)*?`, `([ab]*)+`, …) are the
 * classic exponential-backtracking shape. Also rejects unbounded repeats of
 * quantified groups via `{n,}` nesting. This is not a full star-height
 * analysis — it errs toward rejecting suspicious patterns.
 */
const NESTED_QUANTIFIER =
  /(\((?:[^()\\]|\\.)*[+*{](?:[^()\\]|\\.)*\)[*+{])|(\[[^\]]*\][*+{]\s*[)\]}]?\s*[*+{])/;

/**
 * Overlapping alternation inside a quantified group, e.g. `(a|a)+` /
 * `(a|ab)+` — another common ReDoS family. Cheap structural reject.
 */
const OVERLAPPING_ALTERNATION = /\((?:[^()\\]|\\.)+\|(?:[^()\\]|\\.)+\)[+*{]/;

export type SafeRegexResult = { ok: true; regex: RegExp } | { ok: false; error: string };

/** True when `pattern` looks safe enough to compile and run against untrusted text. */
export function isSafeRegexPattern(pattern: string): boolean {
  if (pattern.length === 0) return false;
  if (pattern.length > MAX_SAFE_REGEX_PATTERN_LENGTH) return false;
  if (NESTED_QUANTIFIER.test(pattern)) return false;
  if (OVERLAPPING_ALTERNATION.test(pattern)) return false;
  try {
    // Compile once to catch SyntaxError; flags are never user-controlled here.
    void new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compile `pattern` if safe. Returns a structured error instead of throwing
 * for invalid / unsafe patterns.
 */
export function compileSafeRegex(pattern: string): SafeRegexResult {
  if (pattern.length === 0) {
    return { ok: false, error: "regex pattern is empty" };
  }
  if (pattern.length > MAX_SAFE_REGEX_PATTERN_LENGTH) {
    return {
      ok: false,
      error: `regex pattern exceeds ${MAX_SAFE_REGEX_PATTERN_LENGTH} character limit`,
    };
  }
  if (NESTED_QUANTIFIER.test(pattern) || OVERLAPPING_ALTERNATION.test(pattern)) {
    return {
      ok: false,
      error: "regex pattern looks vulnerable to catastrophic backtracking",
    };
  }
  try {
    return { ok: true, regex: new RegExp(pattern) };
  } catch (err) {
    return {
      ok: false,
      error: `invalid regex: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Test `text` against a safe-compiled `pattern`. Subjects longer than
 * {@link MAX_SAFE_REGEX_SUBJECT_LENGTH} are truncated before matching so a
 * huge step output cannot amplify a borderline pattern.
 */
export function safeRegexTest(
  pattern: string,
  text: string,
): SafeRegexResult & { matched?: boolean } {
  const compiled = compileSafeRegex(pattern);
  if (!compiled.ok) return compiled;
  const subject =
    text.length > MAX_SAFE_REGEX_SUBJECT_LENGTH
      ? text.slice(0, MAX_SAFE_REGEX_SUBJECT_LENGTH)
      : text;
  return { ok: true, regex: compiled.regex, matched: compiled.regex.test(subject) };
}
