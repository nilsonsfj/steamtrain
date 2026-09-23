/**
 * The web client's state-preservation helpers (#166). `render()` rebuilds the
 * run surface and the instrument rail wholesale, and a live run schedules a
 * render every 2 seconds (see the contract note at the top of st-boot.js), so
 * whatever the reader is in the middle of — focus and caret, a scrolled-back
 * event log, an opened diff, a half-typed answer — must be carried across the
 * rebuild by these helpers or it is lost. Every bug found in the Console
 * rebuild (#159) lived here.
 *
 * The real st-core.js (and its `h()`), st-instruments.js and st-run.js run
 * against a stub DOM: just enough element behavior for them, plus a simple
 * layout model (fixed-height rows, wrapped by text length) for the scroll
 * anchor. No jsdom.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import * as SteamtrainReducer from "../src/web/reducer";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public");
const read = (name: string) => readFileSync(join(PUBLIC_DIR, name), "utf8");
const coreJs = read("st-core.js");
const instrumentsJs = read("st-instruments.js");
const runJs = read("st-run.js");

type Listener = (e?: unknown) => void;

/** Layout of the event log: its viewport, header and a row's height per 30 characters of text. */
const LOG_TOP = 100;
const LOG_VIEWPORT = 100;
const LABEL_HEIGHT = 16;
const LINE_HEIGHT = 20;

class StubEl {
  attrs: Record<string, string> = {};
  children: StubEl[] = [];
  parentNode: StubEl | null = null;
  className = "";
  value = "";
  text = "";
  open = false;
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  style: Record<string, string> = {};
  listeners: Record<string, Listener[]> = {};
  private top = 0;
  constructor(readonly tag: string) {
    if (tag === "input" || tag === "textarea") {
      this.selectionStart = 0;
      this.selectionEnd = 0;
    }
  }

  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.children = [];
    this.text = v;
  }
  get firstChild(): StubEl | null {
    return this.children[0] ?? null;
  }
  appendChild(c: StubEl): StubEl {
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  removeChild(c: StubEl): void {
    this.children = this.children.filter((k) => k !== c);
    c.parentNode = null;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = String(v);
    if (k === "style") {
      for (const decl of String(v).split(";")) {
        const [prop, val] = decl.split(":");
        if (prop?.trim()) this.style[prop.trim()] = (val ?? "").trim();
      }
    }
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  addEventListener(event: string, fn: Listener): void {
    const bucket = this.listeners[event] ?? [];
    this.listeners[event] = bucket;
    bucket.push(fn);
  }
  fire(event: string): void {
    for (const fn of this.listeners[event] ?? []) {
      fn({ target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} });
    }
  }
  focus(): void {
    stubDocument.activeElement = this;
  }
  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  classList = {
    add: (c: string) => this.setClass(c, true),
    remove: (c: string) => this.setClass(c, false),
    toggle: (c: string, on?: boolean) => this.setClass(c, on ?? !this.classList.contains(c)),
    contains: (c: string) => this.className.split(" ").includes(c),
  };
  private setClass(c: string, on: boolean): void {
    const parts = new Set(this.className.split(" ").filter(Boolean));
    if (on) parts.add(c);
    else parts.delete(c);
    this.className = [...parts].join(" ");
  }
  /** Selectors the code under test uses: `.a`, `[attr]`, `[attr="v"]`, `.a > [attr]`, `.a > [attr="v"]`. */
  matches(sel: string): boolean {
    const child = sel.split(" > ");
    if (child.length === 2) {
      return Boolean(this.parentNode?.matches(child[0]!)) && this.matches(child[1]!);
    }
    if (sel.startsWith(".")) return this.classList.contains(sel.slice(1));
    const attr = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(sel);
    if (attr) {
      const [, name, value] = attr;
      return name! in this.attrs && (value === undefined || this.attrs[name!] === value);
    }
    return this.tag === sel;
  }
  closest(sel: string): StubEl | null {
    let node: StubEl | null = this;
    while (node && !node.matches(sel)) node = node.parentNode;
    return node;
  }
  querySelectorAll(sel: string, out: StubEl[] = []): StubEl[] {
    for (const kid of this.children) {
      if (kid.matches(sel)) out.push(kid);
      kid.querySelectorAll(sel, out);
    }
    return out;
  }
  querySelector(sel: string): StubEl | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }

  // ---- layout, for the event log only ----
  private get log(): StubEl | null {
    return this.closest(".eventlog");
  }
  private get height(): number {
    if (this.classList.contains("inst-label")) return LABEL_HEIGHT;
    if ("data-seq" in this.attrs)
      return LINE_HEIGHT * Math.max(1, Math.ceil(this.textContent.length / 30));
    return this.children.reduce((sum, c) => sum + c.height, 0);
  }
  /** Offset of this node's top within its scroll container's content. */
  private get offset(): number {
    const parent = this.parentNode;
    if (!parent || this.classList.contains("eventlog")) return 0;
    const before = parent.children.slice(0, parent.children.indexOf(this));
    return parent.offset + before.reduce((sum, c) => sum + c.height, 0);
  }
  get scrollHeight(): number {
    return this.height;
  }
  get clientHeight(): number {
    return LOG_VIEWPORT;
  }
  get scrollTop(): number {
    return this.top;
  }
  set scrollTop(v: number) {
    this.top = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight));
  }
  getBoundingClientRect(): { top: number; bottom: number } {
    const log = this.log;
    if (!log || log === this) return { top: LOG_TOP, bottom: LOG_TOP + LOG_VIEWPORT };
    const top = LOG_TOP + this.offset - log.scrollTop;
    return { top, bottom: top + this.height };
  }
}

