import { closestMatch } from "../../util/did-you-mean";
import { listSlashCommands } from "../registry";
import type { SlashCommand } from "../types";

/**
 * `/help` — open the TUI help overlay (keys + commands), or print the command
 * list as a notice where no overlay exists. `/help <command>` shows one
 * command's usage.
 */
export const helpCommand: SlashCommand = {
  name: "help",
  description: "Show keys and slash commands (/help <command> for usage)",
  usage: "/help [command]",
  execute(args, ctx) {
    const topic = args[0]?.replace(/^\//, "");
    if (topic) {
      const command = listSlashCommands().find((c) => c.name === topic);
      if (!command) {
        const suggestion = closestMatch(
          topic,
          listSlashCommands().map((c) => c.name),
        );
        return {
          handled: true,
          clearInput: true,
          notices: [
            {
              level: "error",
              text: `no command '/${topic}'${suggestion ? ` — did you mean /${suggestion}?` : ""} (/help lists all)`,
            },
          ],
        };
      }
      return {
        handled: true,
        clearInput: true,
        notices: [
          {
            level: "info",
            text: `${command.usage ?? `/${command.name}`} — ${command.description}`,
          },
        ],
      };
    }
    if (ctx.openHelp) return ctx.openHelp();
    return {
      handled: true,
      clearInput: true,
      notices: [
        {
          level: "info",
          text: `commands: ${listSlashCommands()
            .map((c) => `/${c.name}`)
            .join(", ")} — /help <command> for usage`,
        },
      ],
    };
  },
  complete(args) {
    if (args.length > 1) return [];
    const prefix = args[0] ?? "";
    return listSlashCommands()
      .map((c) => c.name)
      .filter((name) => name.startsWith(prefix));
  },
};
