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
  disabled?: boolean;
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
    // h() mirrors boolean attributes onto the element, which is how the page
    // disables Compare until a second run is checked.
    disabled: attrs?.disabled === true,
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
function buttonsNamed(root: StubEl, label: string): StubEl[] {
  return collect(root, (n) => n.tag === "button" && flatText(n) === label);
}

const HOUR = 3600_000;

/**
 * The reason a rejected DELETE comes back with. Deliberately not a string the
 * client could produce on its own: the assertions that look for it are proving
 * the page relays *the server's* message, not that it printed its own.
 */
const SERVER_DELETE_ERROR = "history is read-only on this server";

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
  /** Flattened text of the centre pane (table, full receipt, or comparison). */
  main: () => string;
  hash: () => string;
  /** Everything the page announced, in order. */
  said: string[];
  /** Records handed to ST.modals.openDiagnoseModal, in order. */
  diagnoseCalls: unknown[];
  /** Bodies posted to POST /api/history/:id/harvest, in order. */
  harvestPosts: unknown[];
  clickRow: (index: number) => Promise<void>;
  check: (index: number) => Promise<void>;
  /** Click the full receipt's ledger line for a step, toggling its output. */
  clickStep: (stepId: string) => Promise<void>;
  clickButton: (label: string) => Promise<void>;
  press: (key: string) => boolean;
  /** The page's visible copy of an unhandled apiAuth failure. */
  noteFailure: (text: string) => void;
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
  /** Status the DELETE endpoints answer with, for the failure paths. */
  deleteStatus?: number;
  /** Answer a rejected DELETE with no `error` body, exercising the fallback. */
  deleteBare?: boolean;
  /** What the per-model roll-up reports, for the full receipt's cost table. */
  byModel?: Record<string, unknown>[];
  /** Worktree sources the full receipt's lifecycle block should see. */
  worktrees?: Record<string, unknown>[];
  /**
   * Scripted answers for POST /harvest, in call order. The last entry repeats
   * once the list is exhausted. Omitted ⇒ a single empty 200.
   */
  harvestResponses?: { status: number; body: Record<string, unknown> }[];
}): Promise<Mounted> {
  const root = el("div");
  const location = { hash: "#runs", pathname: "/", search: "" };
  const said: string[] = [];
  const diagnoseCalls: unknown[] = [];
  const harvestPosts: unknown[] = [];
  let harvestCount = 0;
  // Server-side history, so a successful DELETE actually removes it and the
  // re-fetch that follows sees the same thing the client just did.
  let stored = opts.runs ?? [];
  const ST: Record<string, unknown> = {
    state: { page: "runs", liveRuns: [] },
    h: el,
    clear: (node: StubEl) => {
      node.children = [];
    },
    activateWithKeyboard: (e: { key: string }, action: () => void) => {
      if (e.key === "Enter" || e.key === " ") action();
    },
    aggregateByModel: () => opts.byModel ?? [],
    announce: (text: string) => said.push(text),
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
    KIND_LABEL: { worker: "worker", consolidator: "merge", gate: "gate", distributor: "fan-out" },
    stepPermissions: (s: Record<string, unknown>) => s.permissions ?? null,
    relTime: () => "1h ago",
    totalTokens: (t: Record<string, number> | undefined) =>
      t ? (t.input ?? 0) + (t.output ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0) : 0,
    truncate: (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s),
    attachRun: () => {},
    shell: { renderLiveRuns: () => {} },
    run: {
      setBanner: () => {},
    },
    modals: {
      rerunHistory: () => {},
      openRetryRetargetModal: () => {},
      openDiagnoseModal: (rec: unknown) => diagnoseCalls.push(rec),
      safeExternalLink: () => el("a"),
    },
    api: () => Promise.resolve({ status: 200, body: { runs: opts.live ?? [] } }),
    apiAuth: (method: string, path: string, payload?: unknown) => {
      if (method === "DELETE") {
        const status = opts.deleteStatus ?? 200;
        if (status === 200) {
          const one = /^\/api\/history\/(.+)$/.exec(path);
          stored = one ? stored.filter((r) => r.id !== decodeURIComponent(one[1] as string)) : [];
        }
        // A rejected DELETE answers with the server's own reason, except when
        // `deleteBare` is set — that is the body-less 5xx the fallback text in
        // deleteRecord/clearHistory exists for.
        const body = status === 200 ? {} : opts.deleteBare ? {} : { error: SERVER_DELETE_ERROR };
        return Promise.resolve({ status, body });
      }
      if (path === "/api/history") return Promise.resolve({ status: 200, body: { runs: stored } });
      if (path.startsWith("/api/history/") && path.endsWith("/worktrees")) {
        return Promise.resolve({ status: 200, body: { sources: opts.worktrees ?? [] } });
      }
      if (method === "POST" && path.endsWith("/harvest")) {
        harvestPosts.push(payload);
        const scripted = opts.harvestResponses;
        const reply = scripted?.[Math.min(harvestCount, Math.max(scripted.length - 1, 0))];
        harvestCount += 1;
        return Promise.resolve(reply ?? { status: 200, body: {} });
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
    setTimeout: (fn: () => void) => {
      fn();
      return 0;
    },
    // Every destructive action on this page confirms first; the tests drive
    // the path where the reader said yes.
    confirm: () => true,
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
    noteFailure: (text: string) => void;
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
    main: () => flatText(collect(root, (n) => hasClass(n, "runs-main"))[0] ?? el("div")),
    hash: () => location.hash,
    said,
    diagnoseCalls,
    harvestPosts,
    clickRow: async (index: number) => {
      click(rowNodes()[index] as StubEl);
      for (let i = 0; i < 6; i++) await Promise.resolve();
    },
    check: async (index: number) => {
      const box = collect(root, (n) => hasClass(n, "runs-check"))[index] as StubEl;
      box.checked = true;
      for (const fn of box.listeners.change ?? []) fn({ target: box });
      await Promise.resolve();
    },
    clickStep: async (stepId: string) => {
      const line = collect(root, (n) => hasClass(n, "hist-step-line")).find((n) =>
        flatText(n).includes(stepId),
      );
      if (!line) throw new Error(`no receipt line for "${stepId}"`);
      click(line as StubEl);
      for (let i = 0; i < 6; i++) await Promise.resolve();
    },
    clickButton: async (label: string) => {
      const btn = collect(root, (n) => n.tag === "button" && flatText(n) === label)[0];
      if (!btn) throw new Error(`no "${label}" button`);
      click(btn);
      for (let i = 0; i < 6; i++) await Promise.resolve();
    },
    press: (key: string) => runs.handleKey({ key, target: null, preventDefault: () => {} }),
    noteFailure: (text: string) => runs.noteFailure(text),
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

  // Faceting rule, and the reason the two count functions are asymmetric: a
  // facet narrows the *other* facets, never itself. Status counts apply the
  // workflow filter; workflow counts apply the status filter. Neither applies
  // its own, or picking a value would erase every alternative to it.
  it("cross-filters the workflow counts by the selected status", async () => {
    const page = await mountRuns({
      runs: [
        record({ workflow: "bug-hunt", status: "error" }),
        record({
          id: "aaaaaaaa-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
          workflow: "bug-hunt",
          status: "done",
        }),
        record({
          id: "bbbbbbbb-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
          workflow: "mainline",
          status: "done",
        }),
      ],
    });
    const workflowCount = (name: string) => page.rail().find((r) => r.label === name)?.count;
    expect(workflowCount("bug-hunt")).toBe("2");
    expect(workflowCount("mainline")).toBe("1");

    const failed = collect(
      page.root,
      (n) => hasClass(n, "runs-rail-row") && flatText(n).startsWith("Failed"),
    )[0];
    click(failed as StubEl);
    // Only bug-hunt has a failure, so mainline drops out and bug-hunt reads 1.
    expect(workflowCount("bug-hunt")).toBe("1");
    expect(workflowCount("mainline")).toBeUndefined();
  });

  // Regression guard: applying the workflow filter to its own counts would
  // drop every other workflow out of the rail, and since the rail has no
  // "all workflows" row, there would be no way to switch to another one.
  it("keeps the other workflows reachable while one is selected", async () => {
    const page = await mountRuns({
      runs: [
        record({ workflow: "bug-hunt" }),
        record({ id: "bbbbbbbb-1a2b-4c3d-8e4f-5a6b7c8d9e0f", workflow: "mainline" }),
      ],
    });
    const pick = (name: string) =>
      collect(page.root, (n) => hasClass(n, "runs-rail-row") && flatText(n).includes(name))[0];
    click(pick("bug-hunt") as StubEl);
    expect(page.rows()).toHaveLength(1);
    // mainline is still listed, with its real count, so it can be switched to.
    expect(page.rail().find((r) => r.label === "mainline")?.count).toBe("1");
    click(pick("mainline") as StubEl);
    expect(page.rows()[0]?.text).toContain("bbbbb");
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

describe("runs page: comparison", () => {
  const TWO = [
    record({ workflow: "bug-hunt", durationMs: 124_000 }),
    record({
      id: "bbbbbbbb-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
      workflow: "mainline",
      status: "error",
      durationMs: 61_000,
      totals: {
        steps: 6,
        ok: 3,
        failed: 1,
        cached: 0,
        costUsd: 0.019,
        tokens: { input: 40_000, output: 8_000, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        durationMs: 61_000,
      },
    }),
  ];

  it("offers Compare only once a second run is checked", async () => {
    const page = await mountRuns({ runs: TWO });
    expect(page.head()).not.toContain("Compare");
    await page.check(0);
    expect(page.head()).toContain("1 selected");
    const compare = collect(
      page.root,
      (n) => n.tag === "button" && flatText(n) === "Compare",
    )[0] as StubEl;
    expect(compare.disabled).toBe(true);
    await page.check(1);
    expect(page.head()).toContain("2 selected");
  });

  it("puts the checked runs side by side without losing the rails", async () => {
    const page = await mountRuns({ runs: TWO });
    await page.check(0);
    await page.check(1);
    await page.clickButton("Compare");
    const grid = page.main();
    expect(grid).toContain("Workflow");
    expect(grid).toContain("bug-hunt");
    expect(grid).toContain("mainline");
    // Each run's own totals, so a difference is readable across the row.
    expect(grid).toContain("2:04");
    expect(grid).toContain("1:01");
    expect(grid).toContain("$0.041");
    expect(grid).toContain("$0.019");
    expect(grid).toContain("6/6");
    expect(grid).toContain("3/6");
    // The rails survive the view switch — the list is never lost.
    expect(page.rail().length).toBeGreaterThan(0);
    expect(page.receipt()).toBeTruthy();
  });

  it("goes back to the table", async () => {
    const page = await mountRuns({ runs: TWO });
    await page.check(0);
    await page.check(1);
    await page.clickButton("Compare");
    await page.clickButton("← Runs");
    expect(page.rows()).toHaveLength(2);
  });
});

describe("runs page: the full receipt", () => {
  const DETAIL = {
    ...record(),
    phases: [
      {
        phaseId: "scan",
        title: "Scan",
        index: 0,
        stepCount: 1,
        done: true,
        ok: true,
        steps: [
          { stepId: "scan-logic", status: "done", result: { durationMs: 41_200, costUsd: 0.0104 } },
        ],
      },
      {
        phaseId: "report",
        title: "Verify & report",
        index: 1,
        stepCount: 1,
        done: true,
        ok: true,
        steps: [
          { stepId: "report", status: "done", result: { durationMs: 23_400, costUsd: 0.0031 } },
        ],
      },
    ],
  };

  async function openFullReceipt(over: Parameters<typeof mountRuns>[0] = {}) {
    const page = await mountRuns({ runs: [record()], detail: DETAIL, ...over });
    await page.clickRow(0);
    await page.clickButton("Full receipt");
    return page;
  }

  it("draws the phase tree in the centre pane, with the rails still up", async () => {
    const page = await openFullReceipt();
    const main = page.main();
    expect(main).toContain("Scan");
    expect(main).toContain("Verify & report");
    expect(main).toContain("scan-logic");
    expect(main).toContain("report");
    // Deep view, but still not a modal — both rails are where they were.
    expect(page.rail().length).toBeGreaterThan(0);
    expect(page.receipt()).toContain("8f21c");
  });

  it("offers Diagnose only on a failed run, and hands the record to the modal", async () => {
    // A successful receipt has no postmortem to run.
    const done = await openFullReceipt();
    expect(done.main()).not.toContain("Diagnose");

    const failed = await openFullReceipt({ detail: { ...DETAIL, ok: false, status: "error" } });
    expect(failed.diagnoseCalls).toHaveLength(0);
    await failed.clickButton("Diagnose");
    expect(failed.diagnoseCalls).toHaveLength(1);
    expect((failed.diagnoseCalls[0] as { workflow?: string }).workflow).toBe("bug-hunt");
  });

  it("keeps a step's recorded output shut until it is asked for", async () => {
    const page = await openFullReceipt({
      detail: {
        ...DETAIL,
        phases: [
          {
            ...DETAIL.phases[0],
            steps: [
              {
                stepId: "scan-logic",
                status: "done",
                blockKind: "worker",
                model: "sonnet",
                text: "FOUND-A-BUG-IN-THE-TEARDOWN",
                result: { durationMs: 41_200, costUsd: 0.0104 },
              },
            ],
          },
        ],
      },
    });

    // The line is what a receipt is read at a glance for; the output is a
    // click away rather than a wall of panes.
    expect(page.main()).toContain("scan-logic");
    expect(page.main()).toContain("worker · sonnet");
    expect(page.main()).not.toContain("FOUND-A-BUG-IN-THE-TEARDOWN");

    await page.clickStep("scan-logic");
    expect(page.main()).toContain("FOUND-A-BUG-IN-THE-TEARDOWN");

    await page.clickStep("scan-logic");
    expect(page.main()).not.toContain("FOUND-A-BUG-IN-THE-TEARDOWN");
  });

  it("tags the states that explain a cheap or odd step", async () => {
    const page = await openFullReceipt({
      detail: {
        ...DETAIL,
        phases: [
          {
            ...DETAIL.phases[0],
            steps: [
              { stepId: "scan-logic", status: "done", cached: true, result: {} },
              {
                stepId: "findings-ready",
                status: "done",
                blockKind: "gate",
                gate: { passed: true },
                result: {},
              },
              { stepId: "flaky", status: "done", attempts: 3, result: {} },
            ],
          },
        ],
      },
    });
    const main = page.main();
    expect(main).toContain("cached");
    expect(main).toContain("gate pass");
    expect(main).toContain("3 attempts");
  });

  it("closes with what the run did to the machine", async () => {
    const page = await openFullReceipt({
      detail: {
        ...DETAIL,
        phases: [
          {
            ...DETAIL.phases[0],
            steps: [
              {
                stepId: "scan-logic",
                status: "done",
                attempts: 2,
                worktree: { branch: "st/scan-logic", mergedAt: 12 },
                result: {},
              },
              {
                stepId: "report",
                status: "done",
                worktree: { branch: "st/report" },
                result: {},
              },
            ],
          },
        ],
        harvest: { prunedAt: 99 },
      },
    });
    const main = page.main();
    expect(main).toContain("2 step trees · discarded");
    expect(main).toContain("1 (scan-logic)");
  });

  it("shows the per-model cost roll-up", async () => {
    const page = await openFullReceipt({
      byModel: [{ model: "claude/sonnet", steps: 6, costUsd: 0.041, tokens: {} }],
    });
    expect(page.main()).toContain("claude/sonnet");
    expect(page.main()).toContain("$0.0410");
  });

  it("carries the run actions, and the retry pair only when something failed", async () => {
    const clean = await openFullReceipt();
    expect(clean.main()).toContain("Re-run");
    expect(clean.main()).not.toContain("Retry failed");

    const failed = await openFullReceipt({
      detail: {
        ...DETAIL,
        status: "error",
        phases: [
          {
            ...DETAIL.phases[0],
            steps: [{ stepId: "scan-logic", status: "error", result: {} }],
          },
        ],
      },
    });
    expect(failed.main()).toContain("Retry failed");
    expect(failed.main()).toContain("Retry with agent…");
  });

  it("lists the retained worktrees and their lifecycle actions", async () => {
    const page = await openFullReceipt({
      worktrees: [
        {
          stepId: "scan-logic",
          exists: true,
          branch: "st/scan-logic",
          files: [{ status: "M", path: "a.ts" }],
          additions: 12,
          deletions: 3,
        },
      ],
    });
    const main = page.main();
    expect(main).toContain("Worktree changes");
    expect(main).toContain("scan-logic");
    expect(main).toContain("+12");
    expect(main).toContain("Apply to checkout");
    expect(main).toContain("Prune worktrees");
  });

  // A second 409 used to append another "first wins" / "last wins" pair beside
  // the one already on the row. The row is replaced, so it stays one pair, and
  // the retry posts the deterministic winner.
  it("replaces conflict retry buttons instead of stacking them on a repeated 409", async () => {
    const page = await openFullReceipt({
      worktrees: [
        {
          stepId: "scan-logic",
          exists: true,
          branch: "st/scan-logic",
          files: [{ status: "M", path: "a.ts" }],
          additions: 12,
          deletions: 3,
        },
      ],
      harvestResponses: [
        { status: 409, body: { error: "sources conflict" } },
        { status: 409, body: { error: "sources conflict" } },
      ],
    });

    await page.clickButton("Apply to checkout");
    expect(buttonsNamed(page.root, "Retry: first wins")).toHaveLength(1);
    expect(buttonsNamed(page.root, "Retry: last wins")).toHaveLength(1);

    await page.clickButton("Retry: first wins");
    expect(buttonsNamed(page.root, "Retry: first wins")).toHaveLength(1);
    expect(buttonsNamed(page.root, "Retry: last wins")).toHaveLength(1);
    const banners = collect(
      page.root,
      (n) => hasClass(n, "mbanner") && n.textContent.includes("deterministic winner"),
    );
    expect(banners).toHaveLength(1);
    expect(banners[0]?.textContent).toBe("sources conflict — retry with a deterministic winner:");
    expect(page.harvestPosts).toEqual([{ mode: "apply" }, { mode: "apply", onConflict: "ours" }]);
  });
});

describe("runs page: destructive actions", () => {
  it("clears the list only when the server actually cleared it", async () => {
    const ok = await mountRuns({ runs: [record()] });
    await ok.clickButton("Clear history");
    expect(ok.rows()).toHaveLength(0);
    expect(ok.said.join(" ")).toContain("Cleared");
  });

  // Wiping the client list on a rejected DELETE would show an empty page that
  // the next poll silently repopulates — the reader would think it worked.
  it("keeps the list and relays the server's reason when it refuses", async () => {
    const denied = await mountRuns({ runs: [record()], deleteStatus: 403 });
    await denied.clickButton("Clear history");
    expect(denied.rows()).toHaveLength(1);
    // The server's own words, not a message the page could have invented.
    expect(denied.said.join(" ")).toContain(SERVER_DELETE_ERROR);
  });

  // `(r.body && r.body.error) || "clear failed"` — a 5xx from a proxy has no
  // JSON body at all, and silence would read as success.
  it("falls back to its own wording when the refusal carries no reason", async () => {
    const bare = await mountRuns({ runs: [record()], deleteStatus: 502, deleteBare: true });
    await bare.clickButton("Clear history");
    expect(bare.rows()).toHaveLength(1);
    expect(bare.said.join(" ")).toContain("clear failed");
  });

  // A refused delete must not look like a successful one: the reader stays on
  // the receipt they were reading, rather than being bounced to a list that
  // still contains the run they think they just deleted.
  it("leaves the reader on the receipt when its delete is refused", async () => {
    const page = await mountRuns({
      runs: [record()],
      detail: { ...record(), phases: [] },
      deleteStatus: 500,
    });
    await page.clickRow(0);
    await page.clickButton("Full receipt");
    await page.clickButton("Delete");
    expect(page.main()).toContain("full receipt");
    expect(page.receipt()).toContain("8f21c");
    expect(page.said.join(" ")).toContain(SERVER_DELETE_ERROR);
  });

  it("falls back to its own wording when a refused delete carries no reason", async () => {
    const page = await mountRuns({
      runs: [record()],
      detail: { ...record(), phases: [] },
      deleteStatus: 500,
      deleteBare: true,
    });
    await page.clickRow(0);
    await page.clickButton("Full receipt");
    await page.clickButton("Delete");
    expect(page.said.join(" ")).toContain("delete failed");
  });

  it("drops the run and returns to the list when its delete succeeds", async () => {
    const page = await mountRuns({ runs: [record()], detail: { ...record(), phases: [] } });
    await page.clickRow(0);
    await page.clickButton("Full receipt");
    await page.clickButton("Delete");
    expect(page.rows()).toHaveLength(0);
    expect(page.receipt()).toContain("No run selected");
  });

  // The cockpit banner is hidden on this page. An unhandled request failure
  // (prune, re-run) has to land in the centre pane or the click looks dead.
  it("shows an unhandled request failure in the centre pane", async () => {
    const page = await mountRuns({ runs: [record()] });
    page.noteFailure("Request failed: Failed to fetch");
    expect(page.main()).toContain("Request failed: Failed to fetch");
    page.noteFailure("Request failed: Failed to fetch");
    expect(page.main()).toContain("Request failed: Failed to fetch");
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

describe("runs page: the logs view", () => {
  /** A record with output worth reading, a fan-out parent, and a silent step. */
  function detailWithLogs(): Record<string, unknown> {
    return {
      ...record(),
      phases: [
        {
          phaseId: "scan",
          title: "Scan",
          steps: [
            {
              stepId: "scan-logic",
              status: "done",
              cached: true,
              result: { durationMs: 12_000, costUsd: 0.01, output: "scan output here" },
            },
            // Summarised by its children — listing the parent too would
            // double the phase's output in the log.
            { stepId: "fan-parent", status: "done", result: { childResults: [{}, {}] } },
            { stepId: "silent-step", status: "done", result: {} },
          ],
        },
        {
          phaseId: "report",
          title: "Report",
          steps: [
            {
              stepId: "write-report",
              status: "done",
              result: { durationMs: 3000 },
              text: "report body text",
            },
          ],
        },
      ],
    };
  }

  it("offers Full receipt, Logs and Re-run in the drill-in footer", async () => {
    const page = await mountRuns({ runs: [record()], detail: detailWithLogs() });
    await page.clickRow(0);
    const receipt = page.receipt();
    expect(receipt).toContain("Full receipt");
    expect(receipt).toContain("Logs");
    expect(receipt).toContain("Re-run");
    // Copy id moved out of the footer; it still lives in the full receipt.
    expect(receipt).not.toContain("Copy id");
  });

  it("lays out every step's output in run order, skipping fan-out parents", async () => {
    const page = await mountRuns({ runs: [record()], detail: detailWithLogs() });
    await page.clickRow(0);
    await page.clickButton("Logs");
    expect(page.head()).toContain("logs · 8f21c");
    const main = page.main();
    expect(main).toContain("scan output here");
    expect(main).toContain("report body text");
    expect(main).toContain("No output captured");
    // Three log sections — the fan-out parent is not one of them.
    const heads = collect(page.root, (n) => hasClass(n, "runs-log-head"));
    expect(heads).toHaveLength(3);
    expect(heads.map((head) => flatText(head)).join(" ")).not.toContain("fan-parent");
    // Scan's section precedes Report's.
    expect(main.indexOf("scan output here")).toBeLessThan(main.indexOf("report body text"));
  });

  it("offers Copy all and a .txt download in the logs header", async () => {
    const page = await mountRuns({ runs: [record()], detail: detailWithLogs() });
    await page.clickRow(0);
    await page.clickButton("Logs");
    const buttons = collect(page.root, (n) => n.tag === "button").map((b) => flatText(b));
    expect(buttons).toContain("Copy all");
    expect(buttons).toContain("Download .txt");
  });

  it("returns to the list on Escape", async () => {
    const page = await mountRuns({ runs: [record()], detail: detailWithLogs() });
    await page.clickRow(0);
    await page.clickButton("Logs");
    expect(page.main()).toContain("scan output here");
    expect(page.press("Escape")).toBe(true);
    expect(page.main()).not.toContain("scan output here");
    expect(page.rows()).toHaveLength(1);
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
  it("caps the step ledger in its own scroll region so the result pane survives", () => {
    const body = ruleBody(runsCss, ".runs-ledger-rows");
    expect(body).toContain("max-height: 34vh");
    expect(body).toContain("overflow-y: auto");
    expect(body).toContain("overscroll-behavior: contain");
  });

  it("stacks the three columns on a narrow viewport instead of hiding them", () => {
    const narrow = runsCss.slice(runsCss.indexOf("@media (max-width: 900px)"));
    expect(narrow).toContain("flex-direction: column");
    expect(narrow).not.toMatch(/\.runs-receipt[^{]*\{[^}]*display:\s*none/);
  });
});

describe("runs page: step cost cell", () => {
  const src = runsJs.match(/function stepCostText\([\s\S]*?\n {2}\}\n/)?.[0];
  const stepCostText = new Function(`${src}; return stepCostText;`)() as (
    step: object,
    result: object,
  ) => string;

  it("prices a cached replay at $0 this run, even for an agent that reports no cost", () => {
    expect(stepCostText({ cached: true, agent: "antigravity" }, {})).toBe("$0");
    expect(stepCostText({ cached: true, agent: "claude" }, { costUsd: 0.5 })).toBe("$0");
  });

  it("keeps unknown, free and billed apart for steps that ran", () => {
    expect(stepCostText({ agent: "antigravity" }, {})).toBe("—");
    expect(stepCostText({ agent: "claude" }, { costUsd: 0 })).toBe("free");
    expect(stepCostText({ kind: "command" }, {})).toBe("free");
    expect(stepCostText({ agent: "claude" }, { costUsd: 0.5 })).toBe("$0.5000");
  });
});
