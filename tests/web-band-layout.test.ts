/**
 * Layout contract for the expanded phase band.
 *
 * `.bands` is a scrolling flex column. As soon as the bands below the expanded
 * one push the column past the viewport there is negative free space, so the
 * expanded band — the only shrinkable item — is squeezed to its `min-height`
 * while its own children (step rows + live output pane) still want their
 * natural height. Before this contract existed the band declared no `overflow`
 * and its step rows were direct children with no scroll area, so the surplus
 * painted straight over the following bands and the output pane collapsed to a
 * ~1px sliver that could not scroll.
 *
 * vitest has no layout engine, so these assert the source-level invariants that
 * keep the band a self-contained, internally scrolling pane.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public");
const css = readFileSync(join(PUBLIC_DIR, "run.css"), "utf8");
const js = readFileSync(join(PUBLIC_DIR, "st-run.js"), "utf8");

/** Every declaration block whose selector list contains `selector`, concatenated. */
function ruleBody(sheet: string, selector: string): string {
  const bodies: string[] = [];
  // Comment prose contains commas, which would otherwise split into the
  // selector list of the rule that follows it.
  const stripped = sheet.replace(/\/\*[\s\S]*?\*\//g, " ");
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(stripped); m; m = re.exec(stripped)) {
    const selectors = (m[1] ?? "").split(",").map((s) => s.trim().replace(/\s+/g, " "));
    if (selectors.includes(selector)) bodies.push(m[2] ?? "");
  }
  return bodies.join("\n");
}

describe("expanded phase band layout", () => {
  it("contains its own overflow so it cannot paint over the bands below it", () => {
    expect(ruleBody(css, ".band.expanded")).toMatch(/overflow:\s*hidden/);
  });

  it("lays every band out as a column of head, step list and output", () => {
    const band = ruleBody(css, ".band");
    expect(band).toMatch(/display:\s*flex/);
    expect(band).toMatch(/flex-direction:\s*column/);
  });

  it("keeps a height floor on the expanded band and a floor on its output pane", () => {
    expect(ruleBody(css, ".band.expanded")).toMatch(/min-height:/);
    expect(ruleBody(css, ".band.expanded .output")).toMatch(/min-height:\s*\d/);
  });

  it("gives the step list its own scroll area that may shrink to nothing", () => {
    const steps = ruleBody(css, ".band.expanded .band-steps");
    expect(steps).toMatch(/overflow-y:\s*auto/);
    expect(steps).toMatch(/min-height:\s*0/);
  });

  it("caps the step list so the output pane always keeps usable height", () => {
    expect(ruleBody(css, ".band.expanded .band-steps")).toMatch(/max-height:/);
  });

  it("wraps the expanded band's step rows in the .band-steps scroll area", () => {
    // The rows and their sub-workflow blocks are appended to a `band-steps`
    // host, not to the band itself.
    expect(js).toMatch(/class:\s*"band-steps"/);
    expect(js).toMatch(/stepHost\.appendChild\(renderStepRow\(p, s\)\)/);
  });
});
