import { closestMatch } from "../util/did-you-mean";
import { agentCommand } from "./builtins/agent";
import { agentsCommand } from "./builtins/agents";
import { apiCommand } from "./builtins/api";
import { apisCommand } from "./builtins/apis";
import { attachCommand } from "./builtins/attach";
import { cancelRunCommand } from "./builtins/cancel-run";
import { cloneWorkflowCommand } from "./builtins/clone-workflow";
import { createWorkflowCommand } from "./builtins/create-workflow";
import { deleteWorkflowCommand } from "./builtins/delete-workflow";
import { describeWorkflowCommand } from "./builtins/describe-workflow";
import { effortCommand } from "./builtins/effort";
import { exitCommand } from "./builtins/exit";
import { helpCommand } from "./builtins/help";
import { historyCommand } from "./builtins/history";
import { modelCommand } from "./builtins/model";
import { promptCommand } from "./builtins/prompt";
import { renameWorkflowCommand } from "./builtins/rename-workflow";
import { runsCommand } from "./builtins/runs";
import { saveWorkflowsCommand } from "./builtins/save-workflows";
import { timeoutCommand } from "./builtins/timeout";
import { versionCommand } from "./builtins/version";
import { parseSlashInput, slashCommandArgs } from "./parse";
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types";

const BUILTIN_COMMANDS: SlashCommand[] = [
  helpCommand,
  exitCommand,
  versionCommand,
  modelCommand,
  effortCommand,
  agentCommand,
  agentsCommand,
  apiCommand,
  apisCommand,
  promptCommand,
  saveWorkflowsCommand,
  createWorkflowCommand,
  cloneWorkflowCommand,
  deleteWorkflowCommand,
  renameWorkflowCommand,
  describeWorkflowCommand,
  timeoutCommand,
  historyCommand,
  runsCommand,
  attachCommand,
  cancelRunCommand,
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

/** Bare command-name shape: `/hlep` is a typo'd command; `/path/to/file` is prose. */
const COMMAND_NAME_RE = /^[a-zA-Z][a-zA-Z0-9-]*$/;

/**
 * Non-null when the input looks like a slash command but matches no registered
 * command. Callers must surface this as an error instead of falling through to
 * normal dispatch — a typo'd /command must never launch a run.
 *
 * A bare word after "/" is inherently ambiguous ("/hlep" vs "/Dockerfile"), so
 * the heuristic leans command-ish only where a command is plausible: names
 * containing uppercase can't be builtin commands, so with no near-command
 * match they pass through as prose ("/README explain this" still dispatches).
 * All-lowercase unknowns stay blocked even without a suggestion — dispatching
 * "/zzzqqq" as a paid run is the worse failure, and the typed text remains one
 * ↑ away in prompt history.
 */
export function unknownSlashCommand(raw: string): { name: string; suggestion?: string } | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return null;
  const parsed = parseSlashInput(trimmed);
  if (!parsed || parsed.command.length === 0) return null;
  if (!COMMAND_NAME_RE.test(parsed.command)) return null;
  if (registry.some((c) => c.name === parsed.command)) return null;
  const suggestion = closestMatch(
    parsed.command,
    registry.map((c) => c.name),
  );
  if (!suggestion && /[A-Z]/.test(parsed.command)) return null;
  return { name: parsed.command, suggestion };
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
          text: `commands: ${registry.map((c) => `/${c.name}`).join(", ")} (Tab to complete · /help for keys)`,
        },
      ],
    };
  }

  const def = registry.find((c) => c.name === parsed.command);
  if (!def) return { handled: false };

  return def.execute(slashCommandArgs(parsed), ctx);
}
