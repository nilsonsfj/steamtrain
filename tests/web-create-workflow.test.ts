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
import {
  type StubEl,
  buttonsNamed,
  byClass,
  click,
  createDom,
  flatText,
  loadScripts,
} from "./helpers/stub-dom";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public");
const modalsJs = readFileSync(join(PUBLIC_DIR, "st-modals.js"), "utf8");
const settingsCss = readFileSync(join(PUBLIC_DIR, "settings.css"), "utf8");

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
  /** Workflows the sheet opened once it had written them. */
  opened: string[];
}

async function openSheet(opts: { workflows?: Record<string, unknown>[] } = {}): Promise<Sheet> {
  const workflows = opts.workflows ?? [
    { name: "bug-hunt", source: "bundled", phaseCount: 1, stepCount: 1 },
    { name: "mine", source: "user", phaseCount: 2, stepCount: 3 },
  ];
  const puts: { path: string; body: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const { document, h, byId } = createDom();
  const modal = h("div");
  byId.modal = modal;
  byId.overlay = h("div");
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
    h,
    clear: (n: StubEl) => {
      n.textContent = "";
    },
    agentById: (id: string) =>
      (ST.state as { agents: Record<string, unknown>[] }).agents.find((a) => a.id === id),
    effortsFor: () => [],
    isReadOnly: () => false,
    modelsFor: () => [{ id: "sonnet", name: "sonnet" }],
    selectWorkflow: (name: string) => {
      opened.push(name);
    },
    shell: { renderSidebar: () => {} },
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
  loadScripts([modalsJs], {
    window: { Steamtrain: ST, location: { hash: "" } },
    document,
    setTimeout: (fn: () => void) => {
      fn();
      return 0;
    },
  });
  (ST.modals as { openCreate: () => void }).openCreate();
  const root = modal;
  const cards = () => byClass(root, "create-card");
  return {
    root,
    cards,
    card: (title) => {
      const found = cards().find((c) => flatText(c).startsWith(title));
      if (!found) throw new Error(`no "${title}" card`);
      return found;
    },
    nameInput: () => root.querySelector(".txt") as StubEl,
    description: () => root.querySelector("textarea") as StubEl,
    createButton: () => root.querySelector("button.create-submit") as StubEl,
    draft: () => root.querySelector(".draft") as StubEl,
    fileLine: () => flatText(root.querySelector(".create-file") ?? h("div")),
    create: async () => {
      click(buttonsNamed(root, "Create")[0]);
      for (let i = 0; i < 8; i++) await Promise.resolve();
    },
    banner: () => flatText(root.querySelector(".mbanner") ?? h("div")),
    puts,
    opened,
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

  // Regression: cards are <button>s, so a naive isInteractiveTarget check
  // treats clicks on title/body text as "interactive" and never selects.
  it("selects a starting point when its title text is clicked", async () => {
    const sheet = await openSheet();
    const describe = sheet.card("Describe");
    const title = describe.querySelector(".title");
    expect(title).toBeTruthy();
    click(title as StubEl);
    expect(describe.className).toContain("selected");
    expect(sheet.card("Blank").className).not.toContain("selected");
  });

  it("does not select the card when its nested select is clicked", async () => {
    const sheet = await openSheet();
    const duplicate = sheet.card("Duplicate");
    const sel = duplicate.querySelector("select");
    expect(sel).toBeTruthy();
    click(sel as StubEl);
    expect(duplicate.className).not.toContain("selected");
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
    // Once written, the sheet closes and opens the new workflow.
    expect(sheet.root.children).toHaveLength(0);
    expect(sheet.opened).toEqual(["flaky-tests"]);
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
      expect(byClass(progress, "draft-spinner")).toHaveLength(1);
      const status = progress.querySelector(".draft-status") as StubEl;
      expect(status.getAttribute("role")).toBe("status");
      expect(status.getAttribute("aria-busy")).toBe("true");
      expect(settingsCss).toContain(".draft-spinner");
      expect(settingsCss).toContain(".btn.create-submit.is-loading");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
