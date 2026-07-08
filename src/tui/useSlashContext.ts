import { useMemo } from "react";
import type {
  DraftModelContext,
  SlashCommandContext,
  SlashCommandResult,
  WorkflowStepSelection,
} from "../commands/types";
import type { ProjectConfigPatch } from "../config/project-config";
import type { AgentInstanceConfig, ApiInstanceConfig, SteamtrainConfig } from "../config/types";
import type { UserConfigPatch } from "../config/user-config";
import type { AgentInstanceId } from "../types/events";
import { STEAMTRAIN_VERSION } from "../version";
import type { WorkflowScope, WorkflowSpec } from "../workflow";
import type { WorkspaceConfig, WorkspaceEntry, WorkspaceId } from "../workspace";
import type { DraftTarget } from "./draft-model";
import type { Mode } from "./modes";
import { buildModes } from "./modes";

export interface UseSlashContextParams {
  mode: Mode;
  runtimeWorkspaces: WorkspaceConfig;
  workspaceMap: Map<string, WorkspaceEntry>;
  updateWorkspace: (id: WorkspaceId, patch: Partial<WorkspaceEntry>) => void;
  switchMode: (mode: Mode) => void;
  wfPreview: { name: string; input: string } | null;
  patchWorkflowStep: (
    stepId: string,
    patch: Partial<
      Pick<WorkspaceEntry, "agent" | "model" | "effort"> &
        Pick<WorkflowStepSelection, "prompt" | "cwd" | "env" | "extraArgs" | "stepTimeoutSec">
    >,
  ) => void;
  previewStepSelection: WorkflowStepSelection | undefined;
  workflowSpec?: WorkflowSpec;
  config?: SteamtrainConfig;
  configPath?: string;
  updateConfig?: (patch: ProjectConfigPatch) => { ok: boolean; error?: string };
  userConfigPath?: string;
  updateUserConfig?: (patch: UserConfigPatch) => { ok: boolean; error?: string };
  userAgents?: readonly AgentInstanceConfig[];
  projectAgents?: readonly AgentInstanceConfig[];
  userApis?: readonly ApiInstanceConfig[];
  projectApis?: readonly ApiInstanceConfig[];
  openAgentManager?: () => SlashCommandResult;
  openApiManager?: () => SlashCommandResult;
  workflowPickerActive: boolean;
  saveWorkflows: () => Promise<SlashCommandResult>;
  createWorkflow: (description: string, scope?: WorkflowScope) => SlashCommandResult;
  cloneWorkflow: (newName: string, scope?: WorkflowScope) => Promise<SlashCommandResult>;
  deleteWorkflow: (name: string) => Promise<SlashCommandResult>;
  renameWorkflow: (
    oldName: string,
    newName: string,
  ) => SlashCommandResult | Promise<SlashCommandResult>;
  updateWorkflowDescription: (
    name: string,
    description: string,
  ) => SlashCommandResult | Promise<SlashCommandResult>;
  userWorkflowNames: readonly string[];
  openHistory: () => SlashCommandResult;
  draftResolution: { target?: DraftTarget; usingOverride: boolean };
  healthyAgents: ReadonlySet<AgentInstanceId>;
  setDraftOverride: (target: DraftTarget | null) => void;
}

export function useSlashContext(params: UseSlashContextParams) {
  const {
    mode,
    runtimeWorkspaces,
    workspaceMap,
    updateWorkspace,
    switchMode,
    wfPreview,
    patchWorkflowStep,
    previewStepSelection,
    workflowSpec,
    config,
    configPath,
    updateConfig,
    userConfigPath,
    updateUserConfig,
    userAgents,
    projectAgents,
    userApis,
    projectApis,
    openAgentManager,
    openApiManager,
    workflowPickerActive,
    saveWorkflows,
    createWorkflow,
    cloneWorkflow,
    deleteWorkflow,
    renameWorkflow,
    updateWorkflowDescription,
    userWorkflowNames,
    openHistory,
    draftResolution,
    healthyAgents,
    setDraftOverride,
  } = params;

  const modes = useMemo(() => buildModes(runtimeWorkspaces), [runtimeWorkspaces]);

  const slashCtx = useMemo<SlashCommandContext>(
    () => ({
      mode,
      modes,
      workspaces: runtimeWorkspaces,
      workspaceMap,
      updateWorkspace,
      setMode: switchMode,
      version: STEAMTRAIN_VERSION,
      workflowStep: previewStepSelection,
      updateWorkflowStep: wfPreview ? patchWorkflowStep : undefined,
      workflowSpec,
      config,
      configPath,
      updateConfig,
      userConfigPath,
      updateUserConfig,
      userAgents,
      projectAgents,
      userApis,
      projectApis,
      openAgentManager,
      openApiManager,
      saveWorkflows,
      createWorkflow,
      cloneWorkflow,
      deleteWorkflow,
      renameWorkflow,
      updateWorkflowDescription,
      userWorkflowNames,
      openHistory,
      draftModel: workflowPickerActive
        ? {
            current: draftResolution.target,
            usingOverride: draftResolution.usingOverride,
            healthyAgents: [...healthyAgents],
            config,
            set: setDraftOverride,
          }
        : undefined,
    }),
    [
      mode,
      modes,
      runtimeWorkspaces,
      workspaceMap,
      updateWorkspace,
      switchMode,
      wfPreview,
      patchWorkflowStep,
      previewStepSelection,
      workflowSpec,
      config,
      configPath,
      updateConfig,
      userConfigPath,
      updateUserConfig,
      userAgents,
      projectAgents,
      userApis,
      projectApis,
      openAgentManager,
      openApiManager,
      workflowPickerActive,
      saveWorkflows,
      createWorkflow,
      cloneWorkflow,
      deleteWorkflow,
      renameWorkflow,
      updateWorkflowDescription,
      userWorkflowNames,
      openHistory,
      draftResolution,
      healthyAgents,
      setDraftOverride,
    ],
  );

  return { slashCtx, modes };
}
