import { render } from "ink";
import { loadConfig } from "./config";
import { App } from "./tui/App";

/**
 * steamtrain entry point.
 *
 *   bun src/index.tsx     # dev (TSX, no build step)
 *   steamtrain            # after `npm run build` + global install
 *
 * Loads config (defaults + optional steamtrain.json), then renders the TUI.
 * The doctor preflight and dispatch happen inside the app.
 */
function main(): void {
  const { config, source, warning } = loadConfig();
  const app = render(<App config={config} configSource={source} configWarning={warning} />);
  void app.waitUntilExit();
}

main();
