/**
 * Contracts for the new-workflow sheet (st-modals.js `openCreate`), which
 * replaced the describe-only create modal with four starting points.
 *
 * Three of them write a spec directly (blank / duplicate / template) and one
 * still streams a draft from an agent, so the thing worth pinning down is what
 * lands on disk: the PUT body for each source, and the name it is written
 * under. st-modals.js is a plain IIFE over `window.Steamtrain`, so it runs here
 * for real against a stub DOM.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public");
const modalsJs = readFileSync(join(PUBLIC_DIR, "st-modals.js"), "utf8");
const settingsCss = readFileSync(join(PUBLIC_DIR, "settings.css"), "utf8");

interface StubEl {
  tag: string;
  attrs: Record<string, unknown>;
  children: StubEl[];
  text: string;
  textContent: string;
  value: string;
  className: string;
  disabled: boolean;
  style: Record<string, string>;
  listeners: Record<string, ((e?: unknown) => void)[]>;
  appendChild: (c: StubEl) => void;
  addEventListener: (e: string, fn: (e?: unknown) => void) => void;
  removeChild: (c: StubEl) => void;
  setAttribute: (k: string, v: string) => void;
  classList: {
    add: (c: string) => void;
    toggle: (c: string, on: boolean) => void;
    contains: (c: string) => boolean;
  };
  querySelector: (sel: string) => StubEl | null;
  querySelectorAll: (sel: string) => StubEl[];
  focus: () => void;
}

function el(tag: string, attrs?: Record<string, unknown>, ...kids: unknown[]): StubEl {
  const node: StubEl = {
    tag,
    attrs: attrs ?? {},
    children: [],
    text: attrs?.text == null ? "" : String(attrs.text),
    textContent: attrs?.text == null ? "" : String(attrs.text),
    value: attrs?.value == null ? "" : String(attrs.value),
    className: String(attrs?.class ?? ""),
    disabled: false,
    style: {},
    listeners: {},
    appendChild: (c) => node.children.push(c),
    removeChild: (c) => {
      node.children = node.children.filter((k) => k !== c);
    },
    addEventListener: (event, fn) => {
      const bucket = node.listeners[event] ?? [];
      node.listeners[event] = bucket;
      bucket.push(fn);
    },
    setAttribute: (k, v) => {
      node.attrs[k] = v;
    },
    classList: {
      add: (c) => {
        node.className = `${node.className} ${c}`.trim();
      },
      toggle: (c, on) => {
        const parts = new Set(node.className.split(" ").filter(Boolean));
        if (on) parts.add(c);
        else parts.delete(c);
        node.className = [...parts].join(" ");
      },
      contains: (c) => node.className.split(" ").includes(c),
    },
    querySelector: (sel) => descendants(node, sel)[0] ?? null,
    querySelectorAll: (sel) => descendants(node, sel),
    focus: () => {},
  };
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

/** Enough of a selector engine for the tag and `.class` forms in use. */
function descendants(root: StubEl, sel: string, out: StubEl[] = []): StubEl[] {
  const match = (n: StubEl) =>
    sel.startsWith(".") ? n.className.split(" ").includes(sel.slice(1)) : n.tag === sel;
  for (const kid of root.children) {
    if (match(kid)) out.push(kid);
    descendants(kid, sel, out);
  }
  return out;
}
function collect(node: StubEl, pred: (n: StubEl) => boolean, out: StubEl[] = []): StubEl[] {
  if (pred(node)) out.push(node);
  for (const kid of node.children) collect(kid, pred, out);
  return out;
}
/**
 * Text of a node and everything under it. `text` is what `h()` set from a
 * `text:` attribute; `textContent` is what a later assignment wrote (mbanner
 * and the file line both do that), so both have to be read.
 */
function flatText(node: StubEl): string {
  const own = node.textContent && node.textContent !== node.text ? node.textContent : node.text;
  return [own, ...node.children.map(flatText)].join(" ").replace(/\s+/g, " ").trim();
}
function click(node: StubEl): void {
  for (const fn of node.listeners.click ?? []) fn({ target: node });
}

const BUNDLED_SPEC = {
  name: "bug-hunt",
  description: "find bugs",
  phases: [
    {
      id: "scan",
      title: "Scan",
      steps: [{ id: "s1", kind: "worker", agent: "claude", model: "sonnet", prompt: "look" }],
    },
  ],
};

