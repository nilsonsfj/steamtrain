import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The locomotive mark is drawn once and placed three times: `FAVICON_SVG` holds
 * the canonical 32-unit geometry, and both `.brand-mark` (shell.css) and the app
 * icon (build/icon.svg) reproduce those coordinates inside a `<g>` that only
 * transforms them.
 *
 * That arrangement is the whole point of the change, and nothing else enforces
 * it. The three files are edited independently, share no build step, and a
 * drifted copy is invisible in review — the surfaces are a browser tab, a topbar
 * sprite and a dock icon, which nobody compares side by side. The previous
 * divergence (a detailed engine in two of them, a silhouette in the third)
 * survived precisely because it was never asserted.
 *
 * So these tests compare the geometry rather than snapshotting it. A snapshot
 * would pin one copy and say nothing about whether the other two still agree.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const htmlTs = readFileSync(join(ROOT, "src", "web", "html.ts"), "utf8");
const shellCss = readFileSync(join(ROOT, "src", "web", "public", "shell.css"), "utf8");
const iconSvg = readFileSync(join(ROOT, "build", "icon.svg"), "utf8");

interface Shape {
  tag: string;
  attrs: Record<string, string>;
}

/**
 * A capture group the pattern always fills, narrowed for `noUncheckedIndexed-
 * Access`. Every group below sits outside an alternation and outside `?`, so
 * the throw is unreachable — it exists to keep that assumption checked rather
 * than asserted away, since a later edit to one of these patterns could quietly
 * make a group optional.
 */
function group(m: RegExpMatchArray, i: number): string {
  const v = m[i];
  if (v === undefined) throw new Error(`capture group ${i} did not participate`);
  return v;
}

/**
 * Pull the drawing primitives out of SVG markup. Attribute quoting differs
 * between the sources (the CSS data URI uses `%27`, which decodes to single
 * quotes), so both styles are accepted.
 */
function shapes(svg: string): Shape[] {
  const out: Shape[] = [];
  for (const el of svg.matchAll(/<(circle|rect|path)\b([^>]*?)\/?>/g)) {
    const attrs: Record<string, string> = {};
    for (const a of group(el, 2).matchAll(/([a-z-]+)=['"]([^'"]*)['"]/g)) {
      // ".35" and "0.35" are the same opacity; compare by value, not spelling.
      const raw = group(a, 2);
      const n = Number(raw);
      attrs[group(a, 1)] = Number.isNaN(n) ? raw : String(n);
    }
    out.push({ tag: group(el, 1), attrs });
  }
  return out;
}

/**
 * The mark's own shapes: everything that is positioned. This drops the
 * full-bleed plate and the inset hairline, which are per-surface container
 * chrome (they carry a size but no `x`/`cx`) rather than part of the drawing.
 */
const positioned = (all: Shape[]): Shape[] => all.filter((s) => "x" in s.attrs || "cx" in s.attrs);

/** The contents of the single `<g>` a derived surface wraps the mark in. */
function transformedGroup(svg: string): { transform: string; shapes: Shape[] } {
  const g = svg.match(/<g\s+transform=['"]([^'"]+)['"]\s*>([\s\S]*?)<\/g>/);
  if (!g) throw new Error("no transformed <g> found — the mark must be placed, not redrawn");
  return { transform: group(g, 1), shapes: shapes(group(g, 2)) };
}

/** Compare on geometry and tone, but not `fill` — see the wheel-fill test. */
const geometry = (list: Shape[]): string[] =>
  list.map((s) => {
    const { fill: _fill, ...rest } = s.attrs;
    return `${s.tag} ${Object.entries(rest)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")}`;
  });

const faviconMatch = htmlTs.match(/export const FAVICON_SVG = `([\s\S]*?)`;/);
if (!faviconMatch) throw new Error("FAVICON_SVG not found in src/web/html.ts");
const faviconSvg = group(faviconMatch, 1);
const canonical = positioned(shapes(faviconSvg));

const brandMarkUri = shellCss.match(/background: url\("data:image\/svg\+xml,([^"]+)"\)/);
if (!brandMarkUri) throw new Error(".brand-mark background data URI not found in shell.css");
const brandMarkSvg = decodeURIComponent(group(brandMarkUri, 1));

describe("brand mark", () => {
  it("is a real drawing, not an empty match", () => {
    // Guards the tests below: every assertion here compares extracted lists, so
    // a regex that quietly stopped matching would make them all vacuously pass.
    expect(canonical.length).toBeGreaterThanOrEqual(7);
  });

  it("has identical geometry in .brand-mark and the canonical favicon", () => {
    expect(geometry(transformedGroup(brandMarkSvg).shapes)).toEqual(geometry(canonical));
  });

  it("has identical geometry in the app icon and the canonical favicon", () => {
    expect(geometry(transformedGroup(iconSvg).shapes)).toEqual(geometry(canonical));
  });

  it("places the mark by transform rather than by redrawing it", () => {
    // The coordinates above only stay comparable because neither derived
    // surface bakes its scaling into them.
    expect(transformedGroup(brandMarkSvg).transform).toMatch(/scale\(/);
    expect(transformedGroup(iconSvg).transform).toMatch(/scale\(/);
  });

  it("fills each wheel hub with its own surface's plate colour", () => {
    // The one attribute that legitimately differs across surfaces, because the
    // hub is meant to read as a hole punched through to the plate. A hub left
    // on another surface's plate colour shows up as a visible disc.
    for (const [name, svg] of [
      ["favicon", faviconSvg],
      [".brand-mark", brandMarkSvg],
    ] as const) {
      const all = shapes(svg);
      const plate = all.find((s) => !("x" in s.attrs) && !("cx" in s.attrs) && s.attrs.fill);
      // Circles specifically: `.brand-mark`'s inset hairline is a stroked rect.
      const hubs = positioned(all).filter((s) => s.tag === "circle" && s.attrs.stroke);
      expect(hubs.length, `${name} wheels`).toBe(2);
      for (const hub of hubs) expect(hub.attrs.fill, `${name} hub`).toBe(plate?.attrs.fill);
    }
  });
});
