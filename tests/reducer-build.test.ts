import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("reducer bundle lockstep", () => {
  it("verifies that src/web/html.ts has the latest bundled reducer embedded", async () => {
    const entryPath = path.resolve(__dirname, "../src/web/reducer.ts");
    const htmlPath = path.resolve(__dirname, "../src/web/html.ts");

    const result = await esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      format: "iife",
      globalName: "SteamtrainReducer",
      write: false,
    });

    const rawCode = result.outputFiles[0]!.text;
    const expectedCode = rawCode.trim().replace(/`/g, "\\`").replace(/\${/g, "\\${");

    const htmlContent = fs.readFileSync(htmlPath, "utf8");
    const beginMarker = "/* BEGIN_REDUCER_BUNDLE */";
    const endMarker = "/* END_REDUCER_BUNDLE */";

    const beginIndex = htmlContent.indexOf(beginMarker);
    const endIndex = htmlContent.indexOf(endMarker);

    expect(beginIndex).not.toBe(-1);
    expect(endIndex).not.toBe(-1);

    const embeddedCode = htmlContent.slice(beginIndex + beginMarker.length, endIndex).trim();

    expect(embeddedCode).toBe(expectedCode);
  });
});
