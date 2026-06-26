import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";

const reducerPath = path.resolve("src/workflow/reducer.ts");
const htmlPath = path.resolve("src/web/html.ts");

async function main() {
  const result = await esbuild.build({
    entryPoints: [reducerPath],
    bundle: true,
    format: "iife",
    globalName: "SteamtrainReducer",
    write: false,
  });

  if (!result.outputFiles || result.outputFiles.length === 0) {
    throw new Error("No output from esbuild build");
  }

  const code = result.outputFiles[0]!.text;

  const htmlContent = fs.readFileSync(htmlPath, "utf8");
  const beginMarker = "/* BEGIN_REDUCER_BUNDLE */";
  const endMarker = "/* END_REDUCER_BUNDLE */";

  const beginIndex = htmlContent.indexOf(beginMarker);
  const endIndex = htmlContent.indexOf(endMarker);

  if (beginIndex === -1 || endIndex === -1) {
    throw new Error("Markers not found in html.ts");
  }

  const updatedHtmlContent =
    htmlContent.slice(0, beginIndex + beginMarker.length) +
    "\n" +
    code.trim() +
    "\n  " +
    htmlContent.slice(endIndex);

  fs.writeFileSync(htmlPath, updatedHtmlContent, "utf8");
  console.log("Successfully bundled and embedded reducer in src/web/html.ts");
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
