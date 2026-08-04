/**
 * Contracts for the two surfaces that report runner readiness in the web UI:
 * the topbar health chips (st-shell.js) and the Runners settings table
 * (st-settings.js + settings.css).
 *
 * Both are plain IIFEs over `window.Steamtrain`, so both run here for real: a
 * stub namespace with an `h()` that builds inert nodes is enough to paint them,
 * read back what they rendered, and fire the click handlers they attached. Only
 * the paint-time invariants that live in the stylesheet (hit-target size, how
 * absent rows recede) are asserted against the CSS text.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public");
const shellJs = readFileSync(join(PUBLIC_DIR, "st-shell.js"), "utf8");
const settingsJs = readFileSync(join(PUBLIC_DIR, "st-settings.js"), "utf8");
const settingsCss = readFileSync(join(PUBLIC_DIR, "settings.css"), "utf8");

interface StubEl {
  tag: string;
  attrs: Record<string, unknown>;
  children: StubEl[];
  text: string;
  listeners: Record<string, (() => void)[]>;
  className: string;
  textContent: string;
  appendChild: (child: StubEl) => void;
  addEventListener: (event: string, fn: () => void) => void;
  classList: { add: (cls: string) => void };
}
interface Chip {
  cls: string;
  text: string;
  title: string;
}

/**
 * `loud` states are the user's to fix now; `calm` states are the resting state
 * of a tool they simply don't use. Mirrors AGENT_HEALTH_META / API_HEALTH_META
 * in st-core.js — the only piece of st-core the chips need.
 */
const LOUD = new Set(["not_authenticated", "unknown_error", "unreachable"]);

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
    appendChild: (child) => node.children.push(child),
    addEventListener: (event, fn) => {
      const bucket = node.listeners[event] ?? [];
      node.listeners[event] = bucket;
      bucket.push(fn);
    },
    classList: { add: () => {} },
  };
  for (const kid of kids) {
    if (kid == null) continue;
    if (typeof kid === "string") node.text += kid;
    else node.children.push(kid as StubEl);
  }
  return node;
}

/** Loads st-shell.js against a stub DOM and returns the chips renderHealth builds. */
function renderChips(
  doctor: { agent: string; status: string }[],
  apis: { api: string; status: string }[],
  spec: unknown = { phases: [] },
): Chip[] {
  const health = el("div");
  const ST: Record<string, unknown> = {
    state: { spec },
    h: el,
    clear: (node: StubEl) => {
      node.children = [];
    },
    agentHealthMeta: (status: string) => ({ loud: LOUD.has(status) }),
    apiHealthMeta: (status: string) => ({ loud: LOUD.has(status) }),
    isCredentialFreeSpec: () => false,
  };
  const document = { getElementById: (id: string) => (id === "health" ? health : null) };
  new Function("window", "document", shellJs)({ Steamtrain: ST }, document);
  (ST.shell as { renderHealth: (d: unknown, a: unknown, e: unknown) => void }).renderHealth(
    doctor,
    apis,
    null,
  );
  return health.children.map((chip) => ({
    cls: String(chip.attrs.class),
    text: chip.text,
    title: String(chip.attrs.title),
  }));
}

