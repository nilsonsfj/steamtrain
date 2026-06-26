import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entryPath = path.resolve(__dirname, "../src/web/reducer.ts");
const htmlPath = path.resolve(__dirname, "../src/web/html.ts");

async function main() {
  const result = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    format: "iife",
    globalName: "SteamtrainReducer",
    write: false,
    target: ["es2020"],
  });

  if (!result.outputFiles || result.outputFiles.length === 0) {
    throw new Error("No output from esbuild build");
  }

  const rawCode = result.outputFiles[0]!.text;
  // Escape backticks and ${} to prevent string interpolation errors inside html.ts PAGE_HTML template literal
  const escapedCode = rawCode.trim().replace(/`/g, "\\`").replace(/\${/g, "\\${");

  const htmlContent = fs.readFileSync(htmlPath, "utf8");

  // Robustly replace content inside markers using Regex
  const regex = /(\/\* BEGIN_REDUCER_BUNDLE \*\/)[\s\S]*?(\/\* END_REDUCER_BUNDLE \*\/)/;
  if (!regex.test(htmlContent)) {
    throw new Error("Reducer bundle markers not found in html.ts");
  }

  const updatedHtmlContent = htmlContent.replace(regex, `$1\n// @generated\n${escapedCode}\n  $2`);

  if (htmlContent === updatedHtmlContent) {
    console.log("Embedded reducer is already up to date. Skipping write.");
    return;
  }

  fs.writeFileSync(htmlPath, updatedHtmlContent, "utf8");
  console.log("Successfully bundled and embedded reducer in src/web/html.ts");
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
