/**
 * Layout contracts for the launch sheet options.
 *
 * The shared form-control rule makes every `select.sel` full width. The
 * launch-sheet runner cap is an inline control, so its row must give the copy
 * the flexible space and keep the select compact.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public");
const css = readFileSync(join(PUBLIC_DIR, "plan.css"), "utf8");

/** Every declaration block whose selector list contains `selector`, concatenated. */
function ruleBody(sheet: string, selector: string): string {
  const bodies: string[] = [];
  const stripped = sheet.replace(/\/\*[\s\S]*?\*\//g, " ");
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let match = re.exec(stripped); match; match = re.exec(stripped)) {
    const selectors = (match[1] ?? "").split(",").map((s) => s.trim().replace(/\s+/g, " "));
    if (selectors.includes(selector)) bodies.push(match[2] ?? "");
  }
  return bodies.join("\n");
}

describe("launch sheet options layout", () => {
  it("lets option copy use the remaining row width", () => {
    expect(ruleBody(css, ".ls-optcopy")).toMatch(/flex:\s*1\s+1\s+auto/);
    expect(ruleBody(css, ".ls-optcopy")).toMatch(/min-width:\s*0/);
  });

  it("keeps the runner cap select compact beside its copy", () => {
    expect(ruleBody(css, ".ls-opt select")).toMatch(/flex:\s*none/);
    expect(ruleBody(css, ".ls-opt select")).toMatch(/width:\s*56px/);
  });
});
