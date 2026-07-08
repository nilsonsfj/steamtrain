import type { SlashCommand } from "../types";

export const apisCommand: SlashCommand = {
  name: "apis",
  description: "Open the API manager (list, add, enable/disable llm-step APIs)",
  usage: "/apis",
  execute(_args, ctx) {
    if (!ctx.openApiManager) {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "warn", text: "the API manager is only available in the TUI" }],
      };
    }
    return ctx.openApiManager();
  },
};
