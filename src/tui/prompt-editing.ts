import type { Mode } from "./modes";

/** Workflow mode shows a list above the prompt; arrows default to that list. */
export function workflowListNavigation(mode: Mode): boolean {
  return mode === "workflow";
}
