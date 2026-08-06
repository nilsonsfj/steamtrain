import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fallbackPathDirs,
  mergePath,
  parsePathFromEnvOutput,
  resolveShellPath,
  shouldSkipShellPath,
} from "../electron/main/shell-path";

/**
 * A GUI-launched app inherits a minimal PATH, so the desktop shell asks the
 * user's login shell for the real one. The parsing and merging are pure so they
 * can be checked without spawning a shell.
 */
describe("parsePathFromEnvOutput", () => {
  it("extracts PATH from an env dump", () => {
    const output = ["SHELL=/bin/zsh", "PATH=/usr/local/bin:/usr/bin", "TERM=xterm"].join("\n");
    expect(parsePathFromEnvOutput(output)).toBe("/usr/local/bin:/usr/bin");
  });

  it("keeps values that themselves contain '='", () => {
    const output = ["LS_COLORS=di=1;34:ln=35", "PATH=/opt/bin:/usr/bin"].join("\n");
    expect(parsePathFromEnvOutput(output)).toBe("/opt/bin:/usr/bin");
  });

  it("does not match variables that merely end in PATH", () => {
    const output = ["MANPATH=/usr/share/man", "PYTHONPATH=/srv/py"].join("\n");
    expect(parsePathFromEnvOutput(output)).toBeUndefined();
  });

  it("takes the last assignment when a shell exports PATH more than once", () => {
    const output = ["PATH=/first", "SHELL=/bin/bash", "PATH=/second"].join("\n");
    expect(parsePathFromEnvOutput(output)).toBe("/second");
  });

  it("returns undefined for output with no PATH at all", () => {
    expect(parsePathFromEnvOutput("SHELL=/bin/zsh\nTERM=xterm")).toBeUndefined();
  });

  it("ignores an empty PATH assignment", () => {
    expect(parsePathFromEnvOutput("PATH=")).toBeUndefined();
  });
});

describe("mergePath", () => {
  it("keeps base order and appends new entries", () => {
    expect(mergePath(`/a${delimiter}/b`, ["/c"])).toBe(`/a${delimiter}/b${delimiter}/c`);
  });

  it("drops duplicates without reordering", () => {
    expect(mergePath(`/a${delimiter}/b`, ["/a", "/c", "/b"])).toBe(
      `/a${delimiter}/b${delimiter}/c`,
    );
  });

  it("drops empty segments produced by stray delimiters", () => {
    expect(mergePath(`/a${delimiter}${delimiter}/b`, [""])).toBe(`/a${delimiter}/b`);
  });

  it("handles an undefined base", () => {
    expect(mergePath(undefined, ["/a"])).toBe("/a");
  });
});

describe("fallbackPathDirs", () => {
  const homes: string[] = [];

  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  function fakeHome(dirs: string[]): string {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-home-"));
    homes.push(home);
    for (const dir of dirs) mkdirSync(join(home, dir), { recursive: true });
    return home;
  }

  it("includes per-user toolchain directories that exist", () => {
    const home = fakeHome([".local/bin", ".cargo/bin"]);
    expect(fallbackPathDirs(home)).toEqual(
      expect.arrayContaining([join(home, ".local/bin"), join(home, ".cargo/bin")]),
    );
  });

  it("omits directories that do not exist", () => {
    const home = fakeHome([".local/bin"]);
    expect(fallbackPathDirs(home)).not.toContain(join(home, ".bun/bin"));
  });

  it("picks up every installed nvm node version", () => {
    const home = fakeHome([".nvm/versions/node/v20.11.0/bin", ".nvm/versions/node/v22.3.0/bin"]);
    expect(fallbackPathDirs(home)).toEqual(
      expect.arrayContaining([
        join(home, ".nvm/versions/node/v20.11.0/bin"),
        join(home, ".nvm/versions/node/v22.3.0/bin"),
      ]),
    );
  });

  it("survives a home with no nvm install", () => {
    const home = fakeHome([]);
    // Runs at app startup, so a missing ~/.nvm must not throw.
    expect(() => fallbackPathDirs(home)).not.toThrow();
  });

  it("returns no duplicates", () => {
    const home = fakeHome([".local/bin", ".nvm/versions/node/v20.11.0/bin"]);
    const dirs = fallbackPathDirs(home);
    expect(dirs).toHaveLength(new Set(dirs).size);
  });
});

describe("shouldSkipShellPath", () => {
  it("skips when launched from a terminal", () => {
    expect(shouldSkipShellPath({ TERM: "xterm-256color" })).toBe(true);
  });

  it("resolves when there is no terminal, as in a Finder launch", () => {
    // Guarded: on Windows the login-shell trick does not apply at all.
    expect(shouldSkipShellPath({})).toBe(process.platform === "win32");
  });
});

describe("resolveShellPath", () => {
  // The other two branches spawn a login shell, which is exactly what these
  // tests exist to avoid; the terminal branch is the deterministic one.
  it("keeps the inherited PATH when launched from a terminal", async () => {
    const resolved = await resolveShellPath({ TERM: "xterm-256color", PATH: "/usr/bin" });
    expect(resolved).toEqual({
      path: "/usr/bin",
      source: "inherited",
      detail: expect.stringContaining("terminal"),
    });
  });

  it("always carries a detail sentence, since the setup panel shows it verbatim", async () => {
    const resolved = await resolveShellPath({ TERM: "xterm", PATH: "/usr/bin" });
    expect(resolved.detail.length).toBeGreaterThan(0);
  });
});
