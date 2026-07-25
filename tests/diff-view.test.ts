import { describe, expect, it } from "vitest";
import type { DiffViewDocument, DiffViewElement, DiffViewEvent } from "../src/web/diff-view";
import { renderDiffFiles, renderPatch } from "../src/web/diff-view";
import { parseUnifiedDiff } from "../src/workflow/unified-diff";

/**
 * A structural fake of the DOM slice the renderer touches (DiffViewElement /
 * DiffViewDocument). It records class names, text, attributes, children, and
 * event listeners so tests can drive the collapse toggle and assert on the
 * produced tree without a real browser or a DOM dependency.
 */
class FakeElement implements DiffViewElement {
  className = "";
  textContent = "";
  children: FakeElement[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<(event: DiffViewEvent) => void>> = {};
  parent: FakeElement | null = null;

  appendChild(child: DiffViewElement): void {
    const el = child as FakeElement;
    el.parent = this;
    this.children.push(el);
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }

  addEventListener(type: string, listener: (event: DiffViewEvent) => void): void {
    const existing = this.listeners[type];
    if (existing) existing.push(listener);
    else this.listeners[type] = [listener];
  }

  click(): void {
    for (const listener of this.listeners.click ?? []) listener({});
  }

  keydown(key: string): void {
    for (const listener of this.listeners.keydown ?? []) listener({ key, preventDefault() {} });
  }

  /** First descendant (depth-first, inclusive) whose className matches. */
  find(cls: string): FakeElement | undefined {
    return this.findAll(cls)[0];
  }

  findAll(cls: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (el: FakeElement): void => {
      if (el.className.split(" ").includes(cls)) out.push(el);
      for (const child of el.children) walk(child);
    };
    walk(this);
    return out;
  }

  /** Concatenated textContent of the subtree, in document order. */
  text(): string {
    let out = this.textContent;
    for (const child of this.children) out += child.text();
    return out;
  }
}

class FakeDocument implements DiffViewDocument {
  createElement(): DiffViewElement {
    return new FakeElement();
  }
}

const doc = (): FakeDocument => new FakeDocument();

const SIMPLE_PATCH = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@ function main() {
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
`;

describe("renderPatch / renderDiffFiles", () => {
  it("renders a collapsible file card with badge, path, and +/- stats", () => {
    const root = renderPatch(SIMPLE_PATCH, { document: doc() }) as unknown as FakeElement;
    expect(root.className).toBe("diff-files");
    const file = root.find("diff-file");
    expect(file).toBeDefined();
    const head = file!.find("diff-file-head");
    expect(head!.attrs.role).toBe("button");
    expect(head!.attrs["aria-expanded"]).toBe("true");
    const badge = head!.find("diff-badge");
    expect(badge!.textContent).toBe("M");
    expect(badge!.className).toContain("diff-badge-m");
    expect(badge!.attrs.title).toBe("Modified");
    expect(head!.find("diff-path")!.textContent).toBe("src/foo.ts");
    expect(head!.find("diff-add")!.textContent).toBe("+2");
    expect(head!.find("diff-del")!.textContent).toBe("−1");
  });

  it("maps each file status to its badge letter, class, and word", () => {
    const cases: Array<[string, string, string, string]> = [
      [
        "diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+hi\n",
        "A",
        "diff-badge-a",
        "Added",
      ],
      [
        "diff --git a/x b/x\ndeleted file mode 100644\n--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-hi\n",
        "D",
        "diff-badge-d",
        "Deleted",
      ],
      [
        "diff --git a/o.ts b/n.ts\nrename from o.ts\nrename to n.ts\n",
        "R",
        "diff-badge-r",
        "Renamed",
      ],
    ];
    for (const [patch, letter, cls, word] of cases) {
      const root = renderPatch(patch, { document: doc() }) as unknown as FakeElement;
      const badge = root.find("diff-badge")!;
      expect(badge.textContent).toBe(letter);
      expect(badge.className).toContain(cls);
      expect(badge.attrs.title).toBe(word);
    }
  });

  it("shows old → new path for renames", () => {
    const root = renderPatch("diff --git a/o.ts b/n.ts\nrename from o.ts\nrename to n.ts\n", {
      document: doc(),
    }) as unknown as FakeElement;
    expect(root.find("diff-path")!.textContent).toBe("o.ts → n.ts");
  });

  it("renders hunk headers and add/del/context lines with gutters and markers", () => {
    const root = renderPatch(SIMPLE_PATCH, { document: doc() }) as unknown as FakeElement;
    const hunk = root.find("diff-hunk");
    expect(hunk!.textContent).toBe("@@ -1,3 +1,4 @@ function main() {");

    const lines = root.findAll("diff-line");
    const add = lines.find((l) => l.className.includes("add"))!;
    const del = lines.find((l) => l.className.includes("del"))!;
    const ctx = lines.find((l) => l.className.includes("ctx"))!;

    // Each line: old gutter, new gutter, then the marked code.
    expect(add.find("diff-code")!.textContent).toBe("+const b = 3;");
    expect(del.find("diff-code")!.textContent).toBe("-const b = 2;");
    expect(ctx.find("diff-code")!.textContent).toBe(" const a = 1;");

    // Added line: blank old gutter, populated new gutter.
    const addGutters = add.findAll("diff-gutter");
    expect(addGutters[0]!.textContent).toBe("");
    expect(addGutters[1]!.textContent).toBe("2");
    // Deleted line: populated old gutter, blank new gutter.
    const delGutters = del.findAll("diff-gutter");
    expect(delGutters[0]!.textContent).toBe("2");
    expect(delGutters[1]!.textContent).toBe("");
  });

  it("renders a placeholder for binary files", () => {
    const root = renderPatch(
      "diff --git a/l.png b/l.png\nBinary files a/l.png and b/l.png differ\n",
      {
        document: doc(),
      },
    ) as unknown as FakeElement;
    expect(root.find("diff-binary")!.textContent).toBe("Binary file not shown");
    expect(root.find("diff-line")).toBeUndefined();
  });

  it("renders a placeholder for metadata-only changes", () => {
    const root = renderPatch("diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n", {
      document: doc(),
    }) as unknown as FakeElement;
    expect(root.find("diff-empty-file")!.textContent).toBe("No textual changes (metadata only)");
  });

  it("renders the no-newline marker after the affected line", () => {
    const patch =
      "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n";
    const root = renderPatch(patch, { document: doc() }) as unknown as FakeElement;
    const markers = root.findAll("nonewline");
    expect(markers).toHaveLength(2);
    expect(markers[0]!.text()).toContain("\\ No newline at end of file");
  });

  it("toggles the collapsed class and aria-expanded on click", () => {
    const root = renderPatch(SIMPLE_PATCH, { document: doc() }) as unknown as FakeElement;
    const file = root.find("diff-file")!;
    const head = file.find("diff-file-head")!;
    expect(file.className).toBe("diff-file");

    head.click();
    expect(file.className).toBe("diff-file collapsed");
    expect(head.attrs["aria-expanded"]).toBe("false");

    head.click();
    expect(file.className).toBe("diff-file");
    expect(head.attrs["aria-expanded"]).toBe("true");
  });

  it("toggles from the keyboard with Enter/Space and ignores other keys", () => {
    const root = renderPatch(SIMPLE_PATCH, { document: doc() }) as unknown as FakeElement;
    const file = root.find("diff-file")!;
    const head = file.find("diff-file-head")!;

    head.keydown("a");
    expect(file.className).toBe("diff-file"); // ignored

    head.keydown("Enter");
    expect(file.className).toBe("diff-file collapsed");

    head.keydown(" ");
    expect(file.className).toBe("diff-file");
  });

  it("keeps hostile content as text, never markup (no innerHTML)", () => {
    const hostile =
      "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+<img src=x onerror=alert(1)>\n";
    const root = renderPatch(hostile, { document: doc() }) as unknown as FakeElement;
    const add = root.findAll("diff-line").find((l) => l.className.includes("add"))!;
    // The payload survives verbatim as text content of the code span...
    expect(add.find("diff-code")!.textContent).toBe("+<img src=x onerror=alert(1)>");
    // ...and was never parsed into child elements.
    expect(add.find("diff-code")!.children).toHaveLength(0);
  });

  it("renders an empty container for an empty file list", () => {
    const root = renderDiffFiles([], { document: doc() }) as unknown as FakeElement;
    expect(root.className).toBe("diff-files");
    expect(root.children).toHaveLength(0);
  });

  it("renders one card per file in a multi-file patch", () => {
    const patch = `${SIMPLE_PATCH}diff --git a/two.ts b/two.ts\n--- a/two.ts\n+++ b/two.ts\n@@ -1 +1 @@\n-c\n+d\n`;
    const files = parseUnifiedDiff(patch);
    expect(files).toHaveLength(2);
    const root = renderDiffFiles(files, { document: doc() }) as unknown as FakeElement;
    expect(root.findAll("diff-file")).toHaveLength(2);
  });
});
