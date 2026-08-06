import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";
import { describeEffectivePath } from "../src/doctor";

const always = (): boolean => true;

describe("describeEffectivePath", () => {
  it("lists PATH entries in order", () => {
    const env = { PATH: ["/usr/bin", "/opt/homebrew/bin"].join(delimiter) };
    const result = describeEffectivePath(env, { exists: always });
    expect(result.entries.map((e) => e.dir)).toEqual(["/usr/bin", "/opt/homebrew/bin"]);
  });

  it("collapses duplicates, keeping the first position", () => {
    // A PATH assembled from a login shell plus a fallback union repeats
    // directories routinely; showing /usr/bin four times hides the one line
    // that matters.
    const env = { PATH: ["/usr/bin", "/opt/bin", "/usr/bin"].join(delimiter) };
    const result = describeEffectivePath(env, { exists: always });
    expect(result.entries.map((e) => e.dir)).toEqual(["/usr/bin", "/opt/bin"]);
  });

  it("skips empty segments", () => {
    const env = { PATH: `${delimiter}/usr/bin${delimiter}${delimiter}` };
    const result = describeEffectivePath(env, { exists: always });
    expect(result.entries).toHaveLength(1);
  });

  it("flags directories that are not on disk", () => {
    const env = { PATH: ["/real", "/gone"].join(delimiter) };
    const result = describeEffectivePath(env, { exists: (p) => p === "/real" });
    expect(result.entries).toEqual([
      { dir: "/real", exists: true },
      { dir: "/gone", exists: false },
    ]);
  });

  it("handles an unset PATH", () => {
    expect(describeEffectivePath({}, { exists: always }).entries).toEqual([]);
  });

  it("reports the source the desktop app declared", () => {
    const env = { PATH: "/usr/bin", STEAMTRAIN_PATH_SOURCE: "login-shell" };
    expect(describeEffectivePath(env, { exists: always }).source).toBe("login-shell");
  });

  it("reports the fallback source", () => {
    const env = { PATH: "/usr/bin", STEAMTRAIN_PATH_SOURCE: "fallback" };
    expect(describeEffectivePath(env, { exists: always }).source).toBe("fallback");
  });

  it("defaults to inherited when nothing declared a source", () => {
    expect(describeEffectivePath({ PATH: "/usr/bin" }, { exists: always }).source).toBe(
      "inherited",
    );
  });

  it("does not echo an unrecognized source back into the UI", () => {
    const env = { PATH: "/usr/bin", STEAMTRAIN_PATH_SOURCE: "<script>alert(1)</script>" };
    expect(describeEffectivePath(env, { exists: always }).source).toBe("inherited");
  });

  it("carries the host's detail sentence through", () => {
    const env = {
      PATH: "/usr/bin",
      STEAMTRAIN_PATH_DETAIL: "Read from /bin/zsh as a login shell.",
    };
    expect(describeEffectivePath(env, { exists: always }).detail).toBe(
      "Read from /bin/zsh as a login shell.",
    );
  });

  it("omits a blank detail rather than reporting an empty line", () => {
    const env = { PATH: "/usr/bin", STEAMTRAIN_PATH_DETAIL: "   " };
    expect(describeEffectivePath(env, { exists: always }).detail).toBeUndefined();
  });

  it("knows when it is running under the desktop app", () => {
    expect(describeEffectivePath({ PATH: "/usr/bin" }, { exists: always }).desktop).toBe(false);
    const desktop = describeEffectivePath(
      { PATH: "/usr/bin", STEAMTRAIN_DESKTOP: "1" },
      { exists: always },
    );
    expect(desktop.desktop).toBe(true);
  });
});
