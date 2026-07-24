/** Small text helpers shared across layers (dependency-free on purpose). */

/**
 * ANSI escape sequences: CSI (colors, cursor movement — `\x1b[...m` et al.),
 * OSC (window titles, hyperlinks — `\x1b]...BEL/ST`), and two-byte charset /
 * reset sequences. Plain-text agent CLIs (e.g. kiro-cli headless chat) render
 * markdown with these even when stdout is a pipe; downstream consumers —
 * structured-output parsing, logs, UIs — want them gone.
 */
const ANSI_PATTERN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal control bytes is the point
  /\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-2A-Z]|[@-Z\\-_])/g;

/** Remove ANSI escape sequences from `text`. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}
