/**
 * Contracts for the two surfaces that report runner readiness in the web UI:
 * the topbar health chips (st-shell.js) and the Runners settings table
 * (st-settings.js + settings.css).
 *
 * The chip logic is real logic (counting, naming, dropping states that don't
 * deserve a chip), so it runs here for real: st-shell.js is a plain IIFE over
 * `window.Steamtrain`, so a stub namespace plus a stub `document` is enough to
 * call `renderHealth` and read back the chips it built. The settings table is
 * DOM-heavy paint code with no such seam, so its invariants are asserted
 * against source and stylesheet.
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
  appendChild: (child: StubEl) => void;
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

/** Loads st-shell.js against a stub DOM and returns the chips renderHealth builds. */
function renderChips(
  doctor: { agent: string; status: string }[],
  apis: { api: string; status: string }[],
  spec: unknown = { phases: [] },
): Chip[] {
  const el = (tag: string, attrs?: Record<string, unknown>, ...kids: unknown[]): StubEl => {
    const node: StubEl = {
      tag,
      attrs: attrs ?? {},
      children: [],
      text: "",
      appendChild: (child) => node.children.push(child),
    };
    for (const kid of kids) {
      if (kid == null) continue;
      if (typeof kid === "string") node.text += kid;
      else node.children.push(kid as StubEl);
    }
    return node;
  };
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

describe("runners settings table", () => {
  it("ranks ready first and pushes disabled runners to the bottom", () => {
    // rowRank: ready 0 → needs auth 1 → absent/unprobed 2 → disabled 3.
    const rank = settingsJs.slice(settingsJs.indexOf("function rowRank"));
    const body = rank.slice(0, rank.indexOf("\n  }"));
    expect(body).toMatch(/isDisabled\(row\)\)\s*return 3/);
    expect(body).toMatch(/status === "ok"\)\s*return 0/);
    expect(body).toMatch(/meta\.loud \? 1 : 2/);
  });

  it("offers an on/off control on every row and writes enabled into the draft", () => {
    expect(settingsJs).toMatch(/class: "toggle"/);
    expect(settingsJs).toMatch(/entry\.enabled = enabled/);
    // Disabling a built-in with no config entry has to create one to hold the flag.
    expect(settingsJs).toMatch(
      /\(kind === "agent" \? draft\.agents : draft\.apis\)\.push\(entry\)/,
    );
  });

  it("labels the edit control instead of relying on a lone glyph", () => {
    expect(settingsJs).toMatch(/class: "act edit".*text: "Edit"/s);
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
