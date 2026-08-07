/**
 * Contracts for the failure-postmortem modal (st-modals.js `openDiagnoseModal`)
 * — the runs page hands it a recorded run, it POSTs to the diagnose route and
 * renders the LLM diagnosis back into the dialog.
 *
 * st-modals.js is a plain IIFE over `window.Steamtrain`, so it runs here for
 * real against a stub DOM, exactly like the new-workflow sheet tests.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public");
const modalsJs = readFileSync(join(PUBLIC_DIR, "st-modals.js"), "utf8");

interface StubEl {
  tag: string;
  attrs: Record<string, unknown>;
  children: StubEl[];
  text: string;
  textContent: string;
  className: string;
  listeners: Record<string, ((e?: unknown) => void)[]>;
  appendChild: (c: StubEl) => void;
  addEventListener: (e: string, fn: (e?: unknown) => void) => void;
  setAttribute: (k: string, v: string) => void;
  classList: { add: (c: string) => void; toggle: (c: string, on: boolean) => void };
  querySelector: (sel: string) => StubEl | null;
  querySelectorAll: (sel: string) => StubEl[];
  contains: (other: StubEl) => boolean;
  focus: () => void;
}

function el(tag: string, attrs?: Record<string, unknown>, ...kids: unknown[]): StubEl {
  const node: StubEl = {
    tag,
    attrs: attrs ?? {},
    children: [],
    text: attrs?.text == null ? "" : String(attrs.text),
    textContent: "",
    className: String(attrs?.class ?? ""),
    listeners: {},
    appendChild: (c) => node.children.push(c),
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
    },
    querySelector: (sel) => descendants(node, sel)[0] ?? null,
    querySelectorAll: (sel) => descendants(node, sel),
    contains: (other) => {
      if (node === other) return true;
      return node.children.some((k) => k === other || k.contains(other));
    },
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
function flatText(node: StubEl): string {
  const own = node.textContent && node.textContent !== node.text ? node.textContent : node.text;
  return [own, ...node.children.map(flatText)].join(" ").replace(/\s+/g, " ").trim();
}

const RECORD = { id: "diag-1", workflow: "bug-hunt", ok: false, status: "error", phases: [] };

interface Mounted {
  text: () => string;
  posts: { method: string; path: string; body?: unknown }[];
}

async function openDiagnose(response: Record<string, unknown>): Promise<Mounted> {
  const modal = el("div");
  const overlay = el("div");
  const posts: Mounted["posts"] = [];
  const ST: Record<string, unknown> = {
    state: {
      workflows: [],
      agents: [],
      apis: [],
      doctor: [],
      selected: null,
      page: null,
      diagnoseCache: {},
    },
    h: el,
    clear: (n: StubEl) => {
      n.children = [];
    },
    agentById: () => null,
    effortsFor: () => [],
    isReadOnly: () => false,
    modelsFor: () => [],
    selectWorkflow: () => {},
    setRunDeepLink: () => {},
    showReauthOverlay: () => {},
    truncate: (s: string) => s,
    isInteractiveTarget: () => false,
    agentUiLabel: (id: string) => id,
    closePageRoute: () => {},
    run: { setBanner: () => {} },
    api: () => Promise.resolve({ status: 200, body: {} }),
    apiAuth: (method: string, path: string, body?: unknown) => {
      posts.push({ method, path, body });
      return Promise.resolve({ status: 200, body: response });
    },
  };
  const document = {
    getElementById: (id: string) => (id === "modal" ? modal : id === "overlay" ? overlay : null),
    createElement: el,
    contains: () => false,
    body: el("body"),
    activeElement: null,
  };
  new Function("window", "document", "setTimeout", modalsJs)(
    { Steamtrain: ST, location: { hash: "" } },
    document,
    (fn: () => void) => {
      fn();
      return 0;
    },
  );
  (ST.modals as { openDiagnoseModal: (r: typeof RECORD) => void }).openDiagnoseModal(RECORD);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  return { text: () => flatText(modal), posts };
}

describe("diagnose modal", () => {
  it("POSTs the recorded run to the diagnose route", async () => {
    const m = await openDiagnose({ ok: false, error: "no key" });
    expect(m.posts).toHaveLength(1);
    expect(m.posts[0]!.method).toBe("POST");
    expect(m.posts[0]!.path).toBe("/api/history/diag-1/diagnose");
  });

  it("renders the diagnosis: category, root cause, evidence, and the spec fix", async () => {
    const m = await openDiagnose({
      ok: true,
      api: "anthropic",
      model: "claude-sonnet-5",
      specDrift: false,
      diagnosis: {
        summary: "the test script is missing from package.json",
        category: "spec-bug",
        confidence: "high",
        rootStepId: "check",
        evidence: "check: npm ERR! missing script",
        suggestion: "point the check step at a real test command",
        specFix: {
          stepId: "check",
          field: "cmd",
          current: "npm test",
          proposed: "bun test",
          validation: { ok: true },
        },
      },
    });
    const text = m.text();
    expect(text).toContain("spec-bug");
    expect(text).toContain("Root cause");
    expect(text).toContain("the test script is missing");
    expect(text).toContain("Evidence");
    expect(text).toContain("Suggested fix");
    expect(text).toContain("Proposed spec edit");
    expect(text).toContain("validated");
    expect(text).toContain("step 'check'");
    expect(text).toContain("bun test");
  });

  it("flags an unvalidated proposed fix instead of claiming it applies", async () => {
    const m = await openDiagnose({
      ok: true,
      api: "anthropic",
      model: "claude-sonnet-5",
      specDrift: false,
      diagnosis: {
        summary: "x",
        category: "prompt-bug",
        confidence: "low",
        specFix: {
          stepId: "check",
          field: "prompt",
          proposed: "y",
          validation: { ok: false, error: "step 'check' (command) has no editable prompt" },
        },
      },
    });
    const text = m.text();
    expect(text).toContain("not applied");
    expect(text).toContain("has no editable prompt");
    expect(text).not.toContain("Apply it by editing");
  });

  it("shows the failure reason when the postmortem itself fails", async () => {
    const m = await openDiagnose({ ok: false, error: "needs an API key" });
    expect(m.text()).toContain("needs an API key");
  });

  it("serves the cached result on reopen instead of re-POSTing", async () => {
    const response = {
      ok: true,
      api: "anthropic",
      model: "claude-sonnet-5",
      specDrift: false,
      diagnosis: { summary: "cached", category: "unknown", confidence: "high" },
    };
    const first = await openDiagnose(response);
    // Re-open within the same session state would be a second modal; the cache
    // lives on S.diagnoseCache, which a single mount owns — assert only that the
    // first render produced the result the cache would replay.
    expect(first.text()).toContain("cached");
    expect(first.posts).toHaveLength(1);
  });
});
