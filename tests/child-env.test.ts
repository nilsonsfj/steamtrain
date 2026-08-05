import { describe, expect, it } from "vitest";
import { childEnv, electronNodePrefix } from "../src/util/child-env";

/**
 * Under the desktop app the engine runs as `ELECTRON_RUN_AS_NODE=1`, which must
 * reach steamtrain's own re-execs but never the leaf processes a run spawns —
 * several popular developer CLIs are themselves Electron apps and would start
 * headless as Node instead of as themselves.
 */
describe("childEnv", () => {
  it("strips ELECTRON_RUN_AS_NODE from the child environment", () => {
    const env = childEnv(undefined, { PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1" });
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("applies overrides on top of the base environment", () => {
    const env = childEnv({ FOO: "override" }, { FOO: "base", BAR: "kept" });
    expect(env).toMatchObject({ FOO: "override", BAR: "kept" });
  });

  it("strips the variable even when an override tries to set it", () => {
    const env = childEnv({ ELECTRON_RUN_AS_NODE: "1" }, { PATH: "/usr/bin" });
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it("is a plain env merge outside the desktop app", () => {
    const base = { PATH: "/usr/bin", HOME: "/home/u" };
    expect(childEnv({ EXTRA: "1" }, base)).toEqual({ ...base, EXTRA: "1" });
  });

  it("does not mutate the base environment", () => {
    const base = { ELECTRON_RUN_AS_NODE: "1" };
    childEnv(undefined, base);
    expect(base.ELECTRON_RUN_AS_NODE).toBe("1");
  });
});

describe("electronNodePrefix", () => {
  it("re-applies the variable inline when running under Electron", () => {
    expect(electronNodePrefix({ ELECTRON_RUN_AS_NODE: "1" })).toBe("ELECTRON_RUN_AS_NODE=1 ");
  });

  it("is empty for a normal install, leaving commands unchanged", () => {
    expect(electronNodePrefix({})).toBe("");
  });
});
