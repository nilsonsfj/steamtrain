import { render } from "ink";
import { runCli } from "./cli";
import { loadConfig } from "./config";
import { App } from "./tui/App";

/**
 * steamtrain entry point.
 *
 *   bun src/index.tsx     # dev (TSX, no build step)
 *   steamtrain            # after `npm run build` + global install
 *
 * With no args, loads config (defaults + optional steamtrain.json), then renders
 * the workflow-first TUI. Workflow subcommands run headlessly for scripts/CI.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    process.exitCode = await runCli(args);
    return;
  }

  const { config, source, warning } = loadConfig();
  const app = render(<App config={config} configSource={source} configWarning={warning} />);
  void app.waitUntilExit();
}

void main();
