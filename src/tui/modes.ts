import type { WorkspaceConfig } from "../workspace";
import { workspaceIds } from "../workspace";

/** `workflow` or a workspace id from `~/.steamtrain/workspace.json`. */
export type Mode = "workflow" | (string & {});

export function buildModes(workspaces: WorkspaceConfig): readonly Mode[] {
  return ["workflow", ...workspaceIds(workspaces)];
}

export function isWorkspaceMode(mode: Mode): mode is string {
  return mode !== "workflow";
}

export function nextMode(current: Mode, modes: readonly Mode[]): Mode {
  const idx = modes.indexOf(current);
  return modes[(idx + 1) % modes.length] ?? current;
}
