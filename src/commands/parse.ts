import type { ParsedSlashInput } from "./types";

/** Split a slash-command line into command name and arguments. */
export function parseSlashInput(raw: string): ParsedSlashInput | null {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("/")) return null;

  const body = trimmed.slice(1);
  if (body.length === 0) {
    return { command: "", args: [], activeArg: "", activeArgIndex: 0 };
  }

  const tokens = body.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const command = tokens[0] ?? "";
  const args = tokens.slice(1).map(stripQuotes);
  const endsWithSpace = /\s$/.test(body);
  const activeArgIndex = endsWithSpace ? args.length : Math.max(0, args.length - 1);
  const activeArg = endsWithSpace ? "" : (args[args.length - 1] ?? "");

  return {
    command,
    args: endsWithSpace ? args : args.slice(0, -1),
    activeArg,
    activeArgIndex,
  };
}

function stripQuotes(token: string): string {
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

export function isSlashCommandInput(value: string): boolean {
  return value.startsWith("/");
}
