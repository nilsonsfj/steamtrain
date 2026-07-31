// @generated
"use strict";
var SteamtrainDiff = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/web/diff-view.ts
  var diff_view_exports = {};
  __export(diff_view_exports, {
    renderDiffFiles: () => renderDiffFiles,
    renderPatch: () => renderPatch
  });

  // src/workflow/unified-diff.ts
  var HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
  function parseUnifiedDiff(patch) {
    const files = [];
    let file = null;
    let hunk = null;
    let oldLine = 0;
    let newLine = 0;
    let inBinaryBody = false;
    const pushLine = (kind, text) => {
      if (!hunk) return;
      const line = kind === "add" ? { kind, text, oldNumber: null, newNumber: newLine++ } : kind === "del" ? { kind, text, oldNumber: oldLine++, newNumber: null } : { kind, text, oldNumber: oldLine++, newNumber: newLine++ };
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
      if (!file && raw.startsWith("--- ")) {
        file = { oldPath: null, newPath: null, status: "modified", isBinary: false, hunks: [] };
        files.push(file);
        hunk = null;
        inBinaryBody = false;
        const path = raw.slice(4);
        file.oldPath = path === "/dev/null" ? null : stripPrefix(path, "a/");
        if (file.oldPath === null) file.status = "added";
        continue;
      }
      if (!file) continue;
      if (inBinaryBody) {
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
          oldCount: hunkMatch[2] === void 0 ? 1 : Number(hunkMatch[2]),
          newStart: Number(hunkMatch[3]),
          newCount: hunkMatch[4] === void 0 ? 1 : Number(hunkMatch[4]),
          section: hunkMatch[5] ?? "",
          lines: []
        };
        file.hunks.push(hunk);
        oldLine = hunk.oldStart;
        newLine = hunk.newStart;
        continue;
      }
      if (!hunk) continue;
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
    }
    const last = files[files.length - 1]?.hunks.at(-1)?.lines.at(-1);
    if (last && last.kind === "context" && last.text === "" && patch.endsWith("\n")) {
      files[files.length - 1]?.hunks.at(-1)?.lines.pop();
    }
    return files;
  }
  function diffFileLineCounts(file) {
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
  function diffFileDisplayPath(file) {
    return file.newPath ?? file.oldPath ?? "(unknown)";
  }
  function splitGitPaths(header) {
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
  function readQuoted(text, start) {
    if (text[start] !== '"') return null;
    for (let i = start + 1; i < text.length; i++) {
      if (text[i] === "\\") i += 1;
      else if (text[i] === '"') return { value: dequote(text.slice(start, i + 1)), end: i };
    }
    return null;
  }
  function dequote(path) {
    if (!path.startsWith('"') || !path.endsWith('"')) return path;
    try {
      return JSON.parse(path);
    } catch {
      return path.slice(1, -1);
    }
  }
  function stripPrefix(path, prefix) {
    const dequoted = dequote(path);
    return dequoted.startsWith(prefix) ? dequoted.slice(prefix.length) : dequoted;
  }

  // src/web/diff-view.ts
  var STATUS_META = {
    modified: { letter: "M", cls: "diff-badge-m", word: "Modified" },
    added: { letter: "A", cls: "diff-badge-a", word: "Added" },
    deleted: { letter: "D", cls: "diff-badge-d", word: "Deleted" },
    renamed: { letter: "R", cls: "diff-badge-r", word: "Renamed" }
  };
  var LINE_CLASS = {
    context: "ctx",
    add: "add",
    del: "del"
  };
  var LINE_MARKER = {
    context: " ",
    add: "+",
    del: "-"
  };
  function resolveDocument(opts) {
    if (opts?.document) return opts.document;
    const doc = globalThis.document;
    if (!doc) throw new Error("renderPatch needs a DOM document (or opts.document)");
    return doc;
  }
  function gutter(doc, value) {
    const el = doc.createElement("span");
    el.className = "diff-gutter";
    el.setAttribute("aria-hidden", "true");
    el.textContent = value === null ? "" : String(value);
    return el;
  }
  function renderLine(doc, line) {
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
  function renderNoNewline(doc) {
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
  function renderBody(doc, file) {
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
  function renderFile(doc, file) {
    const fileEl = doc.createElement("div");
    fileEl.className = "diff-file";
    const head = doc.createElement("div");
    head.className = "diff-file-head";
    head.setAttribute("role", "button");
    head.setAttribute("tabindex", "0");
    head.setAttribute("aria-expanded", "true");
    const toggle = () => {
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
    chevron.textContent = "\u25BE";
    head.appendChild(chevron);
    const meta = STATUS_META[file.status];
    const badge = doc.createElement("span");
    badge.className = `diff-badge ${meta.cls}`;
    badge.setAttribute("title", meta.word);
    badge.textContent = meta.letter;
    head.appendChild(badge);
    const pathEl = doc.createElement("span");
    pathEl.className = "diff-path";
    pathEl.textContent = file.status === "renamed" && file.oldPath && file.newPath ? `${file.oldPath} \u2192 ${file.newPath}` : diffFileDisplayPath(file);
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
      del.textContent = `\u2212${counts.deletions}`;
      stat.appendChild(del);
    }
    head.appendChild(stat);
    fileEl.appendChild(head);
    fileEl.appendChild(renderBody(doc, file));
    return fileEl;
  }
  function renderDiffFiles(files, opts) {
    const doc = resolveDocument(opts);
    const root = doc.createElement("div");
    root.className = "diff-files";
    for (const file of files) {
      root.appendChild(renderFile(doc, file));
    }
    return root;
  }
  function renderPatch(patch, opts) {
    return renderDiffFiles(parseUnifiedDiff(patch), opts);
  }
  return __toCommonJS(diff_view_exports);
})();
