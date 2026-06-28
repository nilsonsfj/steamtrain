import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("reducer bundle lockstep", () => {
  it("verifies that src/web/public/steamtrain-reducer.bundle.js has the latest bundled reducer", async () => {
    const entryPath = path.resolve(__dirname, "../src/web/reducer.ts");
    const bundlePath = path.resolve(__dirname, "../src/web/public/steamtrain-reducer.bundle.js");

    const result = await esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      format: "iife",
      globalName: "SteamtrainReducer",
      write: false,
      target: ["es2020"],
    });

    const rawCode = result.outputFiles[0]!.text.trim();
    const expectedCode = `// @generated\n${rawCode}\n`;

    expect(fs.existsSync(bundlePath)).toBe(true);
    const onDisk = fs.readFileSync(bundlePath, "utf8");

    expect(onDisk).toBe(expectedCode);
  });
});
