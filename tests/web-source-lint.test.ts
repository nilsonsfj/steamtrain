import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The source view's lint layer (design 02.3): what the gutter marks, what the
 * strip says, and which line each diagnostic points at. Exercised against the
 * real st-plan.js — sourceDiagnostics is pure, so the module is mounted with
 * stubs and the function called directly.
 */

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public");
const planJs = readFileSync(join(PUBLIC_DIR, "st-plan.js"), "utf8");
const planCss = readFileSync(join(PUBLIC_DIR, "plan.css"), "utf8");

interface Diagnostic {
  severity: "err" | "warn";
  line: number;
  message: string;
  detail: string;
  action?: string;
}

const SPEC = {
  name: "bug-hunt",
  phases: [
    {
      id: "p1",
      title: "Scan",
      steps: [{ id: "scan", kind: "worker", prompt: "scan", agent: "amp" }],
    },
    {
      id: "p2",
      title: "Report",
      steps: [{ id: "report", kind: "consolidator", prompt: "report", agent: "claude" }],
    },
  ],
};

/** Mount st-plan.js with the ST surface sourceDiagnostics touches. */
function mountPlan(state: Record<string, unknown>): {
  sourceDiagnostics: (text: string) => Diagnostic[];
} {
  const ST: Record<string, unknown> = {
    state,
    h: () => ({}),
    clear: () => {},
    isReadOnly: () => false,
    apiAuth: () => new Promise(() => {}),
    fmtElapsed: () => "",
    agentUiLabel: (id: string) => id,
    shell: { renderSidebar: () => {}, launchBlocked: () => "" },
    render: () => {},
  };
  new Function("window", "document", "setTimeout", "clearTimeout", planJs)(
    { Steamtrain: ST },
    { getElementById: () => null, querySelector: () => null },
    () => 0,
    () => {},
  );
  return ST.plan as { sourceDiagnostics: (text: string) => Diagnostic[] };
}

function baseState(overrides: Record<string, unknown> = {}) {
  return {
    selected: "bug-hunt",
    spec: SPEC,
    planDrafts: {},
    planSelection: [],
    planTab: "source",
    sourceText: null,
    sourceDiverged: false,
    sourceLint: null,
    sourceLintTimer: null,
    ...overrides,
  };
}

const PRETTY = JSON.stringify(SPEC, null, 2);

describe("source view diagnostics", () => {
  it("reports a parse failure on the line the engine names, and nothing else", () => {
    const plan = mountPlan(
      baseState({
        sourceLint: {
          name: "bug-hunt",
          issues: [{ stepId: "scan", issue: "amp is not installed" }],
        },
      }),
    );
    // A stray quote on line 2 — the kind of thing a half-finished edit leaves.
    const lines = PRETTY.split("\n");
    lines[1] = `${lines[1]!}"`;
    const diags = plan.sourceDiagnostics(lines.join("\n"));

    expect(diags).toHaveLength(1);
    expect(diags[0]!.severity).toBe("err");
    expect(diags[0]!.message).toContain("invalid JSON");
    expect(diags[0]!.line).toBe(1);
    // A broken file has no trustworthy structure, so the runner warning that
    // WOULD have applied is withheld rather than anchored to a guessed line.
    expect(diags.some((d) => d.severity === "warn")).toBe(false);
  });

  it("anchors a structural error to the offending step's id line", () => {
    const plan = mountPlan(baseState());
    const broken = JSON.parse(JSON.stringify(SPEC));
    broken.phases[1].steps[0].dependsOn = ["nope"];
    const text = JSON.stringify(broken, null, 2);
    const diags = plan.sourceDiagnostics(text);

    expect(diags).toHaveLength(1);
    expect(diags[0]!.severity).toBe("err");
    expect(diags[0]!.message).toContain("depends on unknown step 'nope'");
    expect(text.split("\n")[diags[0]!.line]).toContain('"id": "report"');
  });

  it("turns a server dispatch issue into a warning with a remedy", () => {
    const plan = mountPlan(
      baseState({
        sourceLint: {
          name: "bug-hunt",
          issues: [{ stepId: "scan", issue: "amp is not installed" }],
        },
      }),
    );
    const diags = plan.sourceDiagnostics(PRETTY);

    expect(diags).toHaveLength(1);
    expect(diags[0]!.severity).toBe("warn");
    expect(diags[0]!.message).toBe("scan · amp is not installed");
    expect(diags[0]!.detail).toBe("this step will be skipped");
    expect(diags[0]!.action).toBe("open Settings → Runners");
    expect(PRETTY.split("\n")[diags[0]!.line]).toContain('"id": "scan"');
  });

  it("drops warnings for steps the text no longer declares, and for other workflows", () => {
    const gone = mountPlan(
      baseState({
        sourceLint: {
          name: "bug-hunt",
          issues: [{ stepId: "deleted-step", issue: "amp needs auth" }],
        },
      }),
    );
    expect(gone.sourceDiagnostics(PRETTY)).toEqual([]);

    // A response that landed after the reader moved on names a different
    // workflow, and must not mark this one.
    const stale = mountPlan(
      baseState({
        sourceLint: { name: "code-review", issues: [{ stepId: "scan", issue: "amp needs auth" }] },
      }),
    );
    expect(stale.sourceDiagnostics(PRETTY)).toEqual([]);
  });

  it("lists a clean file as having nothing wrong", () => {
    const plan = mountPlan(baseState());
    expect(plan.sourceDiagnostics(PRETTY)).toEqual([]);
  });
});

describe("source view layers", () => {
  it("keeps the three stacked layers on one row height", () => {
    // The gutter, highlight and textarea only line up because they share a
    // line-height; SRC_LINE_H in st-plan.js scrolls by that same number.
    const heights = [...planCss.matchAll(/font: 400 12\.5px \/ (\d+)px var\(--font-mono\)/g)].map(
      (m) => m[1],
    );
    expect(heights.length).toBeGreaterThanOrEqual(2);
    expect(new Set(heights)).toEqual(new Set(["19"]));
    expect(planJs).toContain("var SRC_LINE_H = 19;");
    expect(planCss).toMatch(/\.src-ln\s*\{[^}]*height: 19px/);
  });

  it("keeps the editor's glyphs transparent so the highlight layer shows through", () => {
    expect(planCss).toMatch(/\.src-editor\s*\{[^}]*color: transparent/);
    expect(planCss).toMatch(/\.src-editor\s*\{[^}]*caret-color: var\(--text\)/);
    expect(planCss).toMatch(/\.src-hl\s*\{[^}]*pointer-events: none/);
  });
});