const stubDocument = {
  activeElement: null as StubEl | null,
  body: new StubEl("body"),
  byId: {} as Record<string, StubEl>,
  getElementById(id: string) {
    return this.byId[id] ?? null;
  },
  createElement: (tag: string) => new StubEl(tag),
  createTextNode: (text: string) => {
    const node = new StubEl("#text");
    node.text = text;
    return node;
  },
  querySelector: (sel: string) => stubDocument.body.querySelector(sel),
  querySelectorAll: (sel: string) => stubDocument.body.querySelectorAll(sel),
  contains: () => true,
};

interface Client {
  S: Record<string, unknown> & {
    eventLog: unknown[];
    approvalDiffOpen: Record<string, boolean>;
    humanInputDraft: Record<string, string>;
    subWorkflowOpen: Record<string, boolean>;
    spec: unknown;
  };
  captureFocus: () => unknown;
  restoreFocus: (token: unknown) => boolean;
  instruments: { render: (c: StubEl) => void; onEvent: (e: unknown) => void; reset: () => void };
  renderCard: (s: unknown, p: unknown) => StubEl;
}

/** Load the client modules over the stub DOM, as the page's script tags do. */
function loadClient(): Client {
  stubDocument.body = new StubEl("body");
  stubDocument.activeElement = null;
  stubDocument.byId = {};
  const window: Record<string, unknown> = {
    SteamtrainReducer,
    SteamtrainDiff: { renderPatch: () => new StubEl("pre") },
    location: { hash: "", pathname: "/", search: "" },
    addEventListener: () => {},
  };
  const args = [
    "window",
    "document",
    "localStorage",
    "setInterval",
    "clearInterval",
    "setTimeout",
    "SteamtrainReducer",
  ];
  const values = [
    window,
    stubDocument,
    { getItem: () => null, setItem: () => {} },
    () => 1,
    () => {},
    () => 0,
    window.SteamtrainReducer,
  ];
  for (const source of [coreJs, instrumentsJs, runJs]) new Function(...args, source)(...values);
  const ST = window.Steamtrain as Record<string, unknown> & {
    state: Client["S"];
    instruments: Client["instruments"];
    run: { renderCard: Client["renderCard"] };
  };
  ST.agentUiLabel = (id: string) => id;
  return {
    S: ST.state,
    captureFocus: ST.captureFocus as Client["captureFocus"],
    restoreFocus: ST.restoreFocus as Client["restoreFocus"],
    instruments: ST.instruments,
    renderCard: ST.run.renderCard,
  };
}

describe("captureFocus / restoreFocus", () => {
  let client: Client;
  beforeEach(() => {
    client = loadClient();
  });

  /** The page as one render paints it: a text box and a button, each with its focus key. */
  function paint() {
    stubDocument.body.children = [];
    const box = stubDocument.createElement("textarea");
    box.setAttribute("data-focus-key", "human-input:review:2:ask");
    const button = stubDocument.createElement("button");
    button.setAttribute("data-focus-key", "approve:review:2:gate");
    stubDocument.body.appendChild(box);
    stubDocument.body.appendChild(button);
    return { box, button };
  }

  it("puts focus and the caret back in the rebuilt control", () => {
    const before = paint().box;
    before.focus();
    before.setSelectionRange(4, 9);
    const token = client.captureFocus();

    const after = paint().box; // the rebuild: every node is new
    expect(client.restoreFocus(token)).toBe(true);
    expect(stubDocument.activeElement).toBe(after);
    expect([after.selectionStart, after.selectionEnd]).toEqual([4, 9]);
  });

  it("moves focus to a rebuilt button, which has no caret", () => {
    paint().button.focus();
    const token = client.captureFocus();
    const { button } = paint();
    expect(client.restoreFocus(token)).toBe(true);
    expect(stubDocument.activeElement).toBe(button);
  });

  it("fails safely when the control is gone after the rebuild", () => {
    paint().box.focus();
    const token = client.captureFocus();
    stubDocument.body.children = []; // the step finished; its form is gone
    stubDocument.activeElement = null;
    expect(client.restoreFocus(token)).toBe(false);
    expect(stubDocument.activeElement).toBeNull();
  });

  it("captures nothing for a focused element without a focus key", () => {
    stubDocument.createElement("input").focus();
    expect(client.captureFocus()).toBeNull();
    expect(client.restoreFocus(null)).toBe(false);
  });

  it("still restores focus when the control cannot report a caret", () => {
    const { box } = paint();
    // Some browsers throw reading selectionStart on number/email inputs.
    Object.defineProperty(box, "selectionStart", {
      get() {
        throw new Error("InvalidStateError");
      },
    });
    box.focus();
    const token = client.captureFocus();
    const after = paint().box;
    expect(client.restoreFocus(token)).toBe(true);
    expect(stubDocument.activeElement).toBe(after);
  });
});

