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

/** Bound the compiled-regex cache so looped gates cannot grow it unboundedly. */
const SAFE_REGEX_CACHE_LIMIT = 64;

/**
 * Heuristic: nested quantifiers (`(a+)+`, `(a|b)*?`, `([ab]*)+`, …) are the
 * classic exponential-backtracking shape. Also rejects unbounded repeats of
 * quantified groups via `{n,}` nesting. This is not a full star-height
 * analysis — it errs toward rejecting suspicious patterns.
 */
const NESTED_QUANTIFIER =
  /(\((?:[^()\\]|\\.)*[+*{](?:[^()\\]|\\.)*\)[*+{])|(\[[^\]]*\][*+{]\s*[)\]}]?\s*[*+{])/;

/**
 * Quantified group containing `|` — `(a|a)+`, `(a|b|c)*`, `(foo|bar|foo){2,}`.
 * Any quantified group with an alternation is treated as suspicious. The second
 * `(?:[^()\\]|\\.)*` greedily absorbs further `|`-separated branches, so this
 * covers every branch count (not just two). Overlapping branches are the real
 * ReDoS family; enumerating every pair is not worth the complexity for a cheap
 * structural reject.
 */
const QUANTIFIED_ALTERNATION = /\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)[+*{]/;

export type SafeRegexResult = { ok: true; regex: RegExp } | { ok: false; error: string };

const compiledCache = new Map<string, SafeRegexResult>();

function looksUnsafe(pattern: string): boolean {
  return NESTED_QUANTIFIER.test(pattern) || QUANTIFIED_ALTERNATION.test(pattern);
}

/** True when `pattern` looks safe enough to compile and run against untrusted text. */
export function isSafeRegexPattern(pattern: string): boolean {
  return compileSafeRegex(pattern).ok;
}

/**
 * Compile `pattern` if safe. Returns a structured error instead of throwing
 * for invalid / unsafe patterns. Successful (and failed-unsafe) results are
 * cached so looped gate conditions do not recompile the same pattern.
 */
export function compileSafeRegex(pattern: string): SafeRegexResult {
  const cached = compiledCache.get(pattern);
  if (cached) return cached;

  let result: SafeRegexResult;
  if (pattern.length === 0) {
    result = { ok: false, error: "regex pattern is empty" };
  } else if (pattern.length > MAX_SAFE_REGEX_PATTERN_LENGTH) {
    result = {
      ok: false,
      error: `regex pattern exceeds ${MAX_SAFE_REGEX_PATTERN_LENGTH} character limit`,
    };
  } else if (looksUnsafe(pattern)) {
    result = {
      ok: false,
      error: "regex pattern looks vulnerable to catastrophic backtracking",
    };
  } else {
    try {
      result = { ok: true, regex: new RegExp(pattern) };
    } catch (err) {
      result = {
        ok: false,
        error: `invalid regex: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (compiledCache.size >= SAFE_REGEX_CACHE_LIMIT) {
    // Drop the oldest entry (Map insertion order).
    const oldest = compiledCache.keys().next().value;
    if (oldest !== undefined) compiledCache.delete(oldest);
  }
  compiledCache.set(pattern, result);
  return result;
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

/** Test-only: clear the compile cache between cases. */
export function clearSafeRegexCacheForTests(): void {
  compiledCache.clear();
}
