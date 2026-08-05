import { defineConfig } from "tsup";

/**
 * Build for the Electron desktop shell (`electron/`), kept separate from
 * `tsup.config.ts` so the CLI bundle is completely unaffected.
 *
 * CommonJS on purpose: a preload script running under `sandbox: true` must be
 * CJS, and a CJS main process avoids Electron's ESM loader edge cases.
 */
export default defineConfig({
  entry: {
    main: "electron/main/index.ts",
    preload: "electron/preload/index.ts",
  },
  outDir: "dist-electron",
  format: ["cjs"],
  platform: "node",
  target: "node20",
  clean: true,
  sourcemap: true,
  dts: false,
  // Provided by the Electron runtime, never bundled.
  external: ["electron"],
  // `.cjs` so the extension matches the format regardless of package `type`.
  outExtension: () => ({ js: ".cjs" }),
});
