/** Static Kimi Code effort heuristics when `kimi provider list --json` is unavailable. */

const KIMI_K3_EFFORTS = ["low", "high", "max"] as const;

/**
 * Only `kimi-code/k3` declares thinking efforts (`supportEfforts` in the live
 * catalog); the K2.7 Coding aliases report none. Without cache metadata we
 * only claim efforts for that known alias.
 */
export function fallbackKimiEfforts(model: string): readonly string[] {
  return model === "kimi-code/k3" ? KIMI_K3_EFFORTS : [];
}
