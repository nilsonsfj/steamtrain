import { describe, expect, it } from "vitest";
import { entryCandidates, resolveEntry } from "../electron/main/entry";

/**
 * The desktop app forks the built CLI. Getting its path wrong is a hard boot
 * failure ("steamtrain is not built"), and the way it goes wrong is silent:
 * `app.getAppPath()` looks right until the app is launched by script path.
 */
describe("resolveEntry", () => {
  const mainDir = "/repo/dist-electron";

  it("resolves next to the main script when the app path is the script directory", () => {
    // `electron dist-electron/main.cjs` — what `npm run dev:electron` runs.
    const entry = resolveEntry({
      mainDir,
      appPath: "/repo/dist-electron",
      exists: (path) => path === "/repo/dist/index.js",
    });
    expect(entry).toBe("/repo/dist/index.js");
  });

  it("falls back to the app path when the bundle only exists there", () => {
    const entry = resolveEntry({
      mainDir: "/elsewhere/dist-electron",
      appPath: "/repo",
      exists: (path) => path === "/repo/dist/index.js",
    });
    expect(entry).toBe("/repo/dist/index.js");
  });

  it("reports every path it tried when nothing is built", () => {
    expect(() => resolveEntry({ mainDir, appPath: "/repo", exists: () => false })).toThrow(
      /not built[\s\S]*\/repo\/dist\/index\.js[\s\S]*npm run build/,
    );
  });

  it("does not list the same candidate twice", () => {
    expect(entryCandidates(mainDir, "/repo")).toEqual(["/repo/dist/index.js"]);
  });
});
