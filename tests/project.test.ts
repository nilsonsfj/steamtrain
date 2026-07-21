import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatProjectLabel,
  resolveProjectDir,
  resolveProjectIdentity,
  sanitizeProjectName,
} from "../src/project";

describe("resolveProjectDir", () => {
  it("resolves an absolute existing directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "steamtrain-proj-"));
    const result = resolveProjectDir(dir);
    expect(result).toEqual({ ok: true, cwd: dir });
  });

  it("resolves a relative path against from", () => {
    const root = mkdtempSync(join(tmpdir(), "steamtrain-root-"));
    const child = join(root, "app");
    mkdirSync(child);
    const result = resolveProjectDir("app", { from: root });
    expect(result).toEqual({ ok: true, cwd: child });
  });

  it("rejects a missing path", () => {
    const result = resolveProjectDir(join(tmpdir(), "no-such-steamtrain-dir-xyz"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/does not exist/);
  });

  it("rejects a file path", () => {
    const dir = mkdtempSync(join(tmpdir(), "steamtrain-file-"));
    const file = join(dir, "not-a-dir.txt");
    writeFileSync(file, "x");
    const result = resolveProjectDir(file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not a directory/);
  });

  it("rejects an empty path", () => {
    const result = resolveProjectDir("   ");
    expect(result.ok).toBe(false);
  });
});

describe("resolveProjectIdentity", () => {
  it("prefers steamtrain.json config name", () => {
    const dir = mkdtempSync(join(tmpdir(), "steamtrain-id-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pkg-name" }));
    const id = resolveProjectIdentity(dir, { home: tmpdir(), configName: "Config Name" });
    expect(id.name).toBe("Config Name");
    expect(id.nameSource).toBe("config");
    expect(id.cwd).toBe(dir);
  });

  it("falls back to package.json name", () => {
    const dir = mkdtempSync(join(tmpdir(), "steamtrain-pkg-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@acme/widget" }));
    const id = resolveProjectIdentity(dir, { home: tmpdir() });
    expect(id.name).toBe("@acme/widget");
    expect(id.nameSource).toBe("package");
  });

  it("falls back to directory basename", () => {
    const dir = mkdtempSync(join(tmpdir(), "my-cool-app-"));
    const id = resolveProjectIdentity(dir, { home: tmpdir() });
    expect(id.nameSource).toBe("directory");
    expect(id.name).toMatch(/^my-cool-app-/);
  });

  it("home-relatives the display path", () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-home-"));
    const dir = join(home, "code", "demo");
    mkdirSync(dir, { recursive: true });
    const id = resolveProjectIdentity(dir, { home });
    expect(id.displayPath).toBe("~/code/demo");
  });
});

describe("sanitizeProjectName / formatProjectLabel", () => {
  it("trims and rejects empty names", () => {
    expect(sanitizeProjectName("  ")).toBeUndefined();
    expect(sanitizeProjectName("  hello  ")).toBe("hello");
  });

  it("formats a compact label", () => {
    const label = formatProjectLabel(
      {
        cwd: "/x",
        name: "demo",
        displayPath: "~/code/demo",
        nameSource: "directory",
      },
      42,
    );
    expect(label.primary).toBe("demo");
    expect(label.secondary).toBe("~/code/demo");
  });
});
