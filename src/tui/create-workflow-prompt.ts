import { isSlashCommandInput } from "../commands/parse";

const CREATE_WORKFLOW_PREFIX = "/createworkflow ";

/**
 * The prompt value to focus when the user triggers workflow creation from the
 * picker (the "+ Create" row or Ctrl+N), given whatever is already typed.
 *
 * - Empty / whitespace seed → bare `/createworkflow ` (teaches the command).
 * - Plain text → wrapped as `/createworkflow <text>` so a confirming Enter runs.
 * - A seed that is *already* a slash command (a half-typed `/createworkflow …`
 *   or an unrelated `/model …`) is returned untouched — wrapping it would
 *   produce a malformed `/createworkflow /…` and clobber in-progress input.
 */
export function createWorkflowPromptValue(seed: string): string {
  const trimmed = seed.trim();
  if (isSlashCommandInput(trimmed)) return seed;
  return trimmed ? `${CREATE_WORKFLOW_PREFIX}${trimmed}` : CREATE_WORKFLOW_PREFIX;
}
