import { render } from "ink";
import { parseGlobalArgs, runCli } from "./cli";
import { loadConfig } from "./config";
import { loadSettings } from "./settings";
import { App } from "./tui/App";
import { loadWorkspaceConfig, workspaceScopeLabel } from "./workspace";

/**
 * steamtrain entry point.
 *
 *   bun src/index.tsx     # dev (TSX, no build step)
 *   steamtrain            # after `npm run build` + global install
 *
 * With no args, loads project config (defaults + optional steamtrain.json) and
 * workspace presets (~/.steamtrain/workspace.json or ./workspace.json), then
 * renders the TUI. Workflow subcommands run headlessly for scripts/CI.
 */
async function main(): Promise<void> {
  const { args, workspacePath, error } = parseGlobalArgs(process.argv.slice(2));
  if (error) {
    process.stderr.write(`${error}\n`);
    process.exitCode = 1;
    return;
  }

  if (args.length > 0) {
    process.exitCode = await runCli(args, { workspacePath });
    return;
  }

  const { config, source, warning } = loadConfig();
  const { settings, warning: settingsWarning } = loadSettings();
  const {
    config: workspaces,
    scope,
    warning: workspaceWarning,
  } = loadWorkspaceConfig({
    customPath: workspacePath,
  });
  const app = render(
    <App
      config={config}
      configSource={source}
      configWarning={warning}
      settings={settings}
      settingsWarning={settingsWarning}
      workspaces={workspaces}
      workspaceScope={scope}
      workspaceLabel={workspaceScopeLabel(scope)}
      workspaceWarning={workspaceWarning}
    />,
  );
  void app.waitUntilExit();
}

void main();
