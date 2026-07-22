/** Static MiMo effort heuristics when `mimo models --verbose` is unavailable. */

const MIMO_REASONING_EFFORTS = ["low", "medium", "high"] as const;

/**
 * MiMo's built-in models (`mimo/mimo-auto`, `xiaomi/mimo-v2.5*`) all expose
 * low/medium/high variants. Custom providers may appear after a live refresh;
 * without cache metadata we only claim efforts for known Xiaomi/MiMo ids.
 */
export function fallbackMimoEfforts(model: string): readonly string[] {
  const slash = model.indexOf("/");
  if (slash === -1) return [];
  const provider = model.slice(0, slash).toLowerCase();
  const id = model.slice(slash + 1).toLowerCase();

  if (provider === "mimo" || provider === "xiaomi") {
    if (id.startsWith("mimo-")) return MIMO_REASONING_EFFORTS;
  }
  return [];
}
