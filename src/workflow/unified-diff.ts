/**
 * Parser for unified diffs (`git diff` output) into a structured model that
 * both the TUI and the web UI render as code-review-style panels. Pure and
 * dependency-free so it can be unit-tested and bundled for the browser.
 */

export type DiffLineKind = "add" | "del" | "context";

export interface DiffLine {
  kind: DiffLineKind;
  /** Line content without the leading +/-/space marker. */
  text: string;
  /** 1-based line number on the old side; null for added lines. */
  oldNumber: number | null;
  /** 1-based line number on the new side; null for deleted lines. */
  newNumber: number | null;
  /** True when the file has no trailing newline after this line. */
  noNewline?: boolean;
}

export interface DiffHunk {
  /** The full `@@ -a,b +c,d @@ section` header line. */
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Optional function/section heading after the second `@@`. */
  section: string;
  lines: DiffLine[];
}

export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface ParsedDiffFile {
  /** Path on the old side (null for added files). */
  oldPath: string | null;
  /** Path on the new side (null for deleted files). */
  newPath: string | null;
  status: DiffFileStatus;
  /** Binary files carry no textual hunks; render a placeholder instead. */
  isBinary: boolean;
  hunks: DiffHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/**
 * Parse a unified patch into per-file structures. Tolerates the extended
 * headers git emits (new/deleted file modes, renames, similarity indexes,
 * mode changes, binary patches) and skips anything it does not recognize so
 * a malformed patch degrades to fewer lines rather than throwing.
 */
export function parseUnifiedDiff(patch: string): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = [];
  let file: ParsedDiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let inBinaryBody = false;

  const pushLine = (kind: DiffLineKind, text: string): void => {
    if (!hunk) return;
    const line: DiffLine =
      kind === "add"
        ? { kind, text, oldNumber: null, newNumber: newLine++ }
        : kind === "del"
          ? { kind, text, oldNumber: oldLine++, newNumber: null }
          : { kind, text, oldNumber: oldLine++, newNumber: newLine++ };
    hunk.lines.push(line);
  };

  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      file = { oldPath: null, newPath: null, status: "modified", isBinary: false, hunks: [] };
      files.push(file);
      hunk = null;
      inBinaryBody = false;
      const [oldPath, newPath] = splitGitPaths(raw.slice("diff --git ".length));
      file.oldPath = stripPrefix(oldPath, "a/");
      file.newPath = stripPrefix(newPath, "b/");
      continue;
    }
    if (!file) continue;

    if (inBinaryBody) {
      // `GIT binary patch` literal/delta blocks end at a blank line.
      if (raw.trim() === "") inBinaryBody = false;
      continue;
    }
    if (raw.startsWith("GIT binary patch") || raw.startsWith("Binary files ")) {
      file.isBinary = true;
      inBinaryBody = raw.startsWith("GIT binary patch");
      hunk = null;
      continue;
    }
    if (raw.startsWith("new file mode")) {
      file.status = "added";
      continue;
    }
    if (raw.startsWith("deleted file mode")) {
      file.status = "deleted";
      continue;
    }
    if (raw.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = dequote(raw.slice("rename from ".length));
      continue;
    }
    if (raw.startsWith("rename to ")) {
      file.status = "renamed";
      file.newPath = dequote(raw.slice("rename to ".length));
      continue;
    }
    // `--- `/`+++ ` are file headers only before the file's first hunk; inside
    // a hunk they are just deleted/added lines whose text starts with `--`/`++`.
    if (raw.startsWith("--- ") && file.hunks.length === 0) {
      const path = raw.slice(4);
      file.oldPath = path === "/dev/null" ? null : stripPrefix(path, "a/");
      if (file.oldPath === null && file.status === "modified") file.status = "added";
      continue;
    }
    if (raw.startsWith("+++ ") && file.hunks.length === 0) {
      const path = raw.slice(4);
      file.newPath = path === "/dev/null" ? null : stripPrefix(path, "b/");
      if (file.newPath === null && file.status === "modified") file.status = "deleted";
      continue;
    }

    const hunkMatch = HUNK_HEADER.exec(raw);
    if (hunkMatch) {
      hunk = {
        header: raw,
        oldStart: Number(hunkMatch[1]),
        oldCount: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
        newStart: Number(hunkMatch[3]),
        newCount: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
        section: hunkMatch[5] ?? "",
        lines: [],
      };
      file.hunks.push(hunk);
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      continue;
    }
    if (!hunk) continue; // index/mode/similarity lines and other metadata

    if (raw.startsWith("\\")) {
      const prev = hunk.lines[hunk.lines.length - 1];
      if (prev) prev.noNewline = true;
      continue;
    }
    const marker = raw[0];
    if (marker === "+") pushLine("add", raw.slice(1));
    else if (marker === "-") pushLine("del", raw.slice(1));
    else if (marker === " ") pushLine("context", raw.slice(1));
    else if (raw === "") pushLine("context", "");
    // Anything else inside a hunk (shouldn't happen) is ignored.
  }

  // A trailing empty string from split() can append a phantom context line to
  // the last hunk when the patch ends with a newline. Only the final hunk of
  // the final file is at risk: every earlier file is followed by a `diff --git`
  // header, which resets `hunk` before the next line is read, so a stray blank
  // there attaches to nothing.
  const last = files[files.length - 1]?.hunks.at(-1)?.lines.at(-1);
  if (last && last.kind === "context" && last.text === "" && patch.endsWith("\n")) {
    files[files.length - 1]?.hunks.at(-1)?.lines.pop();
  }
  return files;
}

