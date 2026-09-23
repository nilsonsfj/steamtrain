/**
 * Form state in the modals and the launch form lives in closures and in the
 * DOM itself, never as custom properties on DOM nodes (#165): a property on a
 * node that a rebuild replaces is silently lost. These run st-modals.js and
 * st-run.js for real against a stub DOM that is just rich enough for them.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public");
const modalsJs = readFileSync(join(PUBLIC_DIR, "st-modals.js"), "utf8");
const runJs = readFileSync(join(PUBLIC_DIR, "st-run.js"), "utf8");

type Listener = (e?: unknown) => void;

class StubEl {
  attrs: Record<string, string> = {};
  children: StubEl[] = [];
  parentNode: StubEl | null = null;
  className = "";
  value = "";
  text = "";
  hidden = false;
  style: Record<string, string> = {};
  listeners: Record<string, Listener[]> = {};
  constructor(readonly tag: string) {}

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
  get options(): StubEl[] {
    return this.querySelectorAll("option");
  }
  appendChild(c: StubEl): StubEl {
    c.parentNode = this;
    this.children.push(c);
    // A select takes its first option's value, as a browser's does.
    if (this.tag === "select" && !this.value && c.tag === "option")
      this.value = c.attrs.value ?? "";
    return c;
  }
  removeChild(c: StubEl): void {
    this.children = this.children.filter((k) => k !== c);
    c.parentNode = null;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = String(v);
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
    for (const fn of this.listeners[event] ?? []) fn({ preventDefault() {}, stopPropagation() {} });
  }
  classList = {
    add: (c: string) => this.setClass(c, true),
    remove: (c: string) => this.setClass(c, false),
    toggle: (c: string, on: boolean) => this.setClass(c, on),
    contains: (c: string) => this.className.split(" ").includes(c),
  };
  private setClass(c: string, on: boolean): void {
    const parts = new Set(this.className.split(" ").filter(Boolean));
    if (on) parts.add(c);
    else parts.delete(c);
    this.className = [...parts].join(" ");
  }
  matches(sel: string): boolean {
    if (sel.startsWith(".")) return this.classList.contains(sel.slice(1));
    if (sel.startsWith("[")) return sel.slice(1, -1) in this.attrs;
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
  focus(): void {}
}

function h(tag: string, attrs?: Record<string, unknown> | null, ...kids: unknown[]): StubEl {
  const node = new StubEl(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (k === "class") node.className = String(v);
    else if (k === "text") node.textContent = String(v);
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v as Listener);
    } else if (k === "value") node.attrs.value = node.value = String(v);
    else if (v != null) node.setAttribute(k, String(v));
  }
  for (const kid of kids) {
    if (kid == null) continue;
    if (typeof kid === "string") node.text += kid;
    else node.appendChild(kid as StubEl);
  }
  return node;
}

/** Load st-modals.js (and st-run.js) over a stub `window.Steamtrain`. */
function load(state: Record<string, unknown> = {}) {
  const byId: Record<string, StubEl> = {
    modal: h("div"),
    overlay: h("div"),
    paramsPanel: h("div"),
    paramsForm: h("div"),
    banner: h("div"),
  };
  const posts: { path: string; body: unknown }[] = [];
  const ST: Record<string, unknown> = {
    state: { agents: [], doctor: [], ...state },
    h,
    clear: (n: StubEl) => {
      n.children = [];
    },
    agentById: () => null,
    agentUiLabel: (id: string) => id,
    effortsFor: () => [],
    modelsFor: () => [],
    isReadOnly: () => false,
    run: { setBanner: () => {} },
    apiAuth: (_method: string, path: string, body?: unknown) => {
      posts.push({ path, body });
      return new Promise(() => {});
    },
  };
  const document = {
    getElementById: (id: string) => byId[id] ?? null,
    createElement: (tag: string) => new StubEl(tag),
    contains: () => false,
    activeElement: null,
  };
  const window = { Steamtrain: ST, location: { hash: "" } };
  const immediately = (fn: () => void) => {
    fn();
    return 0;
  };
  new Function("window", "document", "setTimeout", modalsJs)(window, document, immediately);
  new Function("window", "document", "setTimeout", runJs)(window, document, immediately);
  return {
    modals: ST.modals as {
      openRetryRetargetModal: (record: unknown) => void;
      addBlurValidation: (el: StubEl, check: () => string | null) => void;
      fieldErrorFor: (el: StubEl) => StubEl | null;
    },
    run: ST.run as {
      renderParamsForm: (spec: unknown) => void;
      validateParamsForm: () => boolean;
    },
    byId,
    posts,
  };
}

