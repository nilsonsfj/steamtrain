import { z } from "zod";
import type { AgentId } from "../types/events";

const agentId = z.string().min(1);

/** Reserved for the built-in workflow mode; cannot be used as a workspace id. */
export const RESERVED_WORKSPACE_ID = "workflow";

export function isReservedWorkspaceId(id: string): boolean {
  return id === RESERVED_WORKSPACE_ID;
}

export const workspaceEntrySchema = z.object({
  id: z.string().min(1),
  /** Display label in the mode bar; defaults to `id`. */
  label: z.string().min(1).optional(),
  agent: agentId,
  model: z.string().min(1),
  /** Reasoning effort / variant passed to the agent CLI when set. */
  effort: z.string().min(1).optional(),
});

export type WorkspaceEntry = z.infer<typeof workspaceEntrySchema>;

export interface WorkspaceConfig {
  workspaces: WorkspaceEntry[];
}

export type WorkspaceId = WorkspaceEntry["id"];

/** Schema for a (partial) `~/.steamtrain/workspace.json` — merged onto defaults. */
export const workspaceFileSchema = z
  .object({
    workspaces: z.array(workspaceEntrySchema).optional(),
  })
  .strict();

export type WorkspaceFile = z.infer<typeof workspaceFileSchema>;

export function workspaceLabel(entry: WorkspaceEntry): string {
  return entry.label ?? entry.id;
}

export function workspaceById(config: WorkspaceConfig): Map<WorkspaceId, WorkspaceEntry> {
  return new Map(config.workspaces.map((w) => [w.id, w]));
}

export function workspaceIds(config: WorkspaceConfig): WorkspaceId[] {
  return config.workspaces.map((w) => w.id);
}
