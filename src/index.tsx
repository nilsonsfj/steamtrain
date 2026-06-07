import { render } from "ink";
import { homedir } from "node:os";
import { parseGlobalArgs, runCli } from "./cli";
import { configDisplayLabel, loadConfig } from "./config";
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
  const { args, workspacePath, configPath, error } = parseGlobalArgs(process.argv.slice(2));
  if (error) {
    process.stderr.write(`${error}\n`);
    process.exitCode = 1;
    return;
  }

  if (args.length > 0) {
    process.exitCode = await runCli(args, { workspacePath, configPath });
    return;
  }

  const home = homedir();
  const { config, scope, warning } = loadConfig({ customPath: configPath });
  const { settings, hasUserFile, warning: settingsWarning } = loadSettings(home);
  const configLabel = configDisplayLabel(scope, { hasUserSettings: hasUserFile, home });
  const {
    config: workspaces,
    scope: workspaceScope,
    warning: workspaceWarning,
  } = loadWorkspaceConfig({
    customPath: workspacePath,
    home,
  });
  const app = render(
    <App
      config={config}
      configSource={configLabel}
      configWarning={warning}
      settings={settings}
      settingsWarning={settingsWarning}
      workspaces={workspaces}
      workspaceScope={workspaceScope}
      workspaceLabel={workspaceScopeLabel(workspaceScope, home)}
      workspaceWarning={workspaceWarning}
    />,
  );
  void app.waitUntilExit();
}

void main();
