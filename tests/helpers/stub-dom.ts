/**
 * A stub DOM for running the web client's real modules (`src/web/public/st-*.js`)
 * in tests, without jsdom. The client is vanilla JS with no build step; each
 * module is an IIFE over `window.Steamtrain`, so a test loads the sources it
 * needs with {@link loadScripts} against a {@link createDom} document and then
 * drives what they render.
 *
 * The element is deliberately small but behaves like the real thing where the
 * client relies on it: `textContent` spans the subtree, `h()` string children
 * are text nodes, a `style` or `value` attribute reaches `style` / `value`,
 * `closest` walks `parentNode`, and `focus()` moves `activeElement`. It has no
 * layout; a test that needs one (see web-state-preservation) passes its own
 * element subclass to `createDom`.
 */

export type Listener = (event?: unknown) => void;

/** The event object handlers get from {@link StubEl.fire}. */
export interface StubEvent {
  type: string;
  target: StubEl;
  currentTarget: StubEl | StubDocument;
  key?: string;
  shiftKey?: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}

export class StubEl {
  /** String attributes, as `setAttribute` (or `h()`) set them. */
  attrs: Record<string, string> = {};
  children: StubEl[] = [];
  parentNode: StubEl | null = null;
  className = "";
  value = "";
  checked = false;
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  style: Record<string, string> = {};
  listeners: Record<string, Listener[]> = {};
  /** A text node's data. An element's text lives in text-node children, as in a browser. */
  text = "";

  constructor(
    readonly tag: string,
    readonly ownerDocument: StubDocument,
  ) {
    if (tag === "input" || tag === "textarea") {
      this.selectionStart = 0;
      this.selectionEnd = 0;
    }
  }