describe("the event log's scroll anchor", () => {
  let client: Client;
  let rail: StubEl;
  let at = 0;
  beforeEach(() => {
    client = loadClient();
    client.instruments.reset();
    rail = new StubEl("div");
    at = 0;
  });

  function log(count: number, text = (n: number) => `step-${n}`) {
    for (let i = 0; i < count; i++) {
      at += 1;
      client.instruments.onEvent({ kind: "step_start", stepId: text(at), ts: at });
    }
  }
  const view = () => rail.querySelector(".eventlog")!;
  /** The entry at the top edge of the viewport, and how far it sits from that edge. */
  function reading() {
    const box = view();
    const top = box.getBoundingClientRect().top;
    const row = box
      .querySelectorAll(".rows > [data-seq]")
      .find((r) => r.getBoundingClientRect().bottom > top + 1)!;
    return { text: row.textContent, offset: row.getBoundingClientRect().top - top };
  }

  it("keeps the reader on the entry they scrolled back to as new ones arrive above it", () => {
    log(30);
    client.instruments.render(rail);
    view().scrollTop = 250;
    const before = reading();

    log(5); // prepended above the reader
    client.instruments.render(rail);
    expect(reading()).toEqual(before);
  });

  it("holds the anchor once the log is at its cap, and entries also leave at the tail", () => {
    // Rows of different heights, so what arrives above and what is evicted
    // below never cancel out in height.
    log(200, (n) => (n % 3 ? `s${n}` : `a long step id that wraps onto two lines ${n}`));
    client.instruments.render(rail);
    view().scrollTop = 1200;
    const before = reading();

    for (let tick = 0; tick < 10; tick++) {
      log(3, (n) => `a newly arrived step whose id wraps ${n}`);
      client.instruments.render(rail);
      expect(client.S.eventLog).toHaveLength(200);
      expect(reading()).toEqual(before);
    }
  });

  it("stays as close as it can when the anchored entry ages out of the log", () => {
    log(200);
    client.instruments.render(rail);
    const bottom = view().scrollHeight - view().clientHeight;
    view().scrollTop = bottom; // reading the oldest entries

    log(20); // the entries on screen are evicted
    client.instruments.render(rail);
    expect(view().scrollTop).toBe(bottom);
  });

  it("leaves a reader at the head at the head", () => {
    log(30);
    client.instruments.render(rail);
    log(5);
    client.instruments.render(rail);
    expect(view().scrollTop).toBe(0);
    expect(reading().text).toContain("step-35");
  });
});

describe("transient step state across a rebuild", () => {
  let client: Client;
  beforeEach(() => {
    client = loadClient();
  });

  const pass = (iteration: number) => ({ phaseId: "review", iteration });

  it("keeps an opened approval diff open, for that loop pass only", () => {
    const step = {
      stepId: "gate",
      status: "running",
      blockKind: "approval",
      approval: {
        pending: true,
        diff: { files: [{ path: "a.ts" }], additions: 1, deletions: 0, patch: "@@" },
      },
    };
    const toggle = (card: StubEl) =>
      card.querySelectorAll("button").find((b) => b.classList.contains("approval-diff-toggle"))!;
    const body = (card: StubEl) => card.querySelector(".approval-diff-body")!;

    toggle(client.renderCard(step, pass(1))).fire("click");
    const rebuilt = client.renderCard(step, pass(1));
    expect(toggle(rebuilt).textContent).toBe("Hide diff");
    expect(body(rebuilt).style.display ?? "").toBe("");

    const nextPass = client.renderCard(step, pass(2));
    expect(toggle(nextPass).textContent).toBe("View diff");
    expect(client.S.approvalDiffOpen).toEqual({ "review:1:gate": true });
  });

  it("keeps a half-typed answer, for that loop pass only", () => {
    const step = {
      stepId: "ask",
      status: "running",
      blockKind: "human",
      humanInput: { pending: true, question: { prompt: "Which one?" } },
    };
    const box = (card: StubEl) => card.querySelector("textarea")!;
    const first = box(client.renderCard(step, pass(1)));
    first.value = "the second o";
    first.fire("input");

    expect(box(client.renderCard(step, pass(1))).value).toBe("the second o");
    expect(box(client.renderCard(step, pass(2))).value).toBe("");
  });

  it("keeps an expanded sub-workflow open, for that loop pass only", () => {
    client.S.spec = {
      phases: [{ id: "review", steps: [{ id: "call", kind: "workflow", workflow: "child" }] }],
    };
    const step = { stepId: "call", status: "running", blockKind: "workflow" };
    const details = (card: StubEl) => card.querySelector("details")!;
    const first = details(client.renderCard(step, pass(1)));
    first.open = true;
    first.fire("toggle");

    expect(details(client.renderCard(step, pass(1))).open).toBe(true);
    expect(details(client.renderCard(step, pass(2))).open).toBe(false);
  });
});
