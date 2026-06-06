import { agentCommand } from "./builtins/agent";
import { exitCommand } from "./builtins/exit";
import { modelCommand } from "./builtins/model";
import { versionCommand } from "./builtins/version";
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types";

const BUILTIN_COMMANDS: SlashCommand[] = [exitCommand, versionCommand, modelCommand, agentCommand];

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

export function executeSlashCommand(raw: string, ctx: SlashCommandContext): SlashCommandResult {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return { handled: false };

  const body = trimmed.slice(1).trim();
  if (!body) {
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

  const [name, ...args] = body.split(/\s+/);
  const def = registry.find((c) => c.name === name);
  if (!def) {
    return {
      handled: true,
      clearInput: true,
      notices: [{ level: "error", text: `unknown command '/${name}'` }],
    };
  }

  return def.execute(args, ctx);
}