  // `disabled`, `hidden` and `open` reflect their attributes, as a browser's
  // do, so `[disabled]` and `:not([hidden])` see what a script set. `value`
  // and `checked` do not: in a browser they drift from the attribute too.
  get disabled(): boolean {
    return this.hasAttribute("disabled");
  }
  set disabled(on: boolean) {
    this.toggleAttribute("disabled", on);
  }
  get hidden(): boolean {
    return this.hasAttribute("hidden");
  }
  set hidden(on: boolean) {
    this.toggleAttribute("hidden", on);
  }
  get open(): boolean {
    return this.hasAttribute("open");
  }
  set open(on: boolean) {
    this.toggleAttribute("open", on);
  }

  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    const text = v == null ? "" : String(v);
    if (this.tag === "#text") {
      this.text = text;
      return;
    }
    // A child, as a browser makes one, so st-core's `clear` (which removes
    // children) empties the node the way it would on the page.
    this.text = "";
    if (text) this.appendChild(this.ownerDocument.createTextNode(text));
  }
  /** `id` reflects its attribute, so `getElementById` finds a node a script named. */
  get id(): string {
    return this.attrs.id ?? "";
  }
  set id(v: string) {
    this.attrs.id = String(v);
  }
  get firstChild(): StubEl | null {
    return this.children[0] ?? null;
  }
  get lastChild(): StubEl | null {
    return this.children[this.children.length - 1] ?? null;
  }
  get parentElement(): StubEl | null {
    return this.parentNode;
  }
  /** A `<select>`'s options, optgroups included. */
  get options(): StubEl[] {
    return this.querySelectorAll("option");
  }

  appendChild(c: StubEl): StubEl {
    c.parentNode?.removeChild(c);
    c.parentNode = this;
    this.children.push(c);
    // A select takes its first option's value, as a browser's does.
    if (this.tag === "select" && !this.value && c.tag === "option") this.value = c.value;
    return c;
  }
  insertBefore(c: StubEl, ref: StubEl | null): StubEl {
    if (!ref) return this.appendChild(c);
    if (ref.parentNode !== this)
      throw new Error("stub-dom: insertBefore's reference is not a child");
    c.parentNode?.removeChild(c);
    c.parentNode = this;
    this.children.splice(this.children.indexOf(ref), 0, c);
    return c;
  }
  removeChild(c: StubEl): StubEl {
    if (c.parentNode !== this) throw new Error("stub-dom: removeChild's node is not a child");
    this.children = this.children.filter((k) => k !== c);
    c.parentNode = null;
    return c;
  }
  remove(): void {
    this.parentNode?.removeChild(this);
  }

  setAttribute(k: string, v: unknown): void {
    const value = String(v);
    this.attrs[k] = value;
    if (k === "class") this.className = value;
    else if (k === "value") this.value = value;
    else if (k === "style") {
      for (const decl of value.split(";")) {
        const [prop, val] = decl.split(":");
        if (prop?.trim()) this.style[prop.trim()] = (val ?? "").trim();
      }
    }
  }
  getAttribute(k: string): string | null {
    if (k === "class") return this.className || null;
    return this.attrs[k] ?? null;
  }
  hasAttribute(k: string): boolean {
    return this.getAttribute(k) !== null;
  }
  removeAttribute(k: string): void {
    delete this.attrs[k];
    if (k === "class") this.className = "";
  }
  toggleAttribute(k: string, on?: boolean): boolean {
    const next = on ?? !this.hasAttribute(k);
    if (next) this.attrs[k] ??= "";
    else this.removeAttribute(k);
    return next;
  }

  addEventListener(event: string, fn: Listener): void {
    const bucket = this.listeners[event] ?? [];
    this.listeners[event] = bucket;
    bucket.push(fn);
  }
  removeEventListener(event: string, fn: Listener): void {
    this.listeners[event] = (this.listeners[event] ?? []).filter((f) => f !== fn);
  }
  /** Call this node's own `event` listeners (no bubbling). */
  fire(event: string, init: Partial<StubEvent> = {}): void {
    const e: StubEvent = {
      type: event,
      target: this,
      currentTarget: this,
      preventDefault() {},
      stopPropagation() {},
      ...init,
    };
    for (const fn of [...(this.listeners[event] ?? [])]) fn(e);
  }
  /**
   * Fire `event` here, then on each ancestor in turn, until a handler stops
   * it. From a node in the body it goes on to the document's own listeners.
   */
  dispatch(event: string, init: Partial<StubEvent> = {}): void {
    let stopped = false;
    const stopPropagation = () => {
      stopped = true;
    };
    let top: StubEl = this;
    for (let node: StubEl | null = this; node && !stopped; node = node.parentNode) {
      top = node;
      node.fire(event, { target: this, ...init, currentTarget: node, stopPropagation });
    }
    const doc = this.ownerDocument;
    if (stopped || top !== doc.body) return;
    const e: StubEvent = {
      type: event,
      target: this,
      preventDefault() {},
      ...init,
      currentTarget: doc,
      stopPropagation,
    };
    for (const fn of [...(doc.listeners[event] ?? [])]) fn(e);
  }
  /** A click, bubbling as a browser's does. */
  click(): void {
    this.dispatch("click");
  }
  focus(): void {
    this.ownerDocument.activeElement = this;
  }
  blur(): void {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
  }
  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  classList = {
    add: (...cs: string[]) => {
      for (const c of cs) this.setClass(c, true);
    },
    remove: (...cs: string[]) => {
      for (const c of cs) this.setClass(c, false);
    },
    toggle: (c: string, on?: boolean) => {
      const next = on ?? !this.classList.contains(c);
      this.setClass(c, next);
      return next;
    },
    contains: (c: string) => this.className.split(" ").includes(c),
  };
  private setClass(c: string, on: boolean): void {
    const parts = new Set(this.className.split(" ").filter(Boolean));
    if (on) parts.add(c);
    else parts.delete(c);
    this.className = [...parts].join(" ");
  }

  /**
   * The selectors the client uses: comma lists; descendant (` `) and child
   * (`>`) combinators; compounds of a tag, `#id`, `.classes`,
   * `[attr]` / `[attr="value"]` (or single quotes) and `:not(…)` of such a
   * compound. Anything else, an empty selector included, throws, so a test
   * never passes on a selector the stub silently ignored.
   */
  matches(sel: string): boolean {
    // Parse every part before matching any, so a malformed selector throws
    // whichever node is asked, not only the ones an earlier part misses.
    const chains = splitTop(sel, ",").map((part) => parseChain(part.trim()));
    return chains.some((chain) => matchChain(this, chain));
  }
  closest(sel: string): StubEl | null {
    let node: StubEl | null = this;
    while (node && !node.matches(sel)) node = node.parentNode;
    return node;
  }
  querySelectorAll(sel: string): StubEl[] {
    return descendants(this, (n) => n.matches(sel));
  }
  querySelector(sel: string): StubEl | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  contains(other: unknown): boolean {
    return other === this || this.children.some((c) => c.contains(other));
  }
}

