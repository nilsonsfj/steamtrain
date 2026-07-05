import type { SlashCommand } from "../types";

export const agentsCommand: SlashCommand = {
  name: "agents",
  description: "Open the agent manager (list, add, enable/disable agents)",
  usage: "/agents",
  execute(_args, ctx) {
    if (!ctx.openAgentManager) {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "warn", text: "the agent manager is only available in the TUI" }],
      };
    }
    return ctx.openAgentManager();
  },
};
