import type { Mode } from "../tui/modes";
import type { AgentId } from "../types/events";
import type { WorkspaceConfig, WorkspaceEntry, WorkspaceId } from "../workspace";

/** Selected agent-backed step in the workflow preview drill-down. */
export interface WorkflowStepSelection {
  workflowName: string;
  stepId: string;
  agent: AgentId;
  model: string;
  effort?: string;
}

export interface SlashCommandNotice {
  level: "info" | "warn" | "error";
  text: string;
}

export type SlashCommandResult =
  | { handled: true; clearInput?: boolean; notices?: SlashCommandNotice[]; exit?: boolean }
  | { handled: false };

/** Context passed to slash commands from the TUI. */
export interface SlashCommandContext {
  mode: Mode;
  modes: readonly Mode[];
  workspaces: WorkspaceConfig;
  workspaceMap: Map<WorkspaceId, WorkspaceEntry>;
  /** Update a workspace entry in the live (session) config. */
  updateWorkspace: (id: WorkspaceId, patch: Partial<WorkspaceEntry>) => void;
  setMode: (mode: Mode) => void;
  version: string;
  /** Set when workflow preview has an agent-backed step selected. */
  workflowStep?: WorkflowStepSelection;
  /** Patch agent/model/effort on a workflow step (session-only). */
  updateWorkflowStep?: (
    stepId: string,
    patch: Partial<Pick<WorkflowStepSelection, "agent" | "model" | "effort">>,
  ) => void;
  /** Persist session workflow overrides to the user workflows file. */
  saveWorkflows?: () => SlashCommandResult;
  /** Start LLM-delegated generation of a new workflow from a description (TUI only). */
  createWorkflow?: (description: string) => SlashCommandResult;
  /** Save the selected workflow under a new name as a user copy (TUI only). */
  cloneWorkflow?: (newName: string) => SlashCommandResult;
  /** Delete a user workflow by name from `~/.steamtrain/workflows.json` (TUI only). */
  deleteWorkflow?: (name: string) => SlashCommandResult;
  /** Names of user-source workflows (for `/deleteworkflow` completion). */
  userWorkflowNames?: readonly string[];
}

export interface SlashCommand {
  /** Command name without the leading slash (e.g. `exit`). */
  readonly name: string;
  readonly description: string;
  readonly usage?: string;
  execute(args: string[], ctx: SlashCommandContext): SlashCommandResult;
  /** Return argument completions for the given token index (0 = first arg after command). */
  complete?(args: string[], ctx: SlashCommandContext): readonly string[];
}

export interface ParsedSlashInput {
  command: string;
  args: string[];
  /** Raw token being typed for the active argument (may be partial). */
  activeArg: string;
  /** Index of the argument being completed (0-based, after command name). */
  activeArgIndex: number;
}
