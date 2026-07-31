/**
 * Layout contract for the plan step inspector rail.
 *
 * `.insp-body` is a scrolling flex column. The Prompt field is the only
 * flex-grow child; every other field must keep its intrinsic height. When a
 * model exposes an Effort selector the Runner block grows, and without a
 * floor + overflow containment on `.insp-field.grow` the prompt textarea
 * painted over "Depends on".
 *
 * vitest has no layout engine, so these assert the source-level invariants
 * that keep the prompt from spilling onto siblings.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public");
const css = readFileSync(join(PUBLIC_DIR, "plan.css"), "utf8");
const js = readFileSync(join(PUBLIC_DIR, "st-inspector.js"), "utf8");

/** Every declaration block whose selector list contains `selector`, concatenated. */
function ruleBody(sheet: string, selector: string): string {
  const bodies: string[] = [];
  const stripped = sheet.replace(/\/\*[\s\S]*?\*\//g, " ");
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(stripped); m; m = re.exec(stripped)) {
    const selectors = (m[1] ?? "").split(",").map((s) => s.trim().replace(/\s+/g, " "));
    if (selectors.includes(selector)) bodies.push(m[2] ?? "");
  }
  return bodies.join("\n");
}

describe("step inspector layout", () => {
  it("keeps non-grow fields from shrinking under flex pressure", () => {
    expect(ruleBody(css, ".insp-field")).toMatch(/flex:\s*none/);
  });

  it("gives the prompt field a height floor and contains its overflow", () => {
    const grow = ruleBody(css, ".insp-field.grow");
    expect(grow).toMatch(/min-height:\s*\d/);
    expect(grow).toMatch(/overflow:\s*hidden/);
  });

  it("lets the prompt absorb leftover rail height without a zero basis", () => {
    // flex: 1 1 auto (not flex: 1 / 1 1 0%) so the field starts at content
    // size and grows from there, rather than collapsing toward 0%.
    expect(ruleBody(css, ".insp-field.grow")).toMatch(/flex:\s*1\s+1\s+auto/);
  });

  it("scrolls the inspector body when the form exceeds the rail", () => {
    expect(ruleBody(css, ".insp-body")).toMatch(/overflow-y:\s*auto/);
  });

  it("marks the prompt field as the sole grow child and places Depends on after it", () => {
    expect(js).toMatch(/class:\s*"insp-field grow"/);
    expect(js).toMatch(/body\.appendChild\(promptField\)/);
    expect(js).toMatch(/body\.appendChild\(depsBlock\(/);
  });
});
