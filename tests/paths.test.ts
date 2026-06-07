import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { homeRelativePath } from "../src/paths";

describe("homeRelativePath", () => {
  it("prefixes paths under home with ~/", () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-home-"));
    expect(homeRelativePath(home, home)).toBe("~");
    expect(homeRelativePath(join(home, ".steamtrain", "workspace.json"), home)).toBe(
      "~/.steamtrain/workspace.json",
    );
  });

  it("leaves paths outside home unchanged", () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-home-"));
    const outside = join(tmpdir(), "elsewhere", "workspace.json");
    expect(homeRelativePath(outside, home)).toBe(outside);
  });
});
