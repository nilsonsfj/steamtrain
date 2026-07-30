/**
 * Contracts for the run browser page (st-runs.js + runs.css), which replaced
 * the full-screen history modal.
 *
 * st-runs.js is a plain IIFE over `window.Steamtrain`, so it runs here for
 * real: a stub namespace with an `h()` that builds inert nodes is enough to
 * paint the page, read back what it rendered, and fire the handlers it
 * attached. The layout invariants that only exist in the stylesheet (one grid
 * template shared by the header and the rows; the rails' widths) are asserted
 * against the CSS text instead.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public");
const runsJs = readFileSync(join(PUBLIC_DIR, "st-runs.js"), "utf8");
const runsCss = readFileSync(join(PUBLIC_DIR, "runs.css"), "utf8");

interface StubEl {
  tag: string;
  attrs: Record<string, unknown>;
  children: StubEl[];
  text: string;
  listeners: Record<string, ((e?: unknown) => void)[]>;
  className: string;
  textContent: string;
  checked?: boolean;
  style: Record<string, string>;
  appendChild: (child: StubEl) => void;
  addEventListener: (event: string, fn: (e?: unknown) => void) => void;
  classList: { add: (c: string) => void; toggle: (c: string, on: boolean) => void };
  querySelector: (sel: string) => StubEl | null;
  querySelectorAll: (sel: string) => StubEl[];
  focus: () => void;
}

/** The `h()` these modules build their DOM with, minus the DOM. */
function el(tag: string, attrs?: Record<string, unknown>, ...kids: unknown[]): StubEl {
  const node: StubEl = {
    tag,
    attrs: attrs ?? {},
    children: [],
    // `h()` treats a `text` attribute as textContent; children append after it.
    text: attrs?.text == null ? "" : String(attrs.text),
    listeners: {},
    className: String(attrs?.class ?? ""),
    textContent: "",
    checked: attrs?.checked === true,
    style: {},
    appendChild: (child) => node.children.push(child),
    addEventListener: (event, fn) => {
      const bucket = node.listeners[event] ?? [];
      node.listeners[event] = bucket;
      bucket.push(fn);
    },
    classList: {
      add: (c) => {
        node.className = `${node.className} ${c}`.trim();
      },
      toggle: () => {},
    },
    querySelector: (sel) => find(node, sel)[0] ?? null,
    querySelectorAll: (sel) => find(node, sel),
    focus: () => {},
  };
  // st-core's h() turns an `onFoo: fn` attribute into addEventListener("foo"),
  // and st-runs.js attaches most of its handlers that way — without this the
  // page would paint but nothing would be clickable.
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value as () => void);
    }
  }
  for (const kid of kids) {
    if (kid == null) continue;
    if (typeof kid === "string") node.text += kid;
    else node.children.push(kid as StubEl);
  }
  return node;
}

/** Enough of a selector engine for `.cls` and `[data-focus-key="…"]`. */
function find(root: StubEl, sel: string, out: StubEl[] = []): StubEl[] {
  const match = (n: StubEl) => {
    if (sel.startsWith(".")) return n.className.split(" ").includes(sel.slice(1));
    const attr = /^\[([\w-]+)="(.*)"\]$/.exec(sel);
    if (attr) return String(n.attrs[attr[1] as string] ?? "") === attr[2];
    return false;
  };
  for (const kid of root.children) {
    if (match(kid)) out.push(kid);
    find(kid, sel, out);
  }
  return out;
}

function collect(node: StubEl, pred: (n: StubEl) => boolean, out: StubEl[] = []): StubEl[] {
  if (pred(node)) out.push(node);
  for (const kid of node.children) collect(kid, pred, out);
  return out;
}
function hasClass(node: StubEl, cls: string): boolean {
  return node.className.split(" ").includes(cls);
}
function flatText(node: StubEl): string {
  return [node.text, ...node.children.map(flatText)].join(" ").replace(/\s+/g, " ").trim();
}
function click(node: StubEl): void {
  for (const fn of node.listeners.click ?? []) fn({ target: node });
}

const HOUR = 3600_000;

/** A recorded run summary shaped like GET /api/history returns them. */
function record(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "8f21c0de-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
    workflow: "bug-hunt",
    input: "find the concurrency bugs",
    status: "done",
    ok: true,
    startedAt: Date.now() - HOUR,
    endedAt: Date.now(),
    durationMs: 124_000,
    totals: {
      steps: 6,
      ok: 6,
      failed: 0,
      cached: 1,
      costUsd: 0.041,
      tokens: { input: 100_000, output: 20_000, cacheRead: 38_000, cacheWrite: 0, reasoning: 0 },
      durationMs: 124_000,
    },
    ...over,
  };
}

