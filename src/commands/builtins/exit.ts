import type { SlashCommand } from "../types";

export const exitCommand: SlashCommand = {
  name: "exit",
  description: "Quit steamtrain (confirm again while a non-detached run is active)",
  execute() {
    return { handled: true, exit: true, clearInput: true };
  },
};
