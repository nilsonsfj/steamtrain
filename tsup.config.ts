import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.tsx" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  clean: true,
  sourcemap: true,
  dts: true,
  // Keep runtime deps external; they are installed from package.json.
  skipNodeModulesBundle: true,
  // Add a shebang so the built bin is directly executable.
  banner: { js: "#!/usr/bin/env node" },
});