interface Mounted {
  root: StubEl;
  rows: () => { text: string; cls: string; node: StubEl }[];
  rail: () => { label: string; count: string; active: boolean }[];
  receipt: () => string;
  head: () => string;
  hash: () => string;
  clickRow: (index: number) => Promise<void>;
  press: (key: string) => boolean;
}

/**
 * Paints the real runs page against a stub DOM. `runs` are the recorded
 * summaries GET /api/history would return; `live` the in-flight ones from
 * GET /api/runs; `detail` the full record GET /api/history/:id resolves to.
 */
async function mountRuns(opts: {
  runs?: Record<string, unknown>[];
  live?: Record<string, unknown>[];
  detail?: Record<string, unknown>;
  selected?: string;
}): Promise<Mounted> {
  const root = el("div");
  const location = { hash: "#runs", pathname: "/", search: "" };
  const ST: Record<string, unknown> = {
    state: { page: "runs", liveRuns: [] },
    h: el,
    clear: (node: StubEl) => {
      node.children = [];
    },
    activateWithKeyboard: (e: { key: string }, action: () => void) => {
      if (e.key === "Enter" || e.key === " ") action();
    },
    aggregateByModel: () => [],
    announce: () => {},
    captureFocus: () => null,
    restoreFocus: () => false,
    closePageRoute: () => {
      (ST.state as { page: string | null }).page = null;
    },
    fmtTime: () => "time",
    fmtTokens: (n: number) => `${Math.round(n / 1000)}k`,
    fmtTokenSummary: () => "tokens",
    fmtTotals: () => "totals",
    isInteractiveTarget: (n: StubEl) => n.tag === "input" || n.tag === "button",
    isReadOnly: () => false,
    relTime: () => "1h ago",
    totalTokens: (t: Record<string, number> | undefined) =>
      t ? (t.input ?? 0) + (t.output ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0) : 0,
    truncate: (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s),
    attachRun: () => {},
    shell: { renderLiveRuns: () => {} },
    run: {
      setBanner: () => {},
      renderCard: (s: Record<string, unknown>) => el("div", { text: String(s.stepId) }),
    },
    modals: {
      rerunHistory: () => {},
      openRetryRetargetModal: () => {},
      safeExternalLink: () => el("a"),
    },
    api: () => Promise.resolve({ status: 200, body: { runs: opts.live ?? [] } }),
    apiAuth: (_m: string, path: string) => {
      if (path === "/api/history")
        return Promise.resolve({ status: 200, body: { runs: opts.runs ?? [] } });
      if (path.startsWith("/api/history/") && path.endsWith("/worktrees")) {
        return Promise.resolve({ status: 200, body: { sources: [] } });
      }
      return Promise.resolve({ status: 200, body: { record: opts.detail } });
    },
  };
  const window = {
    Steamtrain: ST,
    SteamtrainReducer: {
      runsDeepLink: (id?: string) => (id ? `#runs/${id}` : "#runs"),
    },
    location,
    setInterval: () => 0,
    clearInterval: () => {},
    history: {
      replaceState: (_s: unknown, _t: unknown, url: string) => {
        location.hash = url.slice(url.indexOf("#"));
      },
    },
  };
  new Function("window", "document", "setInterval", "clearInterval", "history", runsJs)(
    window,
    { getElementById: () => null, body: el("body") },
    () => 0,
    () => {},
    window.history,
  );
  const runs = ST.runs as {
    render: (c: StubEl, id?: string) => void;
    handleKey: (e: unknown) => boolean;
  };
  runs.render(root, opts.selected);
  // history + live fetch, then the selected run's full record.
  for (let i = 0; i < 6; i++) await Promise.resolve();

  const rowNodes = () => collect(root, (n) => hasClass(n, "runs-run"));
  return {
    root,
    rows: () => rowNodes().map((n) => ({ text: flatText(n), cls: n.className, node: n })),
    rail: () =>
      collect(root, (n) => hasClass(n, "runs-rail-row")).map((n) => ({
        label: flatText(find(n, ".label")[0] ?? el("span")),
        count: flatText(find(n, ".count")[0] ?? el("span")),
        active: hasClass(n, "active"),
      })),
    receipt: () => flatText(collect(root, (n) => hasClass(n, "runs-receipt"))[0] ?? el("div")),
    head: () => flatText(collect(root, (n) => hasClass(n, "runs-head"))[0] ?? el("div")),
    hash: () => location.hash,
    clickRow: async (index: number) => {
      click(rowNodes()[index] as StubEl);
      for (let i = 0; i < 6; i++) await Promise.resolve();
    },
    press: (key: string) => runs.handleKey({ key, target: null, preventDefault: () => {} }),
  };
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

describe("runs page: the list", () => {
  it("shows one row per run, newest first, with live runs above recorded ones", async () => {
    const page = await mountRuns({
      runs: [
        record(),
        record({ id: "aaaaaaaa-1a2b-4c3d-8e4f-5a6b7c8d9e0f", workflow: "mainline" }),
      ],
      live: [
        {
          id: "bbbbbbbb-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
          workflow: "bug-hunt",
          status: "running",
          startedAt: Date.now(),
        },
      ],
    });
    const rows = page.rows();
    expect(rows).toHaveLength(3);
    expect(rows[0]?.cls).toContain("live");
    expect(rows[0]?.text).toContain("running");
    expect(rows[1]?.text).toContain("8f21c");
  });

  // The Outcome column is the one place a reader learns *why* a run ended the
  // way it did, so each terminal state has to say its own reason rather than
  // repeat the status word already carried by the dot.
  it("reports the real terminal reason per status", async () => {
    const page = await mountRuns({
      runs: [
        record({ status: "error", error: "scan-errors failed after 3 tries · runner timeout" }),
        record({
          id: "aaaaaaaa-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
          status: "budget-exceeded",
          budget: { scope: "workflow", limitUsd: 0.05, spentUsd: 0.0503 },
        }),
        record({ id: "cccccccc-1a2b-4c3d-8e4f-5a6b7c8d9e0f", status: "canceled" }),
      ],
    });
    const rows = page.rows();
    expect(rows[0]?.text).toContain("scan-errors failed after 3 tries");
    expect(rows[1]?.text).toContain("workflow budget $0.0500 reached");
    expect(rows[2]?.text).toContain("canceled");
  });

  it("counts a done run's steps and flags its cached ones", async () => {
    const page = await mountRuns({ runs: [record()] });
    expect(page.rows()[0]?.text).toContain("6/6 ok");
    expect(page.rows()[0]?.text).toContain("1 cached");
  });

  it("summarises the filtered set in the header", async () => {
    const page = await mountRuns({
      runs: [record(), record({ id: "aaaaaaaa-1a2b-4c3d-8e4f-5a6b7c8d9e0f", status: "error" })],
    });
    expect(page.head()).toContain("2 runs");
    expect(page.head()).toContain("1 ok");
    expect(page.head()).toContain("1 failed");
  });
});

describe("runs page: the filter rail", () => {
  it("counts each status and hides the ones nothing has hit", async () => {
    const page = await mountRuns({
      runs: [record(), record({ id: "aaaaaaaa-1a2b-4c3d-8e4f-5a6b7c8d9e0f", status: "error" })],
    });
    const labels = page.rail().map((r) => `${r.label}:${r.count}`);
    expect(labels).toContain("All runs:2");
    expect(labels).toContain("Failed:1");
    expect(labels).toContain("Done:1");
    // Nothing was canceled or budget-stopped, so those rows stay out of the way.
    expect(labels.some((l) => l.startsWith("Canceled"))).toBe(false);
    expect(labels.some((l) => l.startsWith("Budget"))).toBe(false);
    // Running is always offered, even at zero — it is the live view.
    expect(labels).toContain("Running:0");
  });

  it("filters the table down to one workflow, and clicking again clears it", async () => {
    const page = await mountRuns({
      runs: [
        record(),
        record({ id: "aaaaaaaa-1a2b-4c3d-8e4f-5a6b7c8d9e0f", workflow: "mainline" }),
      ],
    });
    const mainline = collect(
      page.root,
      (n) => hasClass(n, "runs-rail-row") && flatText(n).includes("mainline"),
    )[0];
    click(mainline as StubEl);
    expect(page.rows()).toHaveLength(1);
    expect(page.rows()[0]?.text).toContain("aaaaa");
    const again = collect(
      page.root,
      (n) => hasClass(n, "runs-rail-row") && flatText(n).includes("mainline"),
    )[0];
    click(again as StubEl);
    expect(page.rows()).toHaveLength(2);
  });

  it("totals spend over the runs the filter actually shows", async () => {
    const page = await mountRuns({
      runs: [record(), record({ id: "aaaaaaaa-1a2b-4c3d-8e4f-5a6b7c8d9e0f" })],
    });
    const spend = collect(page.root, (n) => hasClass(n, "runs-spend"))[0] as StubEl;
    expect(flatText(spend)).toContain("$0.08 over 2 runs");
    // One bar per run, so the sparkline never under-reports the history.
    expect(collect(spend, (n) => hasClass(n, "bar"))).toHaveLength(2);
  });
});

describe("runs page: the receipt rail", () => {
  it("selects a run into the rail and into the hash, without leaving the list", async () => {
    const detail = {
      ...record(),
      phases: [
        {
          phaseId: "p",
          title: "Scan",
          index: 0,
          stepCount: 1,
          done: true,
          ok: true,
          steps: [
            {
              stepId: "scan-logic",
              status: "done",
              result: { durationMs: 41_200, costUsd: 0.0104 },
              text: "4 findings",
            },
          ],
        },
      ],
    };
    const page = await mountRuns({ runs: [record()], detail });
    await page.clickRow(0);
    expect(page.hash()).toBe("#runs/8f21c0de-1a2b-4c3d-8e4f-5a6b7c8d9e0f");
    // Still a list underneath — selection is not navigation.
    expect(page.rows()).toHaveLength(1);
    expect(page.rows()[0]?.cls).toContain("selected");
    const receipt = page.receipt();
    expect(receipt).toContain("8f21c");
    expect(receipt).toContain("2:04");
    expect(receipt).toContain("$0.041");
    expect(receipt).toContain("scan-logic");
    expect(receipt).toContain("4 findings");
  });

  it("opens straight onto a deep-linked run", async () => {
    const detail = { ...record(), phases: [] };
    const page = await mountRuns({
      runs: [record()],
      detail,
      selected: "8f21c0de-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
    });
    expect(page.receipt()).toContain("8f21c");
  });

  // A live run has no recorded receipt yet; offering one would be a lie, so the
  // rail offers the thing that does exist — attaching to it.
  it("offers to attach instead of a receipt for a live run", async () => {
    const live = {
      id: "bbbbbbbb-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
      workflow: "bug-hunt",
      status: "running",
      startedAt: Date.now(),
    };
    const page = await mountRuns({ runs: [], live: [live], selected: live.id });
    expect(page.receipt()).toContain("Attach");
    expect(page.receipt()).not.toContain("Step ledger");
  });

  it("says so plainly when nothing is selected", async () => {
    const page = await mountRuns({ runs: [record()] });
    expect(page.receipt()).toContain("No run selected");
  });
});

describe("runs page: keyboard", () => {
  it("consumes its own keys only while the page is showing", async () => {
    const page = await mountRuns({ runs: [record()], detail: { ...record(), phases: [] } });
    expect(page.press("ArrowDown")).toBe(true);
    expect(page.press("/")).toBe(true);
    expect(page.press("x")).toBe(false);
  });
});

describe("runs page layout", () => {
  // The header row and every data row must share one template or the columns
  // stop lining up with their own labels.
  it("draws the header and the rows from a single grid template", () => {
    const body = ruleBody(runsCss, ".runs-row");
    const template = /grid-template-columns:([^;]+)/.exec(body)?.[1]?.trim();
    expect(body).toContain("display: grid");
    expect(template).toBeTruthy();
    // `.runs-cols` (the header) and `.runs-run` (a row) both *are* `.runs-row`
    // and must not redeclare it — a second declaration is how columns drift
    // out from under their own labels.
    const declarations = runsCss
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .match(new RegExp(`grid-template-columns:\\s*${escapeRe(template as string)}`, "g"));
    expect(declarations).toHaveLength(1);
    expect(ruleBody(runsCss, ".runs-cols")).not.toContain("grid-template-columns");
    expect(ruleBody(runsCss, ".runs-run")).not.toContain("grid-template-columns");
  });

  it("keeps the rails at the same widths as the rest of the shell", () => {
    expect(ruleBody(runsCss, ".runs-rail")).toContain("width: 236px");
    expect(ruleBody(runsCss, ".runs-receipt")).toContain("width: 340px");
  });

  // Wrapping the header would push the table's columns out from under the
  // labels they belong to, so it is a fixed-height single row.
  it("pins the header to one row and lets the summary truncate instead", () => {
    const head = ruleBody(runsCss, ".runs-head");
    expect(head).not.toContain("flex-wrap: wrap");
    expect(head).toContain("height: 44px");
    expect(ruleBody(runsCss, ".runs-head-meta")).toContain("text-overflow: ellipsis");
  });

  // The columns stack rather than disappear below the shell's own breakpoint:
  // a hidden receipt rail would make clicking a row do nothing visible.
  it("stacks the three columns on a narrow viewport instead of hiding them", () => {
    const narrow = runsCss.slice(runsCss.indexOf("@media (max-width: 900px)"));
    expect(narrow).toContain("flex-direction: column");
    expect(narrow).not.toMatch(/\.runs-receipt[^{]*\{[^}]*display:\s*none/);
  });
});
