/** Static Kimi Code effort heuristics when `kimi provider list --json` is unavailable. */

const KIMI_K3_EFFORTS = ["low", "high", "max"] as const;

/**
 * K3 aliases declare thinking efforts (`supportEfforts` in the live catalog);
 * the K2.7 Coding aliases report none. Without cache metadata we only claim
 * efforts for known K3 aliases.
 */
export function fallbackKimiEfforts(model: string): readonly string[] {
  return model === "kimi-code/k3" || model === "kimi-code/k3-256k" ? KIMI_K3_EFFORTS : [];
}
