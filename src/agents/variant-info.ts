/** Shared model metadata shape used by both codex and opencode variant caches. */
export interface VariantModelInfo {
  name: string;
  efforts: readonly string[];
}
