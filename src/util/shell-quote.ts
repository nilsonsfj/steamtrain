/**
 * Quote a string for safe interpolation into a shell command line.
 * Matches the POSIX / Windows conventions used elsewhere in steamtrain
 * (display re-invocations, takeover copy-paste). Used to harden command-step
 * template expansion so {{input}} / {{steps.*.output}} cannot inject
 * metacharacters when embedded in `cmd`.
 */

/** True when the value needs no quoting on this platform. */
function isSafeUnquoted(value: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    return /^[A-Za-z0-9_./:\\=+-]+$/.test(value);
  }
  return /^[A-Za-z0-9_./:=+-]+$/.test(value);
}

/**
 * Quote `value` so the shell treats it as a single literal argument.
 * Empty string becomes `''` (POSIX) or `""` (Windows).
 */
export function shellQuote(value: string, platform: NodeJS.Platform = process.platform): string {
  if (value.length === 0) return platform === "win32" ? '""' : "''";
  if (isSafeUnquoted(value, platform)) return value;
  if (platform === "win32") {
    // cmd.exe: double any embedded quotes, wrap in double quotes.
    return `"${value.replace(/"/g, '""')}"`;
  }
  // POSIX sh: wrap in single quotes; close/reopen around each embedded `'`.
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Quote context at a placeholder: outside quotes, inside `'…'`, or inside `"…"`. */
export type ShellQuoteContext = "'" | '"' | null;

/**
 * Quote `value` for interpolation into a command at the given quote context.
 * Outside quotes this is {@link shellQuote}. Inside quotes, only the
 * characters that would end or interpolate that quoting are escaped, so
 * wrapping a placeholder in `"…"` cannot be broken out of.
 */
export function shellQuoteInContext(
  value: string,
  quote: ShellQuoteContext,
  platform: NodeJS.Platform = process.platform,
): string {
  if (quote === null) return shellQuote(value, platform);
  if (platform === "win32") {
    return quote === '"' ? value.replace(/"/g, '""') : value;
  }
  if (quote === "'") return value.replace(/'/g, `'\\''`);
  return value.replace(/([\\"$`])/g, "\\$1").replace(/\n/g, "\\n");
}
