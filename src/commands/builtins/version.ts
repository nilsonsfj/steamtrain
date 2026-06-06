import type { SlashCommand } from "../types";

export const versionCommand: SlashCommand = {
  name: "version",
  description: "Show steamtrain version",
  execute(_args, ctx) {
    return {
      handled: true,
      clearInput: true,
      notices: [{ level: "info", text: `steamtrain ${ctx.version}` }],
    };
  },
};
