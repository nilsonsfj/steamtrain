import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

/**
 * Rasterise `build/icon.svg` into `build/icon.png`.
 *
 * The PNG is committed — electron-builder needs a raster source to derive
 * `.icns`, `.ico` and the Linux size ladder from, and packaging must not depend
 * on a browser being installed. This script exists so that binary is
 * reproducible from the SVG next to it rather than being an artifact nobody can
 * regenerate.
 *
 *   npx playwright install chromium   # once
 *   bun scripts/build-icon.ts
 *
 * Chromium because it is already a dependency of the e2e suite and renders the
 * gradients and the squircle exactly as the SVG describes them. Set
 * CHROMIUM_PATH to use a browser Playwright did not install.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "build", "icon.svg");
const OUTPUT = join(ROOT, "build", "icon.png");

/** electron-builder wants at least 512; 1024 is what macOS asks for. */
const SIZE = 1024;

async function main(): Promise<void> {
  const svg = readFileSync(SOURCE, "utf8");
  const executablePath = process.env.CHROMIUM_PATH;
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  try {
    const page = await browser.newPage({
      viewport: { width: SIZE, height: SIZE },
      deviceScaleFactor: 1,
    });
    // The SVG is inlined rather than loaded, so its markup lands in the page
    // verbatim. That is safe for exactly one reason: `SOURCE` is a file in this
    // repository. Pointing this at an SVG from anywhere else would need a real
    // sanitiser first.
    //
    // Transparent outside the squircle: the rounded corners have to be actual
    // transparency, not the page's white, or macOS renders a white frame.
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`,
    );
    await page.screenshot({ path: OUTPUT, omitBackground: true });
    console.log(`wrote ${OUTPUT} (${SIZE}×${SIZE})`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
