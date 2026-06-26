import { describe, expect, it } from "vitest";
import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";

describe("reducer bundle lockstep", () => {
  it("verifies that src/web/html.ts has the latest bundled reducer embedded", async () => {
    const reducerPath = path.resolve("src/workflow/reducer.ts");
    const htmlPath = path.resolve("src/web/html.ts");

    const result = await esbuild.build({
      entryPoints: [reducerPath],
      bundle: true,
      format: "iife",
      globalName: "SteamtrainReducer",
      write: false,
    });

    const expectedCode = result.outputFiles[0]!.text.trim();

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
