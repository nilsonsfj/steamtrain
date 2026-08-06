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

  it("emits every asset with its revision", () => {
    const revs = Object.fromEntries(WEB_ASSETS.map((a) => [a.file, `rev-${a.file}`]));
    const html = renderIndex(revs);
    for (const asset of WEB_ASSETS) {
      expect(html).toContain(`/static/${asset.file}?v=rev-${asset.file}`);
    }
  });

  it("emits stylesheets and scripts in manifest order", () => {
    // Order is the manifest's job for these two: the client modules share a
    // `window.Steamtrain` namespace with no module loader, so execution order
    // is exactly load order. Fonts carry no such guarantee — their @font-face
    // block is emitted ahead of the stylesheets that reference it.
    const revs = Object.fromEntries(WEB_ASSETS.map((a) => [a.file, `rev-${a.file}`]));
    const html = renderIndex(revs);
    const positions = WEB_ASSETS.filter((a) => a.kind !== "font").map((a) =>
      html.indexOf(`/static/${a.file}?v=rev-${a.file}`),
    );
    expect(positions.some((p) => p === -1)).toBe(false);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("declares the fonts before the stylesheets that use them", () => {
    const revs = Object.fromEntries(WEB_ASSETS.map((a) => [a.file, "v"]));
    const html = renderIndex(revs);
    expect(html.indexOf("@font-face")).toBeLessThan(html.indexOf("/static/tokens.css"));
  });

  it("emits stylesheets as links, scripts as deferred tags, and fonts as @font-face", () => {
    const revs = Object.fromEntries(WEB_ASSETS.map((a) => [a.file, "v"]));
    const html = renderIndex(revs);
    for (const asset of WEB_ASSETS) {
      const url = `/static/${asset.file}?v=v`;
      if (asset.kind === "css") expect(html).toContain(`<link rel="stylesheet" href="${url}" />`);
      else if (asset.kind === "js") expect(html).toContain(`<script src="${url}" defer></script>`);
      else expect(html).toContain(`src:url("${url}") format("woff2")`);
    }
  });

  it("gives every font asset the descriptors its @font-face rule needs", () => {
    // A font in the manifest without them would be served but never used —
    // the page would silently fall back to a system face.
    for (const asset of WEB_ASSETS.filter((a) => a.kind === "font")) {
      expect(asset.font?.family).toBeTruthy();
      expect(asset.font?.weight).toBeTruthy();
      expect(asset.mime).toBe("font/woff2");
    }
  });

  it("requests no fonts from a third party", () => {
    const revs = Object.fromEntries(WEB_ASSETS.map((a) => [a.file, "v"]));
    const html = renderIndex(revs);
    expect(html).not.toContain("Space+Grotesk");
    // Self-hosted since M2: an offline desktop build has to render the same,
    // and a UI reporting on private repositories should not announce every
    // launch to a font CDN.
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).not.toContain("fonts.gstatic.com");
    expect(html).toContain('@font-face{font-family:"IBM Plex Mono"');
  });
});
