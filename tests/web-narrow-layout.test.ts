/**
 * What the run surface does when the window is not wide.
 *
 * With both rails at full width a 1000px window leaves the centre pane ~424px,
 * and every fixed-width thing in it — nine grid tracks, a run header strip, a
 * breadcrumb — wanted more than that. The columns overflowed silently: the
 * flexible id track went to zero first, so live rows rendered as `→ babysi`
 * with no way to tell which of twelve sub-runs they were.
 *
 * vitest has no layout engine, so the width-dependent decision that JS makes
 * (bandColumns) is exercised for real, and the ones CSS makes are asserted
 * against the stylesheet.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public");
const runCss = readFileSync(join(PUBLIC_DIR, "run.css"), "utf8");
const shellCss = readFileSync(join(PUBLIC_DIR, "shell.css"), "utf8");
const planCss = readFileSync(join(PUBLIC_DIR, "plan.css"), "utf8");
const inspectorJs = readFileSync(join(PUBLIC_DIR, "st-inspector.js"), "utf8");
const runJs = readFileSync(join(PUBLIC_DIR, "st-run.js"), "utf8");
const treeJs = readFileSync(join(PUBLIC_DIR, "st-tree.js"), "utf8");
const shellJs = readFileSync(join(PUBLIC_DIR, "st-shell.js"), "utf8");

/** Every declaration block whose selector list contains `selector`. */
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

type Spec = {
  meta: boolean;
  runner: boolean;
  cost: boolean;
  tokens: boolean;
  metaWidth: number;
  template: string;
};
type Any = Record<string, unknown>;

/**
 * st-run.js + st-tree.js against a stub window, with one band of steps rich
 * enough to want every optional column: a worktree (meta), an agent (runner),
 * and reported spend and tokens.
 */
function loadColumns(): (width: number) => Spec {
  const window = {
    Steamtrain: {
      state: {},
      // The two helpers bandColumns reads a step through; st-core.js owns them
      // and is not loaded here.
      agentUiLabel: (agent: string) => agent,
      stepUsage: (s: Any) => (s.usage as Any) ?? { costUsd: 0, tokens: 0, live: false },
    },
  } as unknown as {
    Steamtrain: Any & { state: Any; run?: { columns?: (b: Any, w: number) => Spec } };
  };
  new Function("window", treeJs)(window);
  new Function("window", runJs)(window);
  const S = window.Steamtrain.state as Any;
  const step = {
    stepId: "babysit[0]",
    status: "running",
    agent: "claude",
    model: "sonnet",
    blockKind: "workflow",
    worktree: { branch: "pr-1", cwd: "/tmp/pr-1" },
    usage: { costUsd: 0.12, tokens: 40_000 },
  };
  const phase = { id: "babysit-each", title: "Babysit each PR", steps: [step] };
  S.runState = { phases: [phase], steps: [step] };
  const columns = window.Steamtrain.run?.columns;
  if (!columns) throw new Error("st-run.js did not expose its column chooser");
  return (width: number) => columns({ entries: [{ phase, step }] }, width);
}

describe("band columns follow the width they have", () => {
  const columns = loadColumns();

  it("lays out every column a wide pane can carry", () => {
    const wide = columns(1100);
    expect(wide.meta).toBe(true);
    expect(wide.runner).toBe(true);
    expect(wide.cost).toBe(true);
    expect(wide.tokens).toBe(true);
  });

  it("drops usage columns before it lets the id column collapse", () => {
    const mid = columns(620);
    expect(mid.tokens).toBe(false);
    // Whatever survives, the id track is still the flexible one and the fixed
    // tracks leave it a readable share.
    expect(mid.template).toContain("minmax(0,1fr)");
  });

  it("tightens the meta column before dropping it", () => {
    // Between the two thresholds meta narrows rather than disappearing: a
    // 110px column still says "step 2 of 6".
    const widths = [420, 470, 520, 570, 620, 670];
    const tightened = widths.map((w) => columns(w)).filter((s) => s.meta && s.metaWidth < 190);
    expect(tightened.length).toBeGreaterThan(0);
  });

  it("keeps the id column ahead of every optional column at 424px", () => {
    const narrow = columns(424);
    expect(narrow.cost).toBe(false);
    expect(narrow.tokens).toBe(false);
    expect(narrow.meta).toBe(false);
    // dot, id, runner-or-kind, time, chevron — the five that always earn a place.
    expect(narrow.template.split(" ")).toHaveLength(5);
  });

  it("assumes room when the pane has not been laid out yet", () => {
    // A width of 0 is first paint, not a 0px pane; stripping the columns there
    // would flash a bare table and then re-flow it.
    const unmeasured = columns(0);
    expect(unmeasured.meta).toBe(true);
    expect(unmeasured.tokens).toBe(true);
  });
});

