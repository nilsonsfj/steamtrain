import { homedir } from "node:os";
import { render } from "ink";
import { parseGlobalArgs, runCli } from "./cli";
import { configDisplayLabel, loadConfig } from "./config";
import { resolveProjectDir, resolveProjectIdentity } from "./project";
import { loadSettings } from "./settings";
import { App } from "./tui/App";
import { STEAMTRAIN_VERSION } from "./version";
import { resolveWebAuthToken, resolveWebReadToken, startWebUi } from "./web";
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
 *
 * Pass `--project-dir <path>` (alias `--cwd`) to operate on another directory
 * as if steamtrain were launched from there — config, `.steamtrain/` state,
 * and agent cwd all follow that path.
 */
// `steamtrain workflow list | head` closes stdout early; without a handler
// the resulting EPIPE is an unhandled 'error' event that crashes with a stack
// trace. Downstream closing the pipe is normal — end quietly like other CLIs.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  });
}

async function main(): Promise<void> {
  const {
    args,
    workspacePath,
    configPath,
    projectDir,
    webUi,
    port,
    host,
    authToken,
    readToken,
    readOnly,
    noAuth,
    trustProxy,
    version,
    error,
  } = parseGlobalArgs(process.argv.slice(2));
  if (error) {
    process.stderr.write(`${error}\n`);
    process.exitCode = 1;
    return;
  }

  if (version) {
    process.stdout.write(`steamtrain ${STEAMTRAIN_VERSION}\n`);
    return;
  }

  const projectResolved = resolveProjectDir(projectDir ?? process.cwd());
  if (!projectResolved.ok) {
    process.stderr.write(`${projectResolved.error}\n`);
    process.exitCode = 1;
    return;
  }
  const cwd = projectResolved.cwd;

  if (args.length > 0) {
    process.exitCode = await runCli(args, { cwd, workspacePath, configPath });
    return;
  }

  const home = homedir();
  const { config, scope, user, userAgents, projectAgents, userApis, projectApis, warning } =
    loadConfig({
      cwd,
      customPath: configPath,
      home,
    });
  const project = resolveProjectIdentity(cwd, { home, configName: config.name });
  const { settings, hasUserFile, warning: settingsWarning } = loadSettings(home);
  const configLabel = configDisplayLabel(scope, {
    hasUserSettings: hasUserFile,
    hasUserConfig: user?.exists,
    home,
  });
  const {
    config: workspaces,
    scope: workspaceScope,
    warning: workspaceWarning,
  } = loadWorkspaceConfig({
    cwd,
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
    // --auth-token / --read-token win; STEAMTRAIN_*_TOKEN keeps secrets out of
    // the process list and shell history; --no-auth explicitly disables both.
    const envToken = process.env.STEAMTRAIN_AUTH_TOKEN?.trim() || undefined;
    const envReadToken = process.env.STEAMTRAIN_READ_TOKEN?.trim() || undefined;
    const resolvedAuth = resolveWebAuthToken({ authToken, envToken, noAuth });
    const resolvedRead = resolveWebReadToken({ readToken, envToken: envReadToken, noAuth });
    if (resolvedAuth && resolvedRead && resolvedAuth === resolvedRead) {
      process.stderr.write(
        "--auth-token and --read-token must be different values (including after STEAMTRAIN_AUTH_TOKEN / STEAMTRAIN_READ_TOKEN resolution)\n",
      );
      process.exitCode = 1;
      return;
    }
    const { server } = await startWebUi({
      config,
      workspaces,
      workflowCatalog,
      configLabel,
      project,
      cwd,
      configPath: scope.path,
      userConfigPath: scope.kind === "custom" ? undefined : user?.path,
      userAgents,
      projectAgents,
      userApis,
      projectApis,
      customConfig: scope.kind === "custom",
      home,
      port,
      host,
      authToken: resolvedAuth,
      readToken: resolvedRead,
      readOnly,
      noAuth,
      trustProxy,
    });
    const shutdown = (): void => {
      server.close(() => process.exit(0));
      // SSE responses are held open with keep-alive (and EventSource
      // auto-reconnects), so server.close() alone would never fire its
      // callback. Tear down live sockets, then force-exit as a safety net.
      server.closeAllConnections?.();
      setTimeout(() => process.exit(0), 1000).unref();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  const app = render(
    <App
      config={config}
      configSource={configLabel}
      configPath={scope.path}
      configKind={scope.kind}
      cwd={cwd}
      project={project}
      userAgents={userAgents}
      projectAgents={projectAgents}
      userApis={userApis}
      projectApis={projectApis}
      hasUserSettings={hasUserFile}
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
