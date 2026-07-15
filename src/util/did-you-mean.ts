/**
 * Nearest-name suggestion for "unknown X" error messages, shared by the CLI
 * (workflow names) and the TUI (slash commands).
 */

/** Levenshtein distance, capped: returns cap+1 as soon as the result exceeds cap. */
function editDistance(a: string, b: string, cap: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const cost = Math.min((prev[j] ?? 0) + 1, (next[j - 1] ?? 0) + 1, substitution);
      next.push(cost);
      if (cost < rowMin) rowMin = cost;
    }
    if (rowMin > cap) return cap + 1;
    prev = next;
  }
  return prev[b.length] ?? cap + 1;
}

/**
 * The candidate closest to `input`, or undefined when nothing is plausibly a
 * typo of it. Prefers a unique-feeling prefix match ("hist" → "history"), then
 * small edit distances ("hlep" → "help"). Case-insensitive.
 */
export function closestMatch(input: string, candidates: readonly string[]): string | undefined {
  const needle = input.toLowerCase();
  if (needle.length === 0) return undefined;

  if (needle.length >= 2) {
    const prefixed = candidates
      .filter((c) => c.toLowerCase().startsWith(needle))
      .sort((x, y) => x.length - y.length || x.localeCompare(y));
    if (prefixed[0]) return prefixed[0];
  }

  const cap = needle.length <= 3 ? 1 : 2;
  let best: string | undefined;
  let bestDistance = cap + 1;
  for (const candidate of candidates) {
    const distance = editDistance(needle, candidate.toLowerCase(), cap);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}
