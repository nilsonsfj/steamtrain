/**
 * Graphical unified-diff renderer for the web UI: code-review-style panels
 * built from the structured model of `src/workflow/unified-diff.ts`. Pure and
 * dependency-free like the parser — it talks to a minimal structural DOM
 * subset ({@link DiffViewDocument}) so it can be bundled for the browser
 * (global `SteamtrainDiff`) and unit-tested server-side with a fake document.
 * All patch content goes through `textContent`, never `innerHTML`, so a
 * hostile diff cannot inject markup.
 */

import {
  diffFileDisplayPath,
  diffFileLineCounts,
  parseUnifiedDiff,
} from "../workflow/unified-diff";
import type { DiffLine, ParsedDiffFile } from "../workflow/unified-diff";

/** The structural slice of a DOM event the renderer reads (keyboard toggle). */
export interface DiffViewEvent {
  key?: string;
  preventDefault?: () => void;
}

/** The structural slice of `Element` the renderer uses — nothing else. */
export interface DiffViewElement {
  className: string;
  textContent: string;
  appendChild(child: DiffViewElement): void;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: (event: DiffViewEvent) => void): void;
}

/** The structural slice of `Document` the renderer uses — `createElement` only. */
export interface DiffViewDocument {
  createElement(tag: string): DiffViewElement;
}

export interface DiffViewOptions {
  /** Inject a fake/minimal document for tests; defaults to the global one. */
  document?: DiffViewDocument;
}

const STATUS_META: Record<ParsedDiffFile["status"], { letter: string; cls: string; word: string }> =
  {
    modified: { letter: "M", cls: "diff-badge-m", word: "Modified" },
    added: { letter: "A", cls: "diff-badge-a", word: "Added" },
    deleted: { letter: "D", cls: "diff-badge-d", word: "Deleted" },
    renamed: { letter: "R", cls: "diff-badge-r", word: "Renamed" },
  };

const LINE_CLASS: Record<DiffLine["kind"], string> = {
  context: "ctx",
  add: "add",
  del: "del",
};

const LINE_MARKER: Record<DiffLine["kind"], string> = {
  context: " ",
  add: "+",
  del: "-",
};

function resolveDocument(opts?: DiffViewOptions): DiffViewDocument {
  if (opts?.document) return opts.document;
  const doc = (globalThis as { document?: Document }).document;
  if (!doc) throw new Error("renderPatch needs a DOM document (or opts.document)");
  return doc as unknown as DiffViewDocument;
}

function gutter(doc: DiffViewDocument, value: number | null): DiffViewElement {
  const el = doc.createElement("span");
  el.className = "diff-gutter";
  el.setAttribute("aria-hidden", "true");
  el.textContent = value === null ? "" : String(value);
  return el;
}

function renderLine(doc: DiffViewDocument, line: DiffLine): DiffViewElement {
  const row = doc.createElement("div");
  row.className = `diff-line ${LINE_CLASS[line.kind]}`;
  row.appendChild(gutter(doc, line.oldNumber));
  row.appendChild(gutter(doc, line.newNumber));
  const code = doc.createElement("span");
  code.className = "diff-code";
  code.textContent = LINE_MARKER[line.kind] + line.text;
  row.appendChild(code);
  return row;
}

function renderNoNewline(doc: DiffViewDocument): DiffViewElement {
  const row = doc.createElement("div");
  row.className = "diff-line nonewline";
  row.appendChild(gutter(doc, null));
  row.appendChild(gutter(doc, null));
  const code = doc.createElement("span");
  code.className = "diff-code";
  code.textContent = "\\ No newline at end of file";
  row.appendChild(code);
  return row;
}

function renderBody(doc: DiffViewDocument, file: ParsedDiffFile): DiffViewElement {
  const body = doc.createElement("div");
  body.className = "diff-file-body";
  if (file.isBinary) {
    const note = doc.createElement("div");
    note.className = "diff-binary";
    note.textContent = "Binary file not shown";
    body.appendChild(note);
    return body;
  }
  if (file.hunks.length === 0) {
    // Pure mode change / rename with no content edits.
    const note = doc.createElement("div");
    note.className = "diff-empty-file";
    note.textContent = "No textual changes (metadata only)";
    body.appendChild(note);
    return body;
  }
  for (const hunk of file.hunks) {
    const header = doc.createElement("div");
    header.className = "diff-hunk";
    header.textContent = hunk.header;
    body.appendChild(header);
    for (const line of hunk.lines) {
      body.appendChild(renderLine(doc, line));
      if (line.noNewline) body.appendChild(renderNoNewline(doc));
    }
  }
  return body;
}

function renderFile(doc: DiffViewDocument, file: ParsedDiffFile): DiffViewElement {
  const fileEl = doc.createElement("div");
  fileEl.className = "diff-file";

  const head = doc.createElement("div");
  head.className = "diff-file-head";
  head.setAttribute("role", "button");
  head.setAttribute("tabindex", "0");
  head.setAttribute("aria-expanded", "true");
  const toggle = (): void => {
    const collapsed = fileEl.className.indexOf("collapsed") >= 0;
    fileEl.className = collapsed ? "diff-file" : "diff-file collapsed";
    head.setAttribute("aria-expanded", collapsed ? "true" : "false");
  };
  head.addEventListener("click", () => toggle());
  head.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault?.();
    toggle();
  });

  const chevron = doc.createElement("span");
  chevron.className = "diff-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "▾";
  head.appendChild(chevron);

  const meta = STATUS_META[file.status];
  const badge = doc.createElement("span");
  badge.className = `diff-badge ${meta.cls}`;
  badge.setAttribute("title", meta.word);
  badge.textContent = meta.letter;
  head.appendChild(badge);

  const pathEl = doc.createElement("span");
  pathEl.className = "diff-path";
  pathEl.textContent =
    file.status === "renamed" && file.oldPath && file.newPath
      ? `${file.oldPath} → ${file.newPath}`
      : diffFileDisplayPath(file);
  head.appendChild(pathEl);

  const counts = diffFileLineCounts(file);
  const stat = doc.createElement("span");
  stat.className = "diff-stat";
  if (counts.additions > 0) {
    const add = doc.createElement("span");
    add.className = "diff-add";
    add.textContent = `+${counts.additions}`;
    stat.appendChild(add);
  }
  if (counts.deletions > 0) {
    const del = doc.createElement("span");
    del.className = "diff-del";
    del.textContent = `−${counts.deletions}`;
    stat.appendChild(del);
  }
  head.appendChild(stat);
  fileEl.appendChild(head);

  fileEl.appendChild(renderBody(doc, file));
  return fileEl;
}

/**
 * Render already-parsed diff files as a `.diff-files` column of collapsible
 * per-file cards. An empty list yields an empty container (callers decide
 * whether to show their own empty state).
 */
export function renderDiffFiles(files: ParsedDiffFile[], opts?: DiffViewOptions): HTMLElement {
  const doc = resolveDocument(opts);
  const root = doc.createElement("div");
  root.className = "diff-files";
  for (const file of files) {
    root.appendChild(renderFile(doc, file));
  }
  return root as unknown as HTMLElement;
}

/** Parse a unified patch and render it like {@link renderDiffFiles}. */
export function renderPatch(patch: string, opts?: DiffViewOptions): HTMLElement {
  return renderDiffFiles(parseUnifiedDiff(patch), opts);
}