export interface StubDocument {
  body: StubEl;
  activeElement: StubEl | null;
  title: string;
  getElementById(id: string): StubEl | null;
  createElement(tag: string): StubEl;
  createTextNode(text: string): StubEl;
  querySelector(sel: string): StubEl | null;
  querySelectorAll(sel: string): StubEl[];
  contains(node: unknown): boolean;
  /** Listeners on the document itself, by event. */
  listeners: Record<string, Listener[]>;
  addEventListener(event: string, fn: Listener): void;
  removeEventListener(event: string, fn: Listener): void;
}

export interface StubDom {
  document: StubDocument;
  /** st-core's `h()`, on this document. */
  h: (tag: string, attrs?: Record<string, unknown> | null, ...kids: unknown[]) => StubEl;
  /**
   * Register a node for `getElementById` without attaching it to the body.
   * Such a node is outside the document, as a detached one would be:
   * `document.contains` is false for it, and its events stop short of the
   * document's listeners. Append to `document.body` instead when a test needs
   * either.
   */
  byId: Record<string, StubEl>;
}

/**
 * A document to load client modules against. `element` builds each element,
 * for a test that needs more than the stub gives (a layout model, say).
 */
export function createDom(
  opts: { element?: (tag: string, doc: StubDocument) => StubEl } = {},
): StubDom {
  const make = opts.element ?? ((tag: string, doc: StubDocument) => new StubEl(tag, doc));
  const byId: Record<string, StubEl> = {};
  const document: StubDocument = {
    body: undefined as unknown as StubEl,
    activeElement: null,
    title: "",
    getElementById: (id) =>
      byId[id] ?? descendants(document.body, (n) => n.attrs.id === id)[0] ?? null,
    createElement: (tag) => make(tag, document),
    createTextNode: (text) => {
      const node = make("#text", document);
      node.text = text;
      return node;
    },
    querySelector: (sel) => document.body.querySelector(sel),
    querySelectorAll: (sel) => document.body.querySelectorAll(sel),
    contains: (node) => document.body.contains(node),
    listeners: {},
    addEventListener: (event, fn) => {
      const bucket = document.listeners[event] ?? [];
      document.listeners[event] = bucket;
      if (!bucket.includes(fn)) bucket.push(fn);
    },
    removeEventListener: (event, fn) => {
      document.listeners[event] = (document.listeners[event] ?? []).filter((f) => f !== fn);
    },
  };
  document.body = make("body", document);

  /** Mirrors `h()` in st-core.js. */
  const h: StubDom["h"] = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs ?? {})) {
      if (k === "class") e.className = String(v);
      else if (k === "text") e.textContent = String(v);
      else if (k.startsWith("on") && typeof v === "function") {
        e.addEventListener(k.slice(2).toLowerCase(), v as Listener);
      } else if (typeof v === "boolean" && k in e) (e as unknown as Record<string, unknown>)[k] = v;
      else if (v != null) e.setAttribute(k, v);
    }
    for (const kid of kids) {
      if (kid == null) continue;
      e.appendChild(typeof kid === "string" ? document.createTextNode(kid) : (kid as StubEl));
    }
    return e;
  };
  return { document, h, byId };
}

/**
 * Run client scripts in order, each with `globals` as its free variables
 * (`window`, `document`, `setTimeout`, …), the way the page's script tags do.
 */
export function loadScripts(sources: string[], globals: Record<string, unknown>): void {
  const names = Object.keys(globals);
  const values = Object.values(globals);
  for (const source of sources) new Function(...names, source)(...values);
}

/** Every node under `root` (not `root` itself) that `pred` accepts, in document order. */
export function descendants(root: StubEl, pred: (n: StubEl) => boolean): StubEl[] {
  const out: StubEl[] = [];
  const walk = (node: StubEl) => {
    for (const kid of node.children) {
      if (pred(kid)) out.push(kid);
      walk(kid);
    }
  };
  walk(root);
  return out;
}