describe("topbar health chips", () => {
  it("names what it counted instead of showing a bare number", () => {
    const chips = renderChips(
      [
        { agent: "claude", status: "ok" },
        { agent: "codex", status: "ok" },
      ],
      [],
    );
    expect(chips).toEqual([
      { cls: "chip ready", text: "ready · 2 agents", title: "2 agents ready to run" },
    ]);
  });

  it("keeps agents and APIs apart, and singular labels singular", () => {
    const chips = renderChips(
      [{ agent: "claude", status: "ok" }],
      [{ api: "anthropic", status: "ok" }],
    );
    expect(chips[0]?.text).toBe("ready · 1 agent + 1 API");
  });

  it("never renders an absent chip — an uninstalled CLI is not news", () => {
    const chips = renderChips(
      [
        { agent: "claude", status: "ok" },
        { agent: "codex", status: "binary_missing" },
        { agent: "amp", status: "binary_missing" },
      ],
      [{ api: "openai", status: "key_missing" }],
    );
    expect(chips.map((c) => c.cls)).toEqual(["chip ready"]);
    expect(chips[0]?.text).toBe("ready · 1 agent");
  });

  it("still counts the states the user can fix, and agrees with itself on number", () => {
    const one = renderChips([{ agent: "codex", status: "not_authenticated" }], []);
    expect(one).toEqual([
      {
        cls: "chip auth",
        text: "needs auth · 1 agent",
        title: "1 agent needs sign-in or a valid key",
      },
    ]);
    const two = renderChips(
      [{ agent: "codex", status: "not_authenticated" }],
      [{ api: "openai", status: "unreachable" }],
    );
    expect(two[0]?.text).toBe("needs auth · 1 agent + 1 API");
    expect(two[0]?.title).toBe("1 agent + 1 API need sign-in or a valid key");
  });

  it("says so once when every probed runner is absent, rather than showing nothing", () => {
    const chips = renderChips([{ agent: "claude", status: "binary_missing" }], []);
    expect(chips).toHaveLength(1);
    expect(chips[0]?.text).toBe("no runner ready");
  });

  it("renders no chip at all before the doctor has reported", () => {
    expect(renderChips([], [])).toEqual([]);
  });
});

interface Row {
  cls: string;
  text: string;
  actions: string[];
  click: (label: string) => void;
}
interface Mounted {
  rows: () => Row[];
  save: () => Promise<void>;
  /** Flattened text of the state strip above the table. */
  tally: () => string;
  /** Whether the Runners nav item carries the "needs attention" pip. */
  navFlagged: () => boolean;
  /** Text of the runners settings banner (empty when nothing is shown). */
  banner: () => string;
  puts: Record<string, unknown>[];
  /** Drag the concurrency slider to `value`. */
  setConcurrency: (value: number) => void;
  /** Attributes of the concurrency slider input. */
  slider: () => Record<string, unknown>;
  /** Whether Save is currently offered (enabled). */
  saveEnabled: () => boolean;
  /** Labels of the health-cadence segmented control, selected one marked "*". */
  cadence: () => string[];
  /** Click a health-cadence option by label. */
  pickCadence: (label: string) => void;
  /** Labels of the buttons in the section header. */
  headActions: () => string[];
  /** Flattened text of the settings nav footer. */
  navFoot: () => string;
  /** Flattened text of the section footer band. */
  foot: () => string;
}

