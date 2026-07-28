import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WEB_ASSETS, renderIndex } from "../src/web/html";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public");

describe("web asset manifest", () => {
  it("lists only files that exist on disk", () => {
    const missing = WEB_ASSETS.filter((a) => !existsSync(join(PUBLIC_DIR, a.file)));
    expect(missing.map((a) => a.file)).toEqual([]);
  });

  it("has no duplicate entries", () => {
    const files = WEB_ASSETS.map((a) => a.file);
    expect(new Set(files).size).toBe(files.length);
  });

  it("emits every asset in manifest order with its revision", () => {
    const revs = Object.fromEntries(WEB_ASSETS.map((a) => [a.file, `rev-${a.file}`]));
    const html = renderIndex(revs);
    const positions = WEB_ASSETS.map((a) => html.indexOf(`/static/${a.file}?v=rev-${a.file}`));
    expect(positions.some((p) => p === -1)).toBe(false);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("emits stylesheets as links and scripts as deferred script tags", () => {
    const revs = Object.fromEntries(WEB_ASSETS.map((a) => [a.file, "v"]));
    const html = renderIndex(revs);
    for (const asset of WEB_ASSETS) {
      const url = `/static/${asset.file}?v=v`;
      if (asset.kind === "css") expect(html).toContain(`<link rel="stylesheet" href="${url}" />`);
      else expect(html).toContain(`<script src="${url}" defer></script>`);
    }
  });

  it("does not request Space Grotesk", () => {
    const revs = Object.fromEntries(WEB_ASSETS.map((a) => [a.file, "v"]));
    expect(renderIndex(revs)).not.toContain("Space+Grotesk");
  });
});
