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

  it("keeps the inline output pane's height floor inside that scroll area", () => {
    // The pane now sits between rows rather than at the foot of the band, so
    // it takes leftover height when there is any and its floor when there is
    // not — the list scrolls instead of the pane collapsing to a sliver.
    const out = ruleBody(css, ".band.expanded .output");
    expect(out).toMatch(/min-height:\s*\d/);
    // May shrink, never grows: absorbing the band's leftover space pushed the
    // rows below it a screen away from their siblings.
    expect(out).toMatch(/flex:\s*0\s+1\s+auto/);
  });

  it("wraps the expanded band's step rows in the .band-steps scroll area", () => {
    // The rows, their sub-workflow blocks and the live output pane are all
    // appended to a `band-steps` host, not to the band itself.
    expect(js).toMatch(/class:\s*"band-steps"/);
    expect(js).toMatch(/stepHost\.appendChild\(renderStepRow\(e\.phase, e\.step, cols, open\)\)/);
    expect(js).toMatch(/stepHost\.appendChild\(renderOutputPane\(e\.phase, e\.step\)\)/);
  });

  it("lays rows out on their band's own column spec rather than a fixed grid", () => {
    // A band of command steps has no runner, spend or tokens to show; those
    // columns are not laid out at all instead of being dashed out per row.
    expect(ruleBody(css, ".step-row")).toMatch(/grid-template-columns:\s*var\(--step-cols/);
    expect(js).toMatch(/function bandColumns/);
    expect(js).toMatch(/setProperty\("--step-cols"/);
  });

  it("merges sibling sub-workflow phases into one band", () => {
    // The engine namespaces a nested phase_start but leaves the child's own
    // title and index, so N children would otherwise paint N same-titled
    // bands all numbered 01.
    expect(js).toMatch(/function basePhaseId/);
    expect(js).toMatch(/function buildBands/);
    expect(js).toMatch(/lastIndexOf\("::"\)/);
  });

  it("lets a second click retract an expanded live row", () => {
    // A selected row is expanded by the live-band fallback. The click must
    // carry that state into openDetail so closing an auto-expanded row does
    // not immediately reopen it on the next render.
    expect(js).toMatch(/openDetail\(p, s, event\.currentTarget, open\)/);
    expect(js).toMatch(/if \(sameDetail \|\| isOpen\) \{\s*closeDetail\(bandKey\(p\)\);\s*return;/);
    expect(js).toMatch(/bands\[i\]\.key !== S\.collapsedBandKey/);
  });
});
