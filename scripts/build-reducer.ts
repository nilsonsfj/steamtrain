import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entryPath = path.resolve(__dirname, "../src/web/reducer.ts");
const bundlePath = path.resolve(__dirname, "../src/web/public/steamtrain-reducer.bundle.js");

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

  const bundleCode = result.outputFiles[0]!.text.trim();
  // The bundle is a real, standalone browser script now (it lives in its own
  // `.js` file served at `/static/steamtrain-reducer.bundle.js`), so no
  // template-literal escaping is needed — just tag it generated for the linter.
  const generated = `// @generated\n${bundleCode}\n`;

  const existed = fs.existsSync(bundlePath);
  const previous = existed ? fs.readFileSync(bundlePath, "utf8") : null;
  if (previous === generated) {
    console.log("Embedded reducer is already up to date. Skipping write.");
    return;
  }

  fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
  fs.writeFileSync(bundlePath, generated, "utf8");
  console.log(`Bundled reducer -> ${path.relative(path.resolve(__dirname, ".."), bundlePath)}`);
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
