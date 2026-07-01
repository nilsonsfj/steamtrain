import { isSlashCommandInput } from "../commands/parse";

const CREATE_WORKFLOW_PREFIX = "/create-workflow ";

/**
 * The prompt value to focus when the user triggers workflow creation from the
 * picker (the "+ Create" row or Ctrl+N), given whatever is already typed.
 *
 * - Empty / whitespace / a lone `/` seed → bare `/create-workflow ` (teaches the
 *   command; a lone `/` carries no command yet, so honor the create intent
 *   rather than stranding the user on a slash).
 * - Plain text → wrapped as `/create-workflow <text>` so a confirming Enter runs.
 * - A seed that is *already* a slash command (a half-typed `/create-workflow …`
 *   or an unrelated `/model …`) is returned untouched — wrapping it would
 *   produce a malformed `/create-workflow /…` and clobber in-progress input.
 */
export function createWorkflowPromptValue(seed: string): string {
  const trimmed = seed.trim();
  if (trimmed === "" || trimmed === "/") return CREATE_WORKFLOW_PREFIX;
  if (isSlashCommandInput(trimmed)) return seed;
  return `${CREATE_WORKFLOW_PREFIX}${trimmed}`;
}