interface Sheet {
  root: StubEl;
  cards: () => StubEl[];
  card: (title: string) => StubEl;
  nameInput: () => StubEl;
  description: () => StubEl;
  createButton: () => StubEl;
  draft: () => StubEl;
  fileLine: () => string;
  create: () => Promise<void>;
  banner: () => string;
  puts: { path: string; body: Record<string, unknown> }[];
}

async function openSheet(opts: { workflows?: Record<string, unknown>[] } = {}): Promise<Sheet> {
  const workflows = opts.workflows ?? [
    { name: "bug-hunt", source: "bundled", phaseCount: 1, stepCount: 1 },
    { name: "mine", source: "user", phaseCount: 2, stepCount: 3 },
  ];
  const puts: { path: string; body: Record<string, unknown> }[] = [];
  const modal = el("div");
  const overlay = el("div");
  const ST: Record<string, unknown> = {
    state: {
      workflows,
      agents: [
        {
          id: "claude",
          defaultModel: "sonnet",
          enabled: true,
          healthy: true,
          models: [{ id: "sonnet" }],
        },
      ],
      apis: [],
      doctor: [],
      selected: null,
      page: null,
    },
    h: el,
    clear: (n: StubEl) => {
      n.children = [];
    },
    agentById: (id: string) =>
      (ST.state as { agents: Record<string, unknown>[] }).agents.find((a) => a.id === id),
    effortsFor: () => [],
    isReadOnly: () => false,
    modelsFor: () => [{ id: "sonnet", name: "sonnet" }],
    selectWorkflow: () => {},
    setRunDeepLink: () => {},
    showReauthOverlay: () => {},
    truncate: (s: string) => s,
    isInteractiveTarget: (n: StubEl) =>
      ["input", "button", "select", "textarea", "a"].includes(n.tag),
    agentUiLabel: (id: string) => id,
    closePageRoute: () => {},
    run: { setBanner: () => {} },
    api: () => Promise.resolve({ status: 200, body: { workflows } }),
    apiAuth: (method: string, path: string, body?: Record<string, unknown>) => {
      if (method === "PUT") {
        puts.push({ path, body: body ?? {} });
        return Promise.resolve({ status: 200, body: { ok: true, name: path.split("/").pop() } });
      }
      if (method === "GET" && path.startsWith("/api/workflows/")) {
        return Promise.resolve({ status: 200, body: { spec: BUNDLED_SPEC } });
      }
      return Promise.resolve({ status: 200, body: { workflows } });
    },
  };
  const document = {
    getElementById: (id: string) => (id === "modal" ? modal : id === "overlay" ? overlay : null),
    createElement: el,
    contains: () => false,
    body: el("body"),
  };
  new Function("window", "document", "setTimeout", modalsJs)(
    { Steamtrain: ST, location: { hash: "" } },
    document,
    (fn: () => void) => {
      fn();
      return 0;
    },
  );
  (ST.modals as { openCreate: () => void }).openCreate();
  const root = modal;
  const cards = () => collect(root, (n) => n.className.split(" ").includes("create-card"));
  return {
    root,
    cards,
    card: (title) => {
      const found = cards().find((c) => flatText(c).startsWith(title));
      if (!found) throw new Error(`no "${title}" card`);
      return found;
    },
    nameInput: () => descendants(root, ".txt")[0] as StubEl,
    description: () => descendants(root, "textarea")[0] as StubEl,
    createButton: () =>
      collect(
        root,
        (n) => n.tag === "button" && n.className.includes("create-submit"),
      )[0] as StubEl,
    draft: () => collect(root, (n) => n.className.split(" ").includes("draft"))[0] as StubEl,
    fileLine: () => flatText(collect(root, (n) => n.className === "create-file")[0] ?? el("div")),
    create: async () => {
      const btn = collect(root, (n) => n.text === "Create" && n.tag === "button")[0];
      if (!btn) throw new Error("no Create button");
      click(btn);
      for (let i = 0; i < 8; i++) await Promise.resolve();
    },
    banner: () => flatText(collect(root, (n) => n.className.startsWith("mbanner"))[0] ?? el("div")),
    puts,
  };
}