/** Total added/removed line counts across a parsed file (binary files: 0). */
export function diffFileLineCounts(file: ParsedDiffFile): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") additions += 1;
      else if (line.kind === "del") deletions += 1;
    }
  }
  return { additions, deletions };
}

/** Best display path for a parsed file: new side, falling back to old. */
export function diffFileDisplayPath(file: ParsedDiffFile): string {
  return file.newPath ?? file.oldPath ?? "(unknown)";
}

/** Default cap for {@link capPatch}: 200 KB of patch text. */
export const DEFAULT_PATCH_CAP = 200_000;

/**
 * Cap a patch string at `cap` characters for transport/rendering, flagging
 * truncation. A runaway diff would otherwise produce tens of thousands of rows
 * and hitch the UIs; the CLI `history show --diff` always carries the full
 * text. The cut backs off one character when it would split a UTF-16 surrogate
 * pair (e.g. an emoji) so the result is never a malformed lone surrogate.
 * Shared by the web server endpoint and the TUI so both cap identically.
 */
export function capPatch(
  patch: string,
  cap = DEFAULT_PATCH_CAP,
): { patch: string; truncated: boolean } {
  if (patch.length <= cap) return { patch, truncated: false };
  let end = cap;
  const code = patch.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1; // lone high surrogate: drop it
  return { patch: patch.slice(0, end), truncated: true };
}

/** Split the two paths of a `diff --git` header, honoring C-style quoting. */
function splitGitPaths(header: string): [string, string] {
  if (header.startsWith('"')) {
    const first = readQuoted(header, 0);
    if (first) {
      const second = readQuoted(header, first.end + 1);
      if (second) return [first.value, second.value];
    }
  }
  const sep = header.indexOf(" b/");
  if (sep > 0) return [header.slice(0, sep), header.slice(sep + 1)];
  const half = header.split(" ");
  return [half[0] ?? "", half.slice(1).join(" ")];
}

function readQuoted(text: string, start: number): { value: string; end: number } | null {
  if (text[start] !== '"') return null;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") i += 1;
    else if (text[i] === '"') return { value: dequote(text.slice(start, i + 1)), end: i };
  }
  return null;
}

/** Undo git's C-style path quoting; pass unquoted paths through unchanged. */
function dequote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  try {
    return JSON.parse(path) as string;
  } catch {
    return path.slice(1, -1);
  }
}

function stripPrefix(path: string, prefix: string): string {
  const dequoted = dequote(path);
  return dequoted.startsWith(prefix) ? dequoted.slice(prefix.length) : dequoted;
}
