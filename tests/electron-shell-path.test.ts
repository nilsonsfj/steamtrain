import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";
import {
  mergePath,
  parsePathFromEnvOutput,
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

describe("shouldSkipShellPath", () => {
  it("skips when launched from a terminal", () => {
    expect(shouldSkipShellPath({ TERM: "xterm-256color" })).toBe(true);
  });

  it("resolves when there is no terminal, as in a Finder launch", () => {
    // Guarded: on Windows the login-shell trick does not apply at all.
    expect(shouldSkipShellPath({})).toBe(process.platform === "win32");
  });
});