describe("rows pay for their nesting in a variable", () => {
  it("indents from --row-base and --row-step rather than a hardcoded 24px", () => {
    expect(runJs).toMatch(/--depth:/);
    const row = ruleBody(runCss, ".step-row");
    expect(row).toMatch(/padding:[^;]*var\(--row-indent\)/);
    expect(ruleBody(runCss, ".bands")).toMatch(/--row-base:/);
  });

  it("charges less per level on a narrow window", () => {
    const narrow = shellCss + runCss;
    expect(narrow).toMatch(/@media \(max-width: 1080px\)/);
    // The tightest tier must actually be tighter than the default.
    const tiers = [...runCss.matchAll(/--row-step:\s*(\d+)px/g)].map((m) => Number(m[1]));
    expect(Math.min(...tiers)).toBeLessThan(Math.max(...tiers));
  });

  it("indents the inline output pane with the row it belongs to", () => {
    expect(ruleBody(runCss, ".band.expanded .output")).toMatch(
      /margin-left:\s*var\(--row-indent\)/,
    );
  });
});

describe("a row's identity outlives its metadata", () => {
  it("lets the callee shrink and ellipsise instead of starving the step id", () => {
    const callee = ruleBody(runCss, ".step-row .id .callee");
    expect(callee).not.toMatch(/flex:\s*none/);
    expect(callee).toMatch(/text-overflow:\s*ellipsis/);
    expect(ruleBody(runCss, ".step-row .id .sid")).toMatch(/min-width:/);
  });

  it("keeps a hyphenated kind chip on one line", () => {
    expect(ruleBody(runCss, ".kind .label")).toMatch(/white-space:\s*nowrap/);
  });

  it("ellipsises a band title rather than wrapping the header", () => {
    const title = ruleBody(runCss, ".band-head .title");
    expect(title).toMatch(/white-space:\s*nowrap/);
    expect(title).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("keeps the sub-run caption to one line", () => {
    expect(ruleBody(runCss, ".sub-caption .bits")).toMatch(/text-overflow:\s*ellipsis/);
  });
});

describe("the run header keeps its controls", () => {
  it("wraps rather than carrying Pause/Detach/Cancel off the edge", () => {
    expect(ruleBody(runCss, ".run-head")).toMatch(/flex-wrap:\s*wrap/);
    expect(ruleBody(runCss, ".run-metrics")).toMatch(/flex-wrap:\s*wrap/);
  });
});

describe("the breadcrumb keeps the workflow name", () => {
  it("shrinks only the path crumb", () => {
    expect(ruleBody(shellCss, "#topbar .crumbs > *")).toMatch(/flex:\s*none/);
    expect(ruleBody(shellCss, "#topbar .crumbs .path")).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("marks the project path as the crumb that gives way", () => {
    expect(shellJs).toMatch(/path:\s*true/);
    expect(shellJs).toMatch(/cls \+= " path"/);
  });

  it("clips the trailing crumbs instead of printing them over the run pill", () => {
    expect(ruleBody(shellCss, "#topbar .crumbs")).toMatch(/overflow:\s*hidden/);
  });

  it("keeps the health line off the nav buttons", () => {
    expect(ruleBody(shellCss, "#topbar .health")).toMatch(/white-space:\s*nowrap/);
    expect(ruleBody(shellCss, "#topbar .topbar-right > .tbtn")).toMatch(/flex:\s*none/);
  });
});

describe("the rail address does not borrow another surface's styling", () => {
  it("namespaces its segment kinds", () => {
    // A bare `phase` class matched the plan editor's `.phase` card, whose 420ms
    // entrance animation replayed on every re-render — once per event during a
    // live run, which read as a strobe.
    expect(inspectorJs).toMatch(/"p a-" \+ part\.kind/);
    expect(inspectorJs).not.toMatch(/"p " \+ part\.kind/);
    expect(planCss).toMatch(/\.insp-address \.p\.a-workflow/);
    expect(planCss).toMatch(/\.insp-address \.p\.a-self/);
  });

  it("has no rule left that would apply the plan card to an address segment", () => {
    expect(planCss).not.toMatch(/\.insp-address \.p\.phase/);
  });
});
