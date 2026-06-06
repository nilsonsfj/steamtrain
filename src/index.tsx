import { render } from "ink";
import { runCli } from "./cli";
import { loadConfig } from "./config";
import { App } from "./tui/App";
import { loadWorkspaceConfig } from "./workspace";

/**
 * steamtrain entry point.
 *
 *   bun src/index.tsx     # dev (TSX, no build step)
 *   steamtrain            # after `npm run build` + global install
 *
 * With no args, loads project config (defaults + optional steamtrain.json) and
 * workspace presets (~/.steamtrain/workspace.json), then renders the TUI.
 * Workflow subcommands run headlessly for scripts/CI.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    process.exitCode = await runCli(args);
    return;
  }

  const { config, source, warning } = loadConfig();
  const {
    config: workspaces,
    source: workspaceSource,
    warning: workspaceWarning,
  } = loadWorkspaceConfig();
  const app = render(
    <App
      config={config}
      configSource={source}
      configWarning={warning}
      workspaces={workspaces}
      workspaceSource={workspaceSource}
      workspaceWarning={workspaceWarning}
    />,
  );
  void app.waitUntilExit();
}

void main();
