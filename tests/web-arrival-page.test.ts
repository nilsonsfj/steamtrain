/**
 * Contract for the finished-run page (design 5a).
 *
 * vitest has no layout engine and this page is hand-written DOM, so these
 * assert the source-level invariants that keep the three rules of the surface
 * true. Each one has a specific failure it exists to prevent — see the comment
 * on the test.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public");
const js = readFileSync(join(PUBLIC_DIR, "st-arrival.js"), "utf8");
const css = readFileSync(join(PUBLIC_DIR, "arrival.css"), "utf8");
const runJs = readFileSync(join(PUBLIC_DIR, "st-run.js"), "utf8");
const bootJs = readFileSync(join(PUBLIC_DIR, "st-boot.js"), "utf8");
const coreJs = readFileSync(join(PUBLIC_DIR, "st-core.js"), "utf8");

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

describe("finished-run page: run actions are not workflow actions", () => {
  it("hides the cockpit's workflow action row while the page is up", () => {
    // The row holds Delete, which removes the WORKFLOW. Above a failed run it
    // read as "discard this run" — the confusion this page exists to end.
    expect(bootJs).toContain('classList.toggle("arrival-mode", showingArrival)');
    expect(ruleBody(css, "body.arrival-mode .run-head")).toMatch(/display:\s*none/);
  });

  it("puts every workflow action behind one menu whose items name the workflow", () => {
    expect(js).toContain('"Configure workflow"');
    expect(js).toContain('"Clone workflow"');
    expect(js).toContain('"Open workflow source"');
    // The destructive item states its real blast radius — the config file, not
    // the run history, which deleting a workflow leaves alone.
    expect(js).toContain('"Delete workflow from " + fileLabel');
    expect(js).toContain("the project steamtrain.json");
    expect(js).toContain("your user workflows file");
  });

  it("keeps the menu's open state on S, not in the DOM", () => {
    // #bands is cleared and rebuilt on every render (st-boot.js), so a menu
    // that remembered its own state vanished on the next background poll.
    expect(coreJs).toContain("arrivalMenuOpen: false");
    expect(js).toContain("S.arrivalMenuOpen");
    // …and the document-level dismiss listeners are rebound, never stacked.
    expect(js).toContain("function unbindMenuDismiss");
    expect(js).toMatch(/function bindMenuDismiss[\s\S]{0,120}unbindMenuDismiss\(\)/);
    expect(bootJs).toContain("ST.arrival.leave()");
  });
});

describe("finished-run page: the page ends in an action", () => {
  it("offers a retry that restarts from the failing step, not from the top", () => {
    expect(js).toContain('"Retry from " + root.stepId');
    // retry-failed seeds the steps that already succeeded and re-executes the
    // rest; "rerun" would start the whole workflow over.
    expect(js).toContain('ST.modals.rerunHistory(S.runId, S.selected, "retry")');
  });

  it("states the root cause instead of a banner that only says the run failed", () => {
    expect(js).toContain("SteamtrainReducer.arrivalRootCause");
    expect(js).toContain('"Everything after it was skipped, not run: "');
    expect(js).toContain('"Copy error"');
    expect(js).toContain('"Edit this step"');
    // The generic outcome banner is gone: the page's own status pill and
    // root-cause block already say it, and two verdicts is one too many.
    expect(runJs).not.toContain('setBanner("Run failed"');
    expect(runJs).not.toContain('setBanner("Run complete."');
  });

  it("replaces a zeroed spend tile with the reason it is zero", () => {
    expect(js).toContain('"none — no agent step ran"');
    expect(js).toContain('" · not priced yet"');
  });
});

describe("finished-run page: failed is not skipped", () => {
  it("groups the steps that never started under their own header", () => {
    expect(js).toContain('"Never started — "');
    expect(js).toContain('"blocked by "');
    expect(js).toContain('"its condition was false"');
  });

  it("lays a blocked row out without the columns it cannot populate", () => {
    // A step that never ran has no duration and no cost; dashing them out is
    // the noise design 4a removed from the live view.
    expect(js).toContain('opts.showCost ? " has-cost" : (opts.showTime ? " has-time" : "")');
    expect(ruleBody(css, ".ledger-row")).toMatch(
      /grid-template-columns:\s*8px minmax\(0, 1fr\)\s*;/,
    );
    expect(ruleBody(css, ".ledger-row.has-time")).toMatch(/grid-template-columns:/);
    expect(ruleBody(css, ".ledger-row.has-cost")).toMatch(/grid-template-columns:/);
  });
});

describe("finished-run page: layout", () => {
  it("gives the output pane the space a finished run used to leave empty", () => {
    expect(js).toContain("function renderOutput");
    const out = ruleBody(css, ".arrival-output");
    expect(out).toMatch(/flex:\s*1 1 auto/);
    expect(out).toMatch(/min-height:\s*\d/);
  });

  it("lets the head's menu hang over the body without the page overflowing", () => {
    // `overflow: hidden` clipped the popup; dropping it also drops the
    // automatic-minimum-size behaviour that kept the column inside the canvas,
    // so min-height has to be stated explicitly.
    const main = ruleBody(css, ".arrival-main");
    expect(main).toMatch(/overflow:\s*visible/);
    expect(main).toMatch(/min-height:\s*0/);
    expect(ruleBody(css, ".arrival-body")).toMatch(/overflow-y:\s*auto/);
  });

  it("retires the live instrument rail once the run is over", () => {
    expect(ruleBody(css, "body.arrival-mode #rail-right")).toMatch(/display:\s*none/);
  });
});
