/** Static Codex effort heuristics when `codex debug models` is unavailable. */

const GPT_56_SOL_TERRA_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
const GPT_56_LUNA_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const GPT_55_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
const AUTO_REVIEW_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
const GPT_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;

/** Fallback effort levels derived from Codex model slug patterns. */
export function fallbackCodexEfforts(model: string): readonly string[] {
  const slug = model.toLowerCase();

  if (slug === "codex-auto-review") return AUTO_REVIEW_EFFORTS;
  if (slug === "gpt-6-luna" || slug.startsWith("gpt-6-luna-")) return GPT_56_LUNA_EFFORTS;
  if (slug.startsWith("gpt-6")) return GPT_56_SOL_TERRA_EFFORTS;
  if (slug === "gpt-5.6-sol" || slug.startsWith("gpt-5.6-sol-")) return GPT_56_SOL_TERRA_EFFORTS;
  if (slug === "gpt-5.6-terra" || slug.startsWith("gpt-5.6-terra-"))
    return GPT_56_SOL_TERRA_EFFORTS;
  if (slug === "gpt-5.6-luna" || slug.startsWith("gpt-5.6-luna-")) return GPT_56_LUNA_EFFORTS;
  if (slug.startsWith("gpt-5.6")) return GPT_56_LUNA_EFFORTS;
  if (slug === "gpt-5.5" || slug.startsWith("gpt-5.5-")) return GPT_55_EFFORTS;
  if (slug.startsWith("gpt-5.4") || slug.startsWith("gpt-5.2")) return GPT_55_EFFORTS;
  if (slug.startsWith("gpt-5")) return GPT_REASONING_EFFORTS;
  if (slug.startsWith("gpt-")) return GPT_REASONING_EFFORTS;

  return [];
}
