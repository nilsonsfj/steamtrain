import { describe, expect, it } from "vitest";
import { launchProjectPath, selectLaunchProject } from "../electron/main/launch-project";

describe("launchProjectPath", () => {
  const cwd = "/home/me";

  it("reads a positional path after the development entrypoint", () => {
    expect(
      launchProjectPath({
        argv: ["/usr/bin/electron", "/repo/dist-electron/main.cjs", "projects/app"],
        packaged: false,
        cwd,
      }),
    ).toBe("/home/me/projects/app");
  });

  it("reads a positional path after a packaged executable", () => {
    expect(
      launchProjectPath({
        argv: ["/opt/steamtrain", "/work/app"],
        packaged: true,
        cwd,
      }),
    ).toBe("/work/app");
  });

  it("ignores Electron switches", () => {
    expect(
      launchProjectPath({
        argv: [
          "/usr/bin/electron",
          "/repo/dist-electron/main.cjs",
          "--user-data-dir=/tmp/user-data",
          "--no-sandbox",
        ],
        packaged: false,
        cwd,
      }),
    ).toBeUndefined();
  });

  it("accepts the CLI project directory flags", () => {
    expect(
      launchProjectPath({
        argv: ["/opt/steamtrain", "--project-dir", "work/app"],
        packaged: true,
        cwd,
      }),
    ).toBe("/home/me/work/app");
  });

  it("returns no path when the app was launched without one", () => {
    expect(
      launchProjectPath({
        argv: ["/opt/steamtrain"],
        packaged: true,
        cwd,
      }),
    ).toBeUndefined();
  });
});

describe("selectLaunchProject", () => {
  it("uses an explicit path instead of the saved project", () => {
    expect(
      selectLaunchProject({
        explicitPath: "/work/new",
        recents: ["/work/last"],
        isDirectory: () => true,
      }),
    ).toBe("/work/new");
  });

  it("reopens the most recent project without an explicit path", () => {
    expect(
      selectLaunchProject({
        recents: ["/work/last", "/work/older"],
        isDirectory: (path) => path === "/work/last",
      }),
    ).toBe("/work/last");
  });

  it("requests the folder picker on the first run", () => {
    expect(selectLaunchProject({ recents: [], isDirectory: () => true })).toBeUndefined();
  });

  it("requests the folder picker when the saved project is gone", () => {
    expect(
      selectLaunchProject({
        recents: ["/work/gone"],
        isDirectory: () => false,
      }),
    ).toBeUndefined();
  });
});
