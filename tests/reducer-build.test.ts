import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mirrors BUNDLES in scripts/build-reducer.ts: each committed browser bundle
// must equal a fresh build of its entry point.
const BUNDLES = [
  {
    entry: "../src/web/reducer.ts",
    out: "../src/web/public/steamtrain-reducer.bundle.js",
    globalName: "SteamtrainReducer",
  },
  {
    entry: "../src/web/diff-view.ts",
    out: "../src/web/public/steamtrain-diff.bundle.js",
    globalName: "SteamtrainDiff",
  },
];

describe("browser bundle lockstep", () => {
  it.each(BUNDLES)("verifies that $out has the latest bundled source", async (spec) => {
    const bundlePath = path.resolve(__dirname, spec.out);

    const result = await esbuild.build({
      entryPoints: [path.resolve(__dirname, spec.entry)],
      bundle: true,
      format: "iife",
      globalName: spec.globalName,
      write: false,
      target: ["es2020"],
    });

    const rawCode = result.outputFiles[0]!.text.trim();
    const expectedCode = `// @generated\n${rawCode}\n`;

    expect(fs.existsSync(bundlePath)).toBe(true);
    expect(fs.readFileSync(bundlePath, "utf8")).toBe(expectedCode);
  });
});
