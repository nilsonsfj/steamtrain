import type { Mode } from "../tui/modes";
import type { WorkspaceConfig, WorkspaceEntry, WorkspaceId } from "../workspace";

export interface SlashCommandNotice {
  level: "info" | "warn" | "error";
  text: string;
}

export type SlashCommandResult =
  | { handled: true; clearInput?: boolean; notices?: SlashCommandNotice[]; exit?: boolean }
  | { handled: false };

/** Context passed to slash commands from the TUI. */
export interface SlashCommandContext {
  mode: Mode;
  modes: readonly Mode[];
  workspaces: WorkspaceConfig;
  workspaceMap: Map<WorkspaceId, WorkspaceEntry>;
  /** Update a workspace entry in the live (session) config. */
  updateWorkspace: (id: WorkspaceId, patch: Partial<WorkspaceEntry>) => void;
  setMode: (mode: Mode) => void;
  version: string;
}

export interface SlashCommand {
  /** Command name without the leading slash (e.g. `exit`). */
  readonly name: string;
  readonly description: string;
  readonly usage?: string;
  execute(args: string[], ctx: SlashCommandContext): SlashCommandResult;
  /** Return argument completions for the given token index (0 = first arg after command). */
  complete?(args: string[], ctx: SlashCommandContext): readonly string[];
}

export interface ParsedSlashInput {
  command: string;
  args: string[];
  /** Raw token being typed for the active argument (may be partial). */
  activeArg: string;
  /** Index of the argument being completed (0-based, after command name). */
  activeArgIndex: number;
}
