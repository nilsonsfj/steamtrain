import { agentCommand } from "./builtins/agent";
import { agentsCommand } from "./builtins/agents";
import { cloneWorkflowCommand } from "./builtins/clone-workflow";
import { createWorkflowCommand } from "./builtins/create-workflow";
import { deleteWorkflowCommand } from "./builtins/delete-workflow";
import { describeWorkflowCommand } from "./builtins/describe-workflow";
import { effortCommand } from "./builtins/effort";
import { exitCommand } from "./builtins/exit";
import { historyCommand } from "./builtins/history";
import { modelCommand } from "./builtins/model";
import { promptCommand } from "./builtins/prompt";
import { renameWorkflowCommand } from "./builtins/rename-workflow";
import { saveWorkflowsCommand } from "./builtins/save-workflows";
import { timeoutCommand } from "./builtins/timeout";
import { versionCommand } from "./builtins/version";
import { parseSlashInput, slashCommandArgs } from "./parse";
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types";

const BUILTIN_COMMANDS: SlashCommand[] = [
  exitCommand,
  versionCommand,
  modelCommand,
  effortCommand,
  agentCommand,
  agentsCommand,
  promptCommand,
  saveWorkflowsCommand,
  createWorkflowCommand,
  cloneWorkflowCommand,
  deleteWorkflowCommand,
  renameWorkflowCommand,
  describeWorkflowCommand,
  timeoutCommand,
  historyCommand,
];

/** Mutable registry — append custom commands at runtime to extend the TUI. */
const registry: SlashCommand[] = [...BUILTIN_COMMANDS];

export function listSlashCommands(): readonly SlashCommand[] {
  return registry;
}

/** Register an additional slash command (later entries with the same name win). */
export function registerSlashCommand(command: SlashCommand): void {
  const idx = registry.findIndex((c) => c.name === command.name);
  if (idx >= 0) registry[idx] = command;
  else registry.push(command);
}

/** True when Enter should run slash-command handling (not a normal prompt). */
export function isRegisteredSlashCommand(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return false;
  const parsed = parseSlashInput(trimmed);
  if (!parsed) return false;
  if (parsed.command.length === 0) return true;
  return registry.some((c) => c.name === parsed.command);
}

export function executeSlashCommand(
  raw: string,
  ctx: SlashCommandContext,
): SlashCommandResult | Promise<SlashCommandResult> {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return { handled: false };

  const parsed = parseSlashInput(trimmed);
  if (!parsed) return { handled: false };

  if (parsed.command.length === 0) {
    return {
      handled: true,
      clearInput: true,
      notices: [
        {
          level: "info",
          text: `commands: ${registry.map((c) => `/${c.name}`).join(", ")} (Tab to complete)`,
        },
      ],
    };
  }

  const def = registry.find((c) => c.name === parsed.command);
  if (!def) return { handled: false };

  return def.execute(slashCommandArgs(parsed), ctx);
}
