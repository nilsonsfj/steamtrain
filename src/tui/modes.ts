import type { WorkspaceConfig } from "../workspace";
import { isReservedWorkspaceId, workspaceIds } from "../workspace";

/** `workflow` or a workspace id from `~/.steamtrain/workspace.json`. */
export type Mode = "workflow" | (string & {});

export function buildModes(workspaces: WorkspaceConfig): readonly Mode[] {
  return ["workflow", ...workspaceIds(workspaces).filter((id) => !isReservedWorkspaceId(id))];
}

export function isWorkspaceMode(mode: Mode): mode is string {
  return mode !== "workflow";
}

export function nextMode(current: Mode, modes: readonly Mode[]): Mode {
  const idx = modes.indexOf(current);
  return modes[(idx + 1) % modes.length] ?? current;
}

/** Screen flags that hide the workflow picker even though `mode` is "workflow". */
export interface WorkflowScreenState {
  mode: Mode;
  history: boolean;
  wfCreate: boolean;
  /** A preview screen is actually rendering (its spec resolved), not merely selected. */
  previewing: boolean;
  showWorkflowView: boolean;
}

/**
 * Whether the workflow picker is the visible screen — the only place `/model`
 * targets the drafting model. In workflow mode the picker is hidden while
 * browsing history, drafting (create panel), previewing, or running a workflow;
 * in those states `/model` keeps its legacy "select a step" warning. `previewing`
 * is the resolved-preview flag (not raw `wfPreview`), so a stale selection whose
 * spec no longer resolves — where the picker falls through and renders — still
 * counts as the picker.
 */
export function isWorkflowPickerActive(s: WorkflowScreenState): boolean {
  return s.mode === "workflow" && !s.history && !s.wfCreate && !s.previewing && !s.showWorkflowView;
}
