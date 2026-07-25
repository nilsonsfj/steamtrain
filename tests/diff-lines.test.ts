import { describe, expect, it } from "vitest";
import { buildDiffLines, truncatePatch } from "../src/tui/diff-lines";
import { parseUnifiedDiff } from "../src/workflow/unified-diff";

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

describe("buildDiffLines", () => {
  it("renders a bold file header with status letter, path, and counts", () => {
    const lines = buildDiffLines(parseUnifiedDiff(SIMPLE_PATCH));
    const header = lines[0];
    expect(header?.text).toBe("M src/foo.ts  +2 −1");
    expect(header?.color).toBe("yellow");
    expect(header?.bold).toBe(true);
  });

  it("colors the status badge by file status", () => {
    const cases: Array<[string, string, string]> = [
      [
        "diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+hi\n",
        "A",
        "green",
      ],
      [
        "diff --git a/x b/x\ndeleted file mode 100644\n--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-hi\n",
        "D",
        "red",
      ],
      ["diff --git a/old.ts b/new.ts\nrename from old.ts\nrename to new.ts\n", "R", "cyan"],
    ];
    for (const [patch, letter, color] of cases) {
      const header = buildDiffLines(parseUnifiedDiff(patch))[0];
      expect(header?.text.startsWith(`${letter} `)).toBe(true);
      expect(header?.color).toBe(color);
    }
  });

  it("shows old → new path for renames", () => {
    const patch = `diff --git a/old.ts b/new.ts
rename from old.ts
rename to new.ts
`;
    const header = buildDiffLines(parseUnifiedDiff(patch))[0];
    expect(header?.text).toContain("old.ts → new.ts");
  });

  it("renders hunk headers in dim cyan with the full @@ line", () => {
    const lines = buildDiffLines(parseUnifiedDiff(SIMPLE_PATCH));
    const hunk = lines.find((line) => line.text.startsWith("@@"));
    expect(hunk?.text).toBe("@@ -1,3 +1,4 @@ function main() {");
    expect(hunk?.color).toBe("cyan");
    expect(hunk?.dimColor).toBe(true);
  });

  it("renders add/del/context lines with markers, colors, and dual gutters", () => {
    const lines = buildDiffLines(parseUnifiedDiff(SIMPLE_PATCH));
    const context = lines.find((line) => line.text.includes("const a = 1;"));
    const del = lines.find((line) => line.text.includes("const b = 2;"));
    const add = lines.find((line) => line.text.includes("const c = 4;"));

    expect(context?.text).toBe("   1    1 │  const a = 1;");
    expect(context?.color).toBeUndefined();

    expect(del?.text).toBe("   2      │ -const b = 2;");
    expect(del?.color).toBe("red");

    expect(add?.text).toBe("        3 │ +const c = 4;");
    expect(add?.color).toBe("green");
  });

  it("right-aligns line numbers in 4-wide gutter columns", () => {
    const patch = `diff --git a/f b/f
--- a/f
+++ b/f
@@ -99,2 +99,2 @@
-old line
+new line
 context
`;
    const lines = buildDiffLines(parseUnifiedDiff(patch));
    const del = lines.find((line) => line.text.includes("old line"));
    const ctx = lines.find((line) => line.text.includes("context"));
    expect(del?.text.startsWith("  99 ")).toBe(true);
    expect(ctx?.text.startsWith(" 100  100 │")).toBe(true);
  });

  it("separates multiple files with a blank line", () => {
    const patch = `diff --git a/one.ts b/one.ts
--- a/one.ts
+++ b/one.ts
@@ -1 +1 @@
-a
+b
diff --git a/two.ts b/two.ts
--- a/two.ts
+++ b/two.ts
@@ -1 +1 @@
-c
+d
`;
    const lines = buildDiffLines(parseUnifiedDiff(patch));
    const twoHeader = lines.findIndex((line) => line.text.startsWith("M two.ts"));
    expect(twoHeader).toBeGreaterThan(0);
    expect(lines[twoHeader - 1]?.text).toBe("");
  });

  it("renders a dim placeholder for binary files", () => {
    const patch = `diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ
`;
    const lines = buildDiffLines(parseUnifiedDiff(patch));
    const placeholder = lines.find((line) => line.text === "  Binary file not shown");
    expect(placeholder?.dimColor).toBe(true);
  });

  it("renders a dim placeholder for metadata-only changes", () => {
    const patch = `diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
`;
    const lines = buildDiffLines(parseUnifiedDiff(patch));
    const placeholder = lines.find((line) => line.text === "  No textual changes (metadata only)");
    expect(placeholder?.dimColor).toBe(true);
  });

  it("renders the no-newline marker with blank gutter columns", () => {
    const patch = `diff --git a/f b/f
--- a/f
+++ b/f
@@ -1 +1 @@
-old
+new
\\ No newline at end of file
`;
    const lines = buildDiffLines(parseUnifiedDiff(patch));
    const marker = lines.find((line) => line.text.includes("No newline at end of file"));
    expect(marker?.text).toBe("          │ \\ No newline at end of file");
    expect(marker?.dimColor).toBe(true);
  });
});

describe("truncatePatch", () => {
  it("passes patches under the cap through unchanged", () => {
    const result = truncatePatch("small patch");
    expect(result).toEqual({ patch: "small patch", truncated: false });
  });

  it("cuts patches over the cap and flags them", () => {
    const result = truncatePatch("x".repeat(300), 100);
    expect(result.patch).toBe("x".repeat(100));
    expect(result.truncated).toBe(true);
  });

  it("treats a patch exactly at the cap as untruncated", () => {
    const result = truncatePatch("x".repeat(100), 100);
    expect(result.truncated).toBe(false);
  });
});
