import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config";
import { startWebUi } from "../src/web";
import { loadWorkflowCatalog } from "../src/workflow";
import { loadWorkspaceConfig } from "../src/workspace";

/**
 * Notification deep links are built from a base URL that used to be computed
 * from the *requested* port, before `listen()`. With `--port 0` — how the
 * desktop app boots, so the OS picks a free port — every link read
 * `http://127.0.0.1:0/#run-…`.
 */
describe("web UI public base URL", () => {
  const dirs: string[] = [];
  const servers: { close(): void; closeAllConnections?: () => void }[] = [];

  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections?.();
      server.close();
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function boot(port: number) {
    const cwd = mkdtempSync(join(tmpdir(), "steamtrain-baseurl-"));
    const home = mkdtempSync(join(tmpdir(), "steamtrain-home-"));
    dirs.push(cwd, home);
    const started = await startWebUi({
      config: DEFAULT_CONFIG,
      workflowCatalog: loadWorkflowCatalog({ home }),
      workspaces: loadWorkspaceConfig({ cwd, home }).config,
      cwd,
      home,
      port,
      host: "127.0.0.1",
      // Keep the boot banner and doctor chatter out of the test output.
      stdout: () => {},
      stderr: () => {},
    });
    servers.push(started.server);
    return started;
  }

  it("reports the bound port when asked for an ephemeral one", async () => {
    const started = await boot(0);
    expect(started.port).toBeGreaterThan(0);
    expect(started.url).toBe(`http://127.0.0.1:${started.port}`);
  });

  it("builds notification deep links from the bound port, not the requested one", async () => {
    const started = await boot(0);
    expect(started.runs.getPublicBaseUrl()).toBe(`http://127.0.0.1:${started.port}`);
    // The regression this guards: a literal `:0` in every deep link.
    expect(started.runs.getPublicBaseUrl()).not.toContain(":0");
  });

  it("still uses an explicitly requested port", async () => {
    const started = await boot(0);
    // Re-bind on a port we know is free (the one just handed out), so the
    // explicit path is exercised without racing a hardcoded number.
    const port = started.port;
    started.server.closeAllConnections?.();
    await new Promise<void>((resolve) => started.server.close(() => resolve()));

    const second = await boot(port);
    expect(second.port).toBe(port);
    expect(second.runs.getPublicBaseUrl()).toBe(`http://127.0.0.1:${port}`);
  });
});