/** Every descendant matching `pred`, in paint order. */
function collect(node: StubEl, pred: (n: StubEl) => boolean, out: StubEl[] = []): StubEl[] {
  if (pred(node)) out.push(node);
  for (const kid of node.children) collect(kid, pred, out);
  return out;
}
function flatText(node: StubEl): string {
  return [node.text, ...node.children.map(flatText)].join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Paints the real Runners section against a stub DOM. `agents`/`apis` are the
 * configured entries GET /api/config would return; PUT bodies are recorded so a
 * test can assert what Save actually writes.
 */
async function mountSettings(opts: {
  doctor?: Record<string, unknown>[];
  apiDoctor?: Record<string, unknown>[];
  agents?: Record<string, unknown>[];
  apis?: Record<string, unknown>[];
  maxConcurrency?: number;
  version?: string;
  cadence?: string;
}): Promise<Mounted> {
  const config = {
    canGlobal: true,
    stepTimeoutSec: 900,
    maxConcurrency: opts.maxConcurrency ?? 5,
    defaultMaxConcurrency: 5,
    maxConcurrencyCeiling: 16,
    configPath: "/repo/steamtrain.json",
    version: opts.version,
    agents: opts.agents ?? [],
    apis: opts.apis ?? [],
  };
  let cadencePref = opts.cadence ?? "launch";
  const puts: Record<string, unknown>[] = [];
  const root = el("div");
  const ST: Record<string, unknown> = {
    state: { doctor: opts.doctor ?? [], apiDoctor: opts.apiDoctor ?? [], projectConfig: null },
    h: el,
    clear: (node: StubEl) => {
      node.children = [];
    },
    agentHealthMeta: (status: string) => ({ loud: LOUD.has(status) }),
    apiHealthMeta: (status: string) => ({ loud: LOUD.has(status) }),
    agentUiLabel: (id: string) => id,
    isReadOnly: () => false,
    refreshWorkflowList: () => {},
    copyFix: () => {},
    pollDoctor: () => {},
    healthCadence: () => cadencePref,
    setHealthCadence: (next: string) => {
      cadencePref = next;
    },
    recheckHealth: () => Promise.resolve({ status: 200 }),
    modals: {
      mbanner: (node: StubEl, text: string, kind: string) => {
        if (!text) {
          node.className = "mbanner";
          node.text = "";
          return;
        }
        node.className = `mbanner show ${kind === "err" ? "err" : "info"}`;
        node.text = text;
      },
      field: (_label: string, input: StubEl) => input,
    },
    apiAuth: (method: string, _path: string, body?: Record<string, unknown>) => {
      if (method === "PUT") {
        puts.push(body ?? {});
        return Promise.resolve({ status: 200, body: { ok: true } });
      }
      return Promise.resolve({ status: 200, body: config });
    },
  };
  const window = {
    Steamtrain: ST,
    SteamtrainReducer: null,
    location: { hash: "" },
    confirm: () => true,
  };
  new Function("window", "document", settingsJs)(window, { getElementById: () => null });
  const settings = ST.settings as { render: (c: StubEl, s: string) => void };
  settings.render(root, "runners");
  await Promise.resolve();
  await Promise.resolve();

  const rows = () =>
    collect(root, (n) => n.className.split(" ").includes("runner-row")).map((row) => {
      const acts = collect(row, (n) => n.className === "rowacts")[0];
      const buttons = acts ? acts.children : [];
      return {
        cls: row.className,
        text: flatText(row),
        actions: buttons.map((b) => b.text),
        click: (label: string) => {
          const btn = buttons.find((b) => b.text === label);
          if (!btn) throw new Error(`no "${label}" button on row: ${flatText(row)}`);
          for (const fn of btn.listeners.click ?? []) fn();
        },
      };
    });
  const banner = () => {
    const node = collect(root, (n) => String(n.className).includes("mbanner"))[0];
    return node ? flatText(node) : "";
  };
  const save = async () => {
    const btn = collect(root, (n) => n.text === "Save changes")[0];
    if (!btn) throw new Error("no Save button");
    for (const fn of btn.listeners.click ?? []) fn();
    await Promise.resolve();
    await Promise.resolve();
  };
  const tally = () => {
    const strip = collect(root, (n) => n.className === "runner-tally")[0];
    return strip ? flatText(strip) : "";
  };
  const navFlagged = () => collect(root, (n) => n.className.split(" ").includes("flag")).length > 0;
  const sliderEl = () => {
    const node = collect(root, (n) => n.className === "slider")[0];
    if (!node) throw new Error("no concurrency slider");
    return node;
  };
  const setConcurrency = (value: number) => {
    const node = sliderEl();
    node.attrs.value = String(value);
    (node as unknown as { value: string }).value = String(value);
    for (const fn of node.listeners.input ?? []) fn();
  };
  const saveEnabled = () => {
    const btn = collect(root, (n) => n.text === "Save changes")[0];
    if (!btn) return false;
    // syncRunnersFoot sets the DOM property, not the creation-time attribute.
    return (btn as unknown as { disabled?: boolean }).disabled !== true;
  };
  const cadenceItems = () => collect(root, (n) => n.className.split(" ").includes("seg-item"));
  const cadence = () => cadenceItems().map((n) => n.text + (n.className.includes("on") ? "*" : ""));
  const pickCadence = (label: string) => {
    const btn = cadenceItems().find((n) => n.text === label);
    if (!btn) throw new Error(`no cadence option "${label}"`);
    for (const fn of btn.listeners.click ?? []) fn();
  };
  const headActions = () => {
    const head = collect(root, (n) => n.className === "settings-head")[0];
    if (!head) return [];
    const acts = collect(head, (n) => n.className === "actions")[0];
    return acts ? acts.children.map((b) => b.text) : [];
  };
  const navFoot = () => {
    const node = collect(root, (n) => n.className === "settings-navfoot")[0];
    return node ? flatText(node) : "";
  };
  const foot = () => {
    const node = collect(root, (n) => n.className === "settings-foot")[0];
    return node ? flatText(node) : "";
  };
  return {
    rows,
    save,
    tally,
    navFlagged,
    puts,
    banner,
    setConcurrency,
    slider: () => sliderEl().attrs,
    saveEnabled,
    cadence,
    pickCadence,
    headActions,
    navFoot,
    foot,
  };
}

describe("runners settings table", () => {
  const MIXED = {
    doctor: [
      { agent: "amp", status: "binary_missing", provider: "amp", binary: "amp" },
      { agent: "codex", status: "not_authenticated", provider: "codex", binary: "codex" },
      { agent: "zed-fork", status: "ok", provider: "claude", binary: "zed" },
      { agent: "claude", status: "ok", provider: "claude", binary: "claude", version: "2.1" },
    ],
    agents: [{ id: "kiro", provider: "kiro", enabled: false, scope: "user" }],
  };

  it("ranks ready first, then fixable, then absent, with disabled last", async () => {
    const ui = await mountSettings(MIXED);
    expect(ui.rows().map((r) => r.text.split(" ")[0])).toEqual([
      "claude",
      "zed-fork",
      "codex",
      "amp",
      "kiro",
    ]);
  });

  it("marks the disabled row as disabled instead of trusting a stale probe", async () => {
    const ui = await mountSettings(MIXED);
    const kiro = ui.rows().at(-1);
    expect(kiro?.cls).toContain("off");
    expect(kiro?.text).toContain("disabled");
    expect(kiro?.actions).toEqual(["off", "Edit", "×"]);
  });

  it("offers on/off, Edit, and remove on every row", async () => {
    const ui = await mountSettings(MIXED);
    for (const row of ui.rows()) {
      expect(row.actions).toEqual(
        expect.arrayContaining(["Edit", "×", expect.stringMatching(/^(on|off)$/)]),
      );
      expect(row.actions).toHaveLength(3);
    }
  });

  it("explains when remove is pressed on a built-in with no config entry", async () => {
    const ui = await mountSettings(MIXED);
    const claude = ui.rows().find((r) => r.text.startsWith("claude"));
    expect(claude).toBeTruthy();
    claude?.click("×");
    expect(ui.banner()).toMatch(/built-in default.*disable it instead/i);
    // Nothing was removed from the draft; Save would still only write what was already configured.
    await ui.save();
    expect(ui.puts[0]?.agents).toEqual([
      expect.objectContaining({ id: "kiro", provider: "kiro", enabled: false }),
    ]);
  });

  it("removes a configured runner from the draft on confirm", async () => {
    const ui = await mountSettings(MIXED);
    ui.rows()
      .find((r) => r.text.startsWith("kiro"))
      ?.click("×");
    expect(ui.rows().some((r) => r.text.startsWith("kiro"))).toBe(false);
    await ui.save();
    expect(ui.puts[0]?.agents ?? []).not.toContainEqual(expect.objectContaining({ id: "kiro" }));
  });

  it("disabling a built-in with no config entry saves an entry that holds the flag", async () => {
    const ui = await mountSettings(MIXED);
    ui.rows()[0]?.click("on");
    const claude = ui.rows().find((r) => r.text.startsWith("claude"));
    expect(claude?.cls).toContain("off");
    // A disabled runner is dead weight, so it sinks on the same repaint.
    expect(ui.rows().at(-1)?.text).toMatch(/^claude|^kiro/);
    await ui.save();
    expect(ui.puts).toHaveLength(1);
    expect(ui.puts[0]?.agents).toContainEqual(
      expect.objectContaining({ id: "claude", provider: "claude", enabled: false, scope: "user" }),
    );
  });

  it("re-enables from the same control", async () => {
    const ui = await mountSettings(MIXED);
    ui.rows().at(-1)?.click("off"); // the disabled kiro row
    const kiro = ui.rows().find((r) => r.text.startsWith("kiro"));
    expect(kiro?.cls).not.toContain("off");
    expect(kiro?.actions).toContain("on");
    await ui.save();
    expect(ui.puts[0]?.agents).toContainEqual(
      expect.objectContaining({ id: "kiro", enabled: true }),
    );
  });

  it("gives the row actions a real hit target", () => {
    const acts = ruleBody(settingsCss, ".runner-row .rowacts button");
    expect(acts).toMatch(/min-width:\s*2[4-9]px/);
    expect(acts).toMatch(/height:\s*2[4-9]px/);
    expect(acts).toMatch(/border:\s*1px solid/);
  });

  it("dims absent rows by colour so their controls stay usable", () => {
    expect(ruleBody(settingsCss, ".runner-row.absent")).not.toMatch(/opacity:/);
  });

  // The strip above the table and the table itself are two readings of the
  // same rows; if they can disagree, one of them is lying.
  it("tallies each state over exactly the rows the table draws", async () => {
    const ui = await mountSettings(MIXED);
    const tally = ui.tally();
    expect(tally).toContain("2 ready");
    expect(tally).toContain("1 needs auth");
    expect(tally).toContain("1 absent");
    expect(tally).toContain("1 disabled");
  });

  it("omits a state nothing is in rather than showing a zero", async () => {
    const ui = await mountSettings({
      doctor: [{ agent: "claude", status: "ok", provider: "claude", binary: "claude" }],
    });
    expect(ui.tally()).toContain("1 ready");
    expect(ui.tally()).not.toContain("needs auth");
    expect(ui.tally()).not.toContain("disabled");
  });

  // The reason to open Runners should be visible from the nav, before you do.
  it("flags the nav item when a runner needs auth, and not otherwise", async () => {
    const needsAuth = await mountSettings(MIXED);
    expect(needsAuth.navFlagged()).toBe(true);
    const clean = await mountSettings({
      doctor: [{ agent: "claude", status: "ok", provider: "claude", binary: "claude" }],
    });
    expect(clean.navFlagged()).toBe(false);
  });
});

describe("runner dials — concurrency and health cadence", () => {
  const ONE_OK = {
    doctor: [{ agent: "claude", status: "ok", provider: "claude", binary: "claude" }],
  };

  it("opens the slider on the configured value, inside the bounds the server sent", async () => {
    const ui = await mountSettings({ ...ONE_OK, maxConcurrency: 3 });
    expect(ui.slider()).toMatchObject({ min: "1", max: "16", value: "3" });
  });

  it("clamps a configured value above the ceiling instead of offering it", async () => {
    const ui = await mountSettings({ ...ONE_OK, maxConcurrency: 99 });
    expect(ui.slider().value).toBe("16");
  });

  it("saves the moved ceiling, and nothing else changed", async () => {
    const ui = await mountSettings({ ...ONE_OK, maxConcurrency: 3 });
    expect(ui.saveEnabled()).toBe(false);
    ui.setConcurrency(7);
    expect(ui.saveEnabled()).toBe(true);
    await ui.save();
    expect(ui.puts[0]?.maxConcurrency).toBe(7);
  });

  // maxConcurrency is project-scoped while agents default to the global file;
  // sending it unchanged would rewrite steamtrain.json on every runner save.
  it("leaves maxConcurrency out of the payload when the slider was not touched", async () => {
    const ui = await mountSettings({
      ...ONE_OK,
      maxConcurrency: 3,
      agents: [{ id: "kiro", provider: "kiro", enabled: false, scope: "user" }],
    });
    ui.rows()
      .find((r) => r.text.startsWith("kiro"))
      ?.click("off");
    await ui.save();
    expect(ui.puts[0]).not.toHaveProperty("maxConcurrency");
  });

  it("marks exactly one cadence, and switching moves the mark", async () => {
    const ui = await mountSettings({ ...ONE_OK, cadence: "launch" });
    expect(ui.cadence()).toEqual(["Manual", "On launch*", "Every 60s"]);
    ui.pickCadence("Every 60s");
    expect(ui.cadence()).toEqual(["Manual", "On launch", "Every 60s*"]);
  });

  it("puts the section's own verbs in its header", async () => {
    const ui = await mountSettings(ONE_OK);
    expect(ui.headActions()).toEqual(["Recheck all", "Add agent", "Add API", "Close"]);
  });

  it("names the file a save lands in, and the version that is running", async () => {
    const ui = await mountSettings({ ...ONE_OK, version: "0.14.2" });
    expect(ui.navFoot()).toContain("v0.14.2");
    expect(ui.foot()).toContain("/repo/steamtrain.json");
  });

  it("leaves the version line out rather than inventing one", async () => {
    const ui = await mountSettings(ONE_OK);
    expect(ui.navFoot()).not.toMatch(/\bv\d/);
  });
});

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
