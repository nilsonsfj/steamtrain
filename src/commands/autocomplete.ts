import { parseSlashInput } from "./parse";
import type { SlashCommand, SlashCommandContext } from "./types";

export interface AutocompleteResult {
  value: string;
  /** Suggestions shown when multiple matches exist. */
  suggestions: readonly string[];
}

function longestCommonPrefix(values: readonly string[]): string {
  if (values.length === 0) return "";
  let prefix = values[0] ?? "";
  for (const value of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) i += 1;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}

function filterPrefix(candidates: readonly string[], prefix: string): string[] {
  const lower = prefix.toLowerCase();
  return candidates.filter((c) => c.toLowerCase().startsWith(lower));
}

function completeCommandName(
  raw: string,
  partial: string,
  commands: readonly SlashCommand[],
  endsWithSpace: boolean,
): AutocompleteResult {
  const matches = filterPrefix(
    commands.map((c) => c.name),
    partial,
  );
  if (matches.length === 0) return { value: raw, suggestions: [] };
  if (matches.length === 1) {
    return { value: `/${matches[0]!} `, suggestions: matches };
  }
  const completed = longestCommonPrefix(matches);
  if (!endsWithSpace && completed.length > partial.length) {
    return { value: `/${completed}`, suggestions: matches };
  }
  return { value: raw, suggestions: matches };
}

/** Tab-complete a slash-command prompt value. */
export function autocompleteSlashCommand(
  raw: string,
  commands: readonly SlashCommand[],
  ctx: SlashCommandContext,
): AutocompleteResult | null {
  const parsed = parseSlashInput(raw);
  if (!parsed) return null;

  const { command, args, activeArg, activeArgIndex } = parsed;
  const body = raw.trimStart().slice(1);
  const endsWithSpace = /\s$/.test(body);
  const hasArgumentTokens = body.includes(" ");

  // Completing the command name itself (no space yet after the partial name).
  if (!hasArgumentTokens && !endsWithSpace && command.length > 0) {
    return completeCommandName(raw, command, commands, false);
  }

  if (command.length === 0) {
    const names = commands.map((c) => c.name);
    return { value: raw, suggestions: names };
  }

  const def = commands.find((c) => c.name === command);
  if (!def) {
    return completeCommandName(raw, command, commands, endsWithSpace);
  }

  if (!def.complete) return null;

  const argTokens = endsWithSpace ? [...args, ""] : [...args.slice(0, -1), activeArg];
  const candidates = [...def.complete(argTokens, ctx)];
  const matches = filterPrefix(candidates, activeArg);
  if (matches.length === 0) return { value: raw, suggestions: candidates };

  const completed = longestCommonPrefix(matches);
  const pick = matches.length === 1 ? matches[0]! : completed;
  const baseArgs = args.slice(0, activeArgIndex);
  const suffix = matches.length === 1 ? " " : "";
  const nextArgs = [...baseArgs, pick].join(" ");
  return {
    value:
      nextArgs.length > 0 ? `/${command} ${nextArgs}${suffix}` : `/${command} ${pick}${suffix}`,
    suggestions: matches,
  };
}

/** Apply a chosen suggestion from the completion menu to the prompt value. */
export function applySlashSuggestion(
  raw: string,
  suggestion: string,
  commands: readonly SlashCommand[],
  _ctx: SlashCommandContext,
): string {
  const parsed = parseSlashInput(raw);
  if (!parsed) return raw;

  const { command, args, activeArgIndex } = parsed;
  const body = raw.trimStart().slice(1);
  const endsWithSpace = /\s$/.test(body);
  const hasArgumentTokens = body.includes(" ");

  // Completing the command name itself.
  if (!hasArgumentTokens && !endsWithSpace && command.length > 0) {
    return `/${suggestion} `;
  }

  if (command.length === 0) {
    return `/${suggestion} `;
  }

  const def = commands.find((c) => c.name === command);
  if (!def) {
    return `/${suggestion} `;
  }

  if (!def.complete) return raw;

  const baseArgs = args.slice(0, activeArgIndex);
  const nextArgs = [...baseArgs, suggestion].join(" ");
  return nextArgs.length > 0 ? `/${command} ${nextArgs} ` : `/${command} ${suggestion} `;
}