function button(root: StubEl, label: string): StubEl {
  const found = root.querySelectorAll("button").find((b) => b.textContent === label);
  if (!found) throw new Error(`no button '${label}'`);
  return found;
}

describe("the retry-with-agent sheet", () => {
  it("sends the model picked after switching agents", () => {
    const { modals, byId, posts } = load({
      agents: [
        { id: "claude", models: [{ id: "claude-sonnet-5" }] },
        { id: "codex", models: [{ id: "gpt-5.6" }, { id: "gpt-6" }] },
      ],
    });
    const record = {
      id: "r1",
      workflow: "w",
      phases: [{ steps: [{ stepId: "a", status: "error" }] }],
    };
    modals.openRetryRetargetModal(record);
    const modal = byId.modal!;
    const [agentSel] = modal.querySelectorAll("select");
    agentSel!.value = "codex";
    agentSel!.fire("change");
    // The model list was rebuilt for codex: pick from the new select.
    const modelSel = modal.querySelectorAll("select")[1]!;
    expect(modelSel.options.map((o) => o.attrs.value)).toEqual(["", "gpt-5.6", "gpt-6"]);
    modelSel.value = "gpt-6";
    button(modal, "Retry with agent").fire("click");
    expect(posts).toEqual([
      { path: "/api/history/r1/retry", body: { retargetAgent: "codex", retargetModel: "gpt-6" } },
    ]);
  });
});

describe("blur validation", () => {
  it("writes to the error line of the field the control is in now", () => {
    const { modals } = load();
    const control = h("input");
    const first = h("div", { class: "field-error" });
    const wrapper = h("div", { class: "field" }, control, first);
    modals.addBlurValidation(control, () => (control.value ? null : "name is required"));
    control.fire("blur");
    expect(first.textContent).toBe("name is required");
    expect(control.classList.contains("invalid")).toBe(true);

    // A rebuild swaps the error line out; nothing still points at the old one.
    wrapper.removeChild(first);
    const second = h("div", { class: "field-error" });
    wrapper.appendChild(second);
    control.fire("blur");
    expect(second.textContent).toBe("name is required");
    control.value = "x";
    control.fire("input");
    expect(second.textContent).toBe("");
    expect(control.classList.contains("invalid")).toBe(false);
  });

  it("finds no error line for a control outside a field", () => {
    const { modals } = load();
    expect(modals.fieldErrorFor(h("input"))).toBeNull();
  });
});

describe("the launch form's variables", () => {
  const spec = {
    inputs: {
      tier: { type: "string", choices: ["low", "high"], required: true },
      model: { type: "model", default: "claude-sonnet-5" },
    },
  };

  it("rejects a value outside a variable's choices, on its own error line", () => {
    const { run, byId } = load();
    run.renderParamsForm(spec);
    const form = byId.paramsForm!;
    const tier = form
      .querySelectorAll("[data-param-key]")
      .find((c) => c.attrs["data-param-key"] === "tier")!;
    tier.value = "medium";
    expect(run.validateParamsForm()).toBe(false);
    expect(tier.closest(".field")!.querySelector(".field-error")!.textContent).toBe(
      "tier must be one of: low, high",
    );
    tier.value = "high";
    expect(run.validateParamsForm()).toBe(true);
    expect(tier.closest(".field")!.querySelector(".field-error")!.textContent).toBe("");
  });

  it("puts a model variable's suggestions right after its input", () => {
    const { run, byId } = load();
    run.renderParamsForm(spec);
    const model = byId.paramsForm!.querySelectorAll("[data-param-key]")[1]!;
    const wrapper = model.closest(".field")!;
    expect(wrapper.children[wrapper.children.indexOf(model) + 1]!.tag).toBe("datalist");
  });
});
