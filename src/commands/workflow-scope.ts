import type { WorkflowScope } from "../workflow";

/**
 * Pull a `--project` / `--scope <user|project>` flag out of a command's
 * arguments, returning the chosen scope (default `user`) and the remaining
 * positional args. Lets `/createworkflow` and `/cloneworkflow` target the
 * project layer (`./steamtrain.json`) without disturbing their free-text args.
 */
export function extractWorkflowScope(args: string[]): { scope: WorkflowScope; rest: string[] } {
  let scope: WorkflowScope = "user";
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--project") {
      scope = "project";
    } else if (arg === "--user") {
      scope = "user";
    } else if (arg === "--scope") {
      const value = args[i + 1];
      if (value === "project" || value === "user") {
        scope = value;
        i += 1;
      }
    } else if (arg !== undefined) {
      rest.push(arg);
    }
  }
  return { scope, rest };
}
