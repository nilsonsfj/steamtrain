import type { SlashCommand } from "../types";

export const exitCommand: SlashCommand = {
  name: "exit",
  description: "Quit steamtrain",
  execute() {
    return { handled: true, exit: true, clearInput: true };
  },
};
