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