/** `root` and every node under it that `pred` accepts. */
export function collect(root: StubEl, pred: (n: StubEl) => boolean): StubEl[] {
  return [...(pred(root) ? [root] : []), ...descendants(root, pred)];
}

export function hasClass(node: StubEl, cls: string): boolean {
  return node.classList.contains(cls);
}

/** Every node under `root` with class `cls`. */
export function byClass(root: StubEl, cls: string): StubEl[] {
  return descendants(root, (n) => hasClass(n, cls));
}

/**
 * The words a node shows, one space between each node's own text: what a
 * reader sees, with no care for how the markup split it.
 */
export function flatText(node: StubEl): string {
  const parts: string[] = [];
  const walk = (n: StubEl) => {
    parts.push(n.text);
    for (const c of n.children) walk(c);
  };
  walk(node);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** What a node reads as on screen: its `textContent`, whitespace collapsed. */
export function shownText(node: StubEl): string {
  return node.textContent.replace(/\s+/g, " ").trim();
}

/** Click `node` (the click bubbles), failing loudly when there is nothing to click. */
export function click(node: StubEl | null | undefined): void {
  if (!node) throw new Error("stub-dom: nothing to click");
  node.click();
}

/** The `<button>`s under `root` that read exactly `label`. */
export function buttonsNamed(root: StubEl, label: string): StubEl[] {
  return descendants(root, (n) => n.tag === "button" && shownText(n) === label);
}

// ---- selectors ----------------------------------------------------------

interface Compound {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: { name: string; value?: string }[];
  not: Compound[];
}
/** Compounds right to left, each with the combinator that joins it to the next one left. */
type Chain = { compound: Compound; combinator: " " | ">" }[];

/** Split on `sep` outside parentheses and brackets. */
function splitTop(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseChain(sel: string): Chain {
  const tokens = splitTop(sel.replace(/\s*>\s*/g, " > "), " ").filter(Boolean);
  const chain: Chain = [];
  const unsupported = () => new Error(`stub-dom: unsupported selector "${sel}"`);
  let combinator: " " | ">" = " ";
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i]!;
    if (token === ">") {
      // A `>` needs a compound on each side: not first, last, or doubled.
      if (chain.length === 0 || combinator === ">") throw unsupported();
      combinator = ">";
      continue;
    }
    if (chain.length > 0) chain[chain.length - 1]!.combinator = combinator;
    chain.push({ compound: parseCompound(token, sel), combinator: " " });
    combinator = " ";
  }
  if (chain.length === 0 || combinator === ">") throw unsupported();
  return chain;
}

function parseCompound(text: string, sel: string): Compound {
  const compound: Compound = { classes: [], attrs: [], not: [] };
  const re =
    /^([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'))?\]|:not\(([^()]*)\)/y;
  let at = 0;
  while (at < text.length) {
    re.lastIndex = at;
    const m = re.exec(text);
    if (!m || (m[1] && at > 0)) throw new Error(`stub-dom: unsupported selector "${sel}"`);
    if (m[1]) compound.tag = m[1];
    else if (m[2]) compound.id = m[2];
    else if (m[3]) compound.classes.push(m[3]);
    else if (m[4]) compound.attrs.push({ name: m[4], value: m[5] ?? m[6] });
    else if (m[7] !== undefined) compound.not.push(parseCompound(m[7].trim(), sel));
    at = re.lastIndex;
  }
  return compound;
}

function matchCompound(el: StubEl, c: Compound): boolean {
  if (c.tag && c.tag !== el.tag) return false;
  if (c.id && el.getAttribute("id") !== c.id) return false;
  if (!c.classes.every((cls) => el.classList.contains(cls))) return false;
  for (const { name, value } of c.attrs) {
    const actual = el.getAttribute(name);
    if (actual === null || (value !== undefined && actual !== value)) return false;
  }
  return !c.not.some((n) => matchCompound(el, n));
}

function matchChain(el: StubEl, chain: Chain, from = 0): boolean {
  const step = chain[from];
  if (!step) return true;
  if (!matchCompound(el, step.compound)) return false;
  if (from === chain.length - 1) return true;
  if (step.combinator === ">")
    return el.parentNode ? matchChain(el.parentNode, chain, from + 1) : false;
  for (let up = el.parentNode; up; up = up.parentNode) {
    if (matchChain(up, chain, from + 1)) return true;
  }
  return false;
}
