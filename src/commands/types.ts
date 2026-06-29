import type { ProjectConfigPatch } from "../config/project-config";
import type { SteamtrainConfig } from "../config/types";
import type { Mode } from "../tui/modes";
import type { AgentId } from "../types/events";
import type { WorkflowScope, WorkflowSpec } from "../workflow";
import type { WorkspaceConfig, WorkspaceEntry, WorkspaceId } from "../workspace";

/** Selected agent-backed step in the workflow preview drill-down. */
export interface WorkflowStepSelection {
  workflowName: string;
  stepId: string;
  agent: AgentId;
  model: string;
  effort?: string;
  stepTimeoutSec?: number;
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
  /** Patch agent/model/effort/timeout on a workflow step (session-only). */
  updateWorkflowStep?: (
    stepId: string,
    patch: Partial<Pick<WorkflowStepSelection, "agent" | "model" | "effort" | "stepTimeoutSec">>,
  ) => void;
  /** Active workflow spec when previewing or configuring (for /timeout, etc.). */
  workflowSpec?: WorkflowSpec;
  /** Live project config (timeouts, concurrency, …). */
  config?: SteamtrainConfig;
  /** Resolved project `steamtrain.json` path, when writable. */
  configPath?: string;
  /** Persist timeout-related project config keys. */
  updateConfig?: (patch: ProjectConfigPatch) => { ok: boolean; error?: string };
  /** Persist session workflow overrides to the user workflows file. */
  saveWorkflows?: () => SlashCommandResult | Promise<SlashCommandResult>;
  /** Start LLM-delegated generation of a new workflow from a description (TUI only). */
  createWorkflow?: (description: string, scope?: WorkflowScope) => SlashCommandResult;
  /** Save the selected workflow under a new name (user or project copy) (TUI only). */
  cloneWorkflow?: (
    newName: string,
    scope?: WorkflowScope,
  ) => SlashCommandResult | Promise<SlashCommandResult>;
  /** Delete a user or project workflow by name (TUI only). */
  deleteWorkflow?: (name: string) => SlashCommandResult | Promise<SlashCommandResult>;
  /** Rename a user or project workflow (TUI only). */
  renameWorkflow?: (
    oldName: string,
    newName: string,
  ) => SlashCommandResult | Promise<SlashCommandResult>;
  /** Names of writable (user + project) workflows, for `/deleteworkflow` and `/renameworkflow` completion. */
  userWorkflowNames?: readonly string[];
  /** Open the past-run history browser (TUI only). */
  openHistory?: () => SlashCommandResult;
  /**
   * Drafting agent/model for `/createworkflow`, set via `/model` in the workflow
   * picker (TUI only). Present only when sitting on the picker (no step target).
   */
  draftModel?: DraftModelContext;
}

/** The drafting-model knob `/model` drives when no workflow step is selected. */
export interface DraftModelContext {
  /** Effective target (override if usable, else the auto pick); absent when no agent is healthy. */
  current?: { agent: AgentId; model: string };
  /** True when `current` comes from a user override rather than the auto pick. */
  usingOverride: boolean;
  /** Agents the doctor reports healthy, used to validate a requested target. */
  healthyAgents: readonly AgentId[];
  /** Live config used to map agent instances to provider model catalogs. */
  config?: SteamtrainConfig;
  /** Apply a new override, or `null` to reset to auto. */
  set: (target: { agent: AgentId; model: string } | null) => void;
}

export interface SlashCommand {
  /** Command name without the leading slash (e.g. `exit`). */
  readonly name: string;
  readonly description: string;
  readonly usage?: string;
  execute(
    args: string[],
    ctx: SlashCommandContext,
  ): SlashCommandResult | Promise<SlashCommandResult>;
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
