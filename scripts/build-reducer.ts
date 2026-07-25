import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface BundleSpec {
  entry: string;
  out: string;
  globalName: string;
  /** Log label used in the "already up to date" / "bundled" messages. */
  label: string;
}

const BUNDLES: BundleSpec[] = [
  {
    entry: path.resolve(__dirname, "../src/web/reducer.ts"),
    out: path.resolve(__dirname, "../src/web/public/steamtrain-reducer.bundle.js"),
    globalName: "SteamtrainReducer",
    label: "reducer",
  },
  {
    entry: path.resolve(__dirname, "../src/web/diff-view.ts"),
    out: path.resolve(__dirname, "../src/web/public/steamtrain-diff.bundle.js"),
    globalName: "SteamtrainDiff",
    label: "diff view",
  },
];

async function buildBundle(spec: BundleSpec) {
  const result = await esbuild.build({
    entryPoints: [spec.entry],
    bundle: true,
    format: "iife",
    globalName: spec.globalName,
    write: false,
    target: ["es2020"],
  });

  if (!result.outputFiles || result.outputFiles.length === 0) {
    throw new Error("No output from esbuild build");
  }

  const bundleCode = result.outputFiles[0]!.text.trim();
  // The bundle is a real, standalone browser script now (it lives in its own
  // `.js` file served at `/static/steamtrain-*.bundle.js`), so no
  // template-literal escaping is needed — just tag it generated for the linter.
  const generated = `// @generated\n${bundleCode}\n`;

  const existed = fs.existsSync(spec.out);
  const previous = existed ? fs.readFileSync(spec.out, "utf8") : null;
  if (previous === generated) {
    console.log(`Embedded ${spec.label} is already up to date. Skipping write.`);
    return;
  }

  fs.mkdirSync(path.dirname(spec.out), { recursive: true });
  fs.writeFileSync(spec.out, generated, "utf8");
  console.log(`Bundled ${spec.label} -> ${path.relative(path.resolve(__dirname, ".."), spec.out)}`);
}

async function main() {
  for (const spec of BUNDLES) {
    await buildBundle(spec);
  }
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
