/**
 * Reasoning menus advertised by Grok Build when `grok models` is unavailable.
 *
 * The text catalog lists ids only. These match the menus Grok 4.5–4.7 publish
 * (`low` / `medium` / `high`, plus `xhigh` from 4.6 on). A model that is not
 * in this set gets no effort picker until a live catalog says otherwise.
 */
const GROK_45_EFFORTS = ["low", "medium", "high"] as const;
const GROK_FRONTIER_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

export function fallbackGrokEfforts(modelId: string): readonly string[] {
  const id = modelId.trim();
  if (id === "grok-4.5") return GROK_45_EFFORTS;
  // 4.6+ and later major versions share the frontier menu, including suffixed
  // ids such as `grok-4.7-build-fast`.
  if (/^grok-4\.(?:[6-9]|[1-9]\d)/.test(id) || /^grok-[5-9]/.test(id)) {
    return GROK_FRONTIER_EFFORTS;
  }
  return [];
}
