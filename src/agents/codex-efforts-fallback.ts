/** Static Codex effort heuristics when `codex debug models` is unavailable. */

const GPT_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
const GPT_55_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
const AUTO_REVIEW_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

/** Fallback effort levels derived from Codex model slug patterns. */
export function fallbackCodexEfforts(model: string): readonly string[] {
  const slug = model.toLowerCase();

  if (slug === "codex-auto-review") return AUTO_REVIEW_EFFORTS;
  if (slug === "gpt-5.5" || slug.startsWith("gpt-5.5-")) return GPT_55_EFFORTS;
  if (slug.startsWith("gpt-5")) return GPT_REASONING_EFFORTS;
  if (slug.startsWith("gpt-")) return GPT_REASONING_EFFORTS;

  return [];
}
