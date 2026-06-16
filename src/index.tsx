import { homedir } from "node:os";
import { render } from "ink";
import { parseGlobalArgs, runCli } from "./cli";
import { configDisplayLabel, loadConfig } from "./config";
import { loadSettings } from "./settings";
import { App } from "./tui/App";
import { startWebUi } from "./web";
import { loadWorkflowCatalog } from "./workflow";
import { loadWorkspaceConfig, workspaceScopeLabel } from "./workspace";

/**
 * steamtrain entry point.
 *
 *   bun src/index.tsx     # dev (TSX, no build step)
 *   steamtrain            # after `npm run build` + global install
 *
 * With no args, loads project config (defaults + optional steamtrain.json),
 * user workflows (~/.steamtrain/workflows.json), workspace presets, then renders the TUI.
 */
async function main(): Promise<void> {
  const { args, workspacePath, configPath, webUi, port, host, error } = parseGlobalArgs(
    process.argv.slice(2),
  );
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
  const workflowCatalog = loadWorkflowCatalog({
    home,
    projectWorkflows: config.workflows,
  });

  if (webUi) {
    if (warning) process.stderr.write(`${warning}\n`);
    if (workspaceWarning) process.stderr.write(`${workspaceWarning}\n`);
    if (workflowCatalog.warning) process.stderr.write(`${workflowCatalog.warning}\n`);
    const { server } = await startWebUi({
      config,
      workspaces,
      workflowCatalog,
      configLabel,
      port,
      host,
    });
    const shutdown = (): void => {
      server.close(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  const app = render(
    <App
      config={config}
      configSource={configLabel}
      configWarning={warning}
      settings={settings}
      settingsWarning={settingsWarning}
      workflowCatalog={workflowCatalog}
      workspaces={workspaces}
      workspaceScope={workspaceScope}
      workspaceLabel={workspaceScopeLabel(workspaceScope, home)}
      workspaceWarning={workspaceWarning}
    />,
  );
  void app.waitUntilExit();
}

void main();
