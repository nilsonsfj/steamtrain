import { isSlashCommandInput } from "../commands/parse";

/** True when Enter should apply the highlighted suggestion instead of submitting. */
export function shouldApplySuggestionOnSubmit(
  suggestions: readonly string[],
  raw: string,
): boolean {
  return suggestions.length > 1 && isSlashCommandInput(raw);
}

/** True when Esc should dismiss the completion menu instead of other actions. */
export function shouldDismissSuggestionMenu(suggestions: readonly string[], raw: string): boolean {
  return suggestions.length > 1 && isSlashCommandInput(raw);
}

/** True when workflow ↑/↓ navigation should be suppressed. */
export function shouldSuppressWorkflowNavigation(
  suggestions: readonly string[],
  raw: string,
): boolean {
  return suggestions.length > 1 && isSlashCommandInput(raw);
}