describe("new-workflow sheet", () => {
  it("offers every starting point that has something behind it", async () => {
    const sheet = await openSheet();
    expect(sheet.cards().map((c) => flatText(c).split(" ")[0])).toEqual([
      "Blank",
      "Duplicate",
      "From",
      "Describe",
    ]);
  });

  // A card whose picker would be empty is worse than no card: it looks
  // available and cannot be used.
  it("leaves out duplicate and template when there is nothing to copy", async () => {
    const sheet = await openSheet({ workflows: [] });
    expect(sheet.cards().map((c) => flatText(c).split(" ")[0])).toEqual(["Blank", "Describe"]);
  });

  it("opens on Blank", async () => {
    const sheet = await openSheet();
    expect(sheet.card("Blank").className).toContain("selected");
  });

  it("writes a minimal runnable spec for Blank", async () => {
    const sheet = await openSheet();
    sheet.nameInput().value = "flaky-tests";
    await sheet.create();
    expect(sheet.puts).toHaveLength(1);
    expect(sheet.puts[0]?.path).toBe("/api/workflows/flaky-tests");
    const spec = sheet.puts[0]?.body.spec as {
      name: string;
      phases: { steps: Record<string, unknown>[] }[];
    };
    expect(spec.name).toBe("flaky-tests");
    expect(spec.phases).toHaveLength(1);
    expect(spec.phases[0]?.steps).toHaveLength(1);
    // A worker step without a prompt does not validate, so the blank one must
    // ship a placeholder rather than an empty string.
    expect(spec.phases[0]?.steps[0]).toMatchObject({
      kind: "worker",
      agent: "claude",
      model: "sonnet",
    });
    expect(String(spec.phases[0]?.steps[0]?.prompt ?? "")).not.toBe("");
    expect(sheet.puts[0]?.body.scope).toBe("user");
  });

  it("copies the source spec under the new name for Duplicate", async () => {
    const sheet = await openSheet();
    click(sheet.card("Duplicate"));
    // The name is derived from the source until the reader types one.
    expect(sheet.nameInput().value).toBe("bug-hunt-copy");
    await sheet.create();
    const spec = sheet.puts[0]?.body.spec as { name: string; phases: unknown[] };
    expect(sheet.puts[0]?.path).toBe("/api/workflows/bug-hunt-copy");
    expect(spec.name).toBe("bug-hunt-copy");
    expect(spec.phases).toEqual(BUNDLED_SPEC.phases);
  });

  it("kebab-cases whatever name is typed", async () => {
    const sheet = await openSheet();
    sheet.nameInput().value = "  Flaky Tests!! ";
    await sheet.create();
    expect(sheet.puts[0]?.path).toBe("/api/workflows/flaky-tests");
  });

  it("refuses a name that is already taken, without writing anything", async () => {
    const sheet = await openSheet();
    sheet.nameInput().value = "mine";
    await sheet.create();
    expect(sheet.puts).toHaveLength(0);
    expect(sheet.banner()).toContain("already exists");
  });

  it("refuses an empty name, without writing anything", async () => {
    const sheet = await openSheet();
    sheet.nameInput().value = "";
    await sheet.create();
    expect(sheet.puts).toHaveLength(0);
    expect(sheet.banner()).toContain("name");
  });

  it("shows which file the workflow will land in", async () => {
    const sheet = await openSheet();
    expect(sheet.fileLine()).toContain("~/.steamtrain/workflows.json");
  });

  it("shows a progress state while an LLM draft is pending", async () => {
    const pending = new Promise<never>(() => {});
    vi.stubGlobal("fetch", () => pending);
    try {
      const sheet = await openSheet();
      click(sheet.card("Describe"));
      sheet.description().value = "review the checkout service for bugs";
      click(sheet.createButton());

      expect(sheet.createButton().disabled).toBe(true);
      expect(sheet.createButton().textContent).toContain("Drafting workflow");
      expect(sheet.createButton().className).toContain("is-loading");
      expect(sheet.description().value).toBe("review the checkout service for bugs");

      const progress = sheet.draft();
      expect(progress.className).toContain("show");
      expect(flatText(progress)).toContain("Drafting your workflow");
      expect(flatText(progress)).toContain("Turning your description into a runnable pipeline");
      expect(collect(progress, (n) => n.className.includes("draft-spinner"))).toHaveLength(1);
      const status = collect(progress, (n) => n.className.includes("draft-status"))[0] as StubEl;
      expect(status.attrs.role).toBe("status");
      expect(status.attrs["aria-busy"]).toBe("true");
      expect(settingsCss).toContain(".draft-spinner");
      expect(settingsCss).toContain(".btn.create-submit.is-loading");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
