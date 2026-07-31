import { describe, expect, it } from "vitest";
import {
  capPatch,
  diffFileDisplayPath,
  diffFileLineCounts,
  parseUnifiedDiff,
} from "../src/workflow/unified-diff.js";

describe("parseUnifiedDiff", () => {
  it("parses a plain unified diff without a diff --git header", () => {
    const patch = [
      "--- a/old.json",
      "+++ b/new.json",
      "@@ -1,3 +1,3 @@",
      " {",
      '-  "name": "a"',
      '+  "name": "b"',
      " }",
      "",
    ].join("\n");
    const files = parseUnifiedDiff(patch);
    expect(files).toHaveLength(1);
    const file = files[0]!;
    expect(file.oldPath).toBe("old.json");
    expect(file.newPath).toBe("new.json");
    expect(file.hunks).toHaveLength(1);
    expect(diffFileLineCounts(file)).toEqual({ additions: 1, deletions: 1 });
  });

  it("parses a plain unified diff without a/ or b/ path prefixes", () => {
    const patch = [
      "--- old.json",
      "+++ new.json",
      "@@ -1,2 +1,2 @@",
      " line1",
      "-old",
      "+new",
      "",
    ].join("\n");
    const files = parseUnifiedDiff(patch);
    expect(files).toHaveLength(1);
    expect(files[0]!.oldPath).toBe("old.json");
    expect(files[0]!.newPath).toBe("new.json");
    expect(diffFileLineCounts(files[0]!)).toEqual({ additions: 1, deletions: 1 });
  });

  it("parses a simple modification with line numbers", () => {
    const patch = [
      "diff --git a/foo.ts b/foo.ts",
      "index 1234567..89abcde 100644",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,3 +1,4 @@ export function main()",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      "+const c = 4;",
      " const d = 5;",
      "",
    ].join("\n");
    const files = parseUnifiedDiff(patch);
    expect(files).toHaveLength(1);
    const file = files[0]!;
    expect(file.status).toBe("modified");
    expect(file.oldPath).toBe("foo.ts");
    expect(file.newPath).toBe("foo.ts");
    expect(file.isBinary).toBe(false);
    expect(file.hunks).toHaveLength(1);
    const hunk = file.hunks[0]!;
    expect(hunk.oldStart).toBe(1);
    expect(hunk.oldCount).toBe(3);
    expect(hunk.newStart).toBe(1);
    expect(hunk.newCount).toBe(4);
    expect(hunk.section).toBe("export function main()");
    expect(hunk.lines).toEqual([
      { kind: "context", text: "const a = 1;", oldNumber: 1, newNumber: 1 },
      { kind: "del", text: "const b = 2;", oldNumber: 2, newNumber: null },
      { kind: "add", text: "const b = 3;", oldNumber: null, newNumber: 2 },
      { kind: "add", text: "const c = 4;", oldNumber: null, newNumber: 3 },
      { kind: "context", text: "const d = 5;", oldNumber: 3, newNumber: 4 },
    ]);
    expect(diffFileLineCounts(file)).toEqual({ additions: 2, deletions: 1 });
    expect(diffFileDisplayPath(file)).toBe("foo.ts");
  });

  it("parses added and deleted files via /dev/null", () => {
    const patch = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "index 0000000..3b18e51",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1 @@",
      "+hello world",
      "diff --git a/old.txt b/old.txt",
      "deleted file mode 100644",
      "index 3b18e51..0000000",
      "--- a/old.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-goodbye",
      "",
    ].join("\n");
    const files = parseUnifiedDiff(patch);
    expect(files).toHaveLength(2);
    expect(files[0]!.status).toBe("added");
    expect(files[0]!.oldPath).toBeNull();
    expect(files[0]!.newPath).toBe("new.txt");
    expect(files[1]!.status).toBe("deleted");
    expect(files[1]!.oldPath).toBe("old.txt");
    expect(files[1]!.newPath).toBeNull();
    expect(diffFileDisplayPath(files[1]!)).toBe("old.txt");
  });

  it("parses renames", () => {
    const patch = [
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 92%",
      "rename from src/old.ts",
      "rename to src/new.ts",
      "index 1234567..89abcde 100644",
      "--- a/src/old.ts",
      "+++ b/src/new.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    const file = parseUnifiedDiff(patch)[0]!;
    expect(file.status).toBe("renamed");
    expect(file.oldPath).toBe("src/old.ts");
    expect(file.newPath).toBe("src/new.ts");
  });

  it("marks binary files and skips binary patch bodies", () => {
    const patch = [
      "diff --git a/logo.png b/logo.png",
      "index 1234567..89abcde 100644",
      "GIT binary patch",
      "literal 12",
      "abcXYZ123$%^",
      "",
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "",
    ].join("\n");
    const files = parseUnifiedDiff(patch);
    expect(files[0]!.isBinary).toBe(true);
    expect(files[0]!.hunks).toHaveLength(0);
    expect(files[1]!.isBinary).toBe(false);
    expect(files[1]!.hunks[0]!.lines).toHaveLength(2);
  });

  it("handles the compact 'Binary files ... differ' form", () => {
    const patch = [
      "diff --git a/data.bin b/data.bin",
      "index 1234567..89abcde 100644",
      "Binary files a/data.bin and b/data.bin differ",
      "",
    ].join("\n");
    const file = parseUnifiedDiff(patch)[0]!;
    expect(file.isBinary).toBe(true);
  });

  it("records missing trailing newlines", () => {
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "index 1234567..89abcde 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const file = parseUnifiedDiff(patch)[0]!;
    expect(file.hunks[0]!.lines[0]!.noNewline).toBe(true);
    expect(file.hunks[0]!.lines[1]!.noNewline).toBe(true);
  });

  it("does not confuse hunk lines starting with --- / +++ for file headers", () => {
    const patch = [
      "diff --git a/a.md b/a.md",
      "index 1234567..89abcde 100644",
      "--- a/a.md",
      "+++ b/a.md",
      "@@ -1,2 +1,2 @@",
      "--- a deleted yaml marker",
      "+++ an added yaml marker",
      "",
    ].join("\n");
    const file = parseUnifiedDiff(patch)[0]!;
    expect(file.hunks).toHaveLength(1);
    expect(file.hunks[0]!.lines).toEqual([
      { kind: "del", text: "-- a deleted yaml marker", oldNumber: 1, newNumber: null },
      { kind: "add", text: "++ an added yaml marker", oldNumber: null, newNumber: 1 },
    ]);
  });

  it("parses multiple hunks with running line numbers", () => {
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "index 1234567..89abcde 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "@@ -10,2 +10,3 @@",
      " ctx",
      "-c",
      "+d",
      "+e",
      "",
    ].join("\n");
    const file = parseUnifiedDiff(patch)[0]!;
    expect(file.hunks).toHaveLength(2);
    expect(file.hunks[1]!.lines[0]).toEqual({
      kind: "context",
      text: "ctx",
      oldNumber: 10,
      newNumber: 10,
    });
    expect(file.hunks[1]!.lines.at(-1)).toEqual({
      kind: "add",
      text: "e",
      oldNumber: null,
      newNumber: 12,
    });
  });

  it("handles single-line hunk headers without counts", () => {
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "index 1234567..89abcde 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    const file = parseUnifiedDiff(patch)[0]!;
    expect(file.hunks[0]!.oldCount).toBe(1);
    expect(file.hunks[0]!.newCount).toBe(1);
  });

  it("dequotes C-style quoted paths", () => {
    const patch = [
      'diff --git "a/weird\\tname.txt" "b/weird\\tname.txt"',
      "index 1234567..89abcde 100644",
      '--- "a/weird\\tname.txt"',
      '+++ "b/weird\\tname.txt"',
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    const file = parseUnifiedDiff(patch)[0]!;
    expect(file.oldPath).toBe("weird\tname.txt");
    expect(file.newPath).toBe("weird\tname.txt");
  });

  it("returns an empty list for empty or non-diff input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("not a diff\njust text\n")).toEqual([]);
  });

  it("does not append a phantom line when the patch lacks a trailing newline", () => {
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "index 1234567..89abcde 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n");
    const file = parseUnifiedDiff(patch)[0]!;
    expect(file.hunks[0]!.lines).toHaveLength(2);
  });
});

describe("capPatch", () => {
  it("passes patches under the cap through unchanged", () => {
    expect(capPatch("small patch")).toEqual({ patch: "small patch", truncated: false });
  });

  it("cuts patches over the cap and flags them", () => {
    const result = capPatch("x".repeat(300), 100);
    expect(result.patch).toBe("x".repeat(100));
    expect(result.truncated).toBe(true);
  });

  it("treats a patch exactly at the cap as untruncated", () => {
    expect(capPatch("x".repeat(100), 100).truncated).toBe(false);
  });

  it("does not split a surrogate pair (emoji) at the cut boundary", () => {
    // 'a' followed by emoji (each a UTF-16 surrogate pair); cap=2 lands between
    // the first emoji's high and low surrogate.
    const result = capPatch(`a${"😀".repeat(10)}`, 2);
    expect(result.truncated).toBe(true);
    expect(result.patch).toBe("a"); // backed off the lone high surrogate
    // A lone surrogate would make encodeURIComponent throw URIError.
    expect(() => encodeURIComponent(result.patch)).not.toThrow();
  });
});
