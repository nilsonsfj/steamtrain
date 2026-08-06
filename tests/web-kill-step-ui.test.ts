import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The "Kill step" control in the live step record (design 02.4). st-inspector.js
 * is a plain IIFE over `window.Steamtrain`, so it runs here for real against a
 * stub DOM: the tests paint the record and read back whether the button is
 * offered, and what it posts when clicked.
 */

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public");
const inspectorJs = readFileSync(join(PUBLIC_DIR, "st-inspector.js"), "utf8");

interface StubEl {
  tag: string;
  attrs: Record<string, unknown>;
  children: StubEl[];
  text: string;
  className: string;
  disabled?: boolean;
  listeners: Record<string, ((e?: unknown) => void)[]>;
  appendChild: (child: StubEl) => void;
  addEventListener: (event: string, fn: (e?: unknown) => void) => void;
  classList: { add: () => void; toggle: () => void };
}

function el(tag: string, attrs?: Record<string, unknown>, ...kids: unknown[]): StubEl {
  const node: StubEl = {
    tag,
    attrs: attrs ?? {},
    children: [],
    text: attrs?.text == null ? "" : String(attrs.text),
    className: String(attrs?.class ?? ""),
    disabled: attrs?.disabled === true,
    listeners: {},
    appendChild: (child) => node.children.push(child),
    addEventListener: (event, fn) => {
      const bucket = node.listeners[event] ?? [];
      node.listeners[event] = bucket;
      bucket.push(fn);
    },
    classList: { add: () => {}, toggle: () => {} },
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

function collect(node: StubEl, pred: (n: StubEl) => boolean, out: StubEl[] = []): StubEl[] {
  if (pred(node)) out.push(node);
  for (const kid of node.children) collect(kid, pred, out);
  return out;
}
function flatText(node: StubEl): string {
  return [node.text, ...node.children.map(flatText)].join(" ").replace(/\s+/g, " ").trim();
}

interface Posted {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

/** Paint the step record for a step in the given state. */
function mountRecord(opts: {
  status?: string;
  killed?: boolean;
  readOnly?: boolean;
  external?: boolean;
  detached?: boolean;
  runId?: string | null;
  /** Status the kill endpoint answers with. */
  killStatus?: number;
}) {
  const step = {
    stepId: "cross-check",
    blockKind: "worker",
    status: opts.status ?? "running",
    killed: opts.killed,
    startedAt: 1000,
    text: "",
    cached: false,
  };
  const posts: Posted[] = [];
  const said: string[] = [];
  const banners: string[] = [];
  const rail = el("aside");
  const ST: Record<string, unknown> = {
    state: {
      runId: opts.runId === undefined ? "run-1" : opts.runId,
      runExternal: opts.external === true,
      runDetached: opts.detached === true,
      selected: "bug-hunt",
      spec: null,
      recordTab: "live",
      detail: { phaseId: "p1", stepId: "cross-check", iteration: 1 },
      runState: {
        phases: [{ phaseId: "p1", iteration: 1, steps: [step] }],
      },
      planSelection: [],
      tailScroll: {},
    },
    h: el,
    clear: (node: StubEl) => {
      node.children = [];
    },
    isReadOnly: () => opts.readOnly === true,
    announce: (text: string) => said.push(text),
    fmtElapsed: () => "27.4s",
    fmtTokens: () => "0",
    totalTokens: () => 0,
    // The rail's Spend/Tokens metrics; this fixture is about the kill control,
    // so the step it renders has billed nothing.
    stepUsage: () => ({ costUsd: 0, tokens: 0, live: false }),
    agentUiLabel: (id: string) => id,
    stepKey: (p: { phaseId: string }, st: { stepId: string }) => `${p.phaseId}:${st.stepId}`,
    render: () => {},
    modelsFor: () => [],
    effortsFor: () => [],
    plan: { findStep: () => null, selectStep: () => {} },
    modals: {},
    run: {
      setBanner: (text: string) => banners.push(text),
      closeDetail: () => {},
      openDetail: () => {},
    },
    selectWorkflow: () => {},
    apiAuth: (method: string, path: string, body?: Record<string, unknown>) => {
      posts.push({ method, path, body });
      const status = opts.killStatus ?? 200;
      return Promise.resolve({
        status,
        body: status === 200 ? { killed: true } : { error: "step is not running any more" },
      });
    },
  };

  new Function("window", "document", "requestAnimationFrame", inspectorJs)(
    { Steamtrain: ST },
    { getElementById: () => null },
    () => 0,
  );
  (ST.inspector as { render: (r: StubEl) => boolean }).render(rail);

  const killBtn = collect(rail, (n) => n.tag === "button" && n.text === "Kill step")[0];
  return {
    rail,
    posts,
    said,
    banners,
    killBtn,
    footText: () => flatText(collect(rail, (n) => n.className === "insp-foot")[0] ?? el("div")),
    pill: () =>
      flatText(collect(rail, (n) => n.className.startsWith("insp-status"))[0] ?? el("div")),
    clickKill: async () => {
      if (!killBtn) throw new Error("no Kill step button");
      for (const fn of killBtn.listeners.click ?? []) fn();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe("kill step control", () => {
  it("posts the kill for the step on screen and says so", async () => {
    const ui = mountRecord({});
    expect(ui.killBtn).toBeDefined();

    await ui.clickKill();
    expect(ui.posts).toEqual([
      { method: "POST", path: "/api/runs/run-1/kill-step", body: { stepId: "cross-check" } },
    ]);
    // The engine's step_killed marks the step; the button only reports.
    expect(ui.said.join(" ")).toContain("Killed step cross-check");
    expect(ui.banners).toEqual([]);
    expect(ui.killBtn?.disabled).toBe(true);
  });

  it("relays the server's refusal and offers the button again", async () => {
    const ui = mountRecord({ killStatus: 400 });
    await ui.clickKill();
    expect(ui.banners.join(" ")).toContain("not running any more");
    // The step may still be alive, so the reader keeps the control.
    expect(ui.killBtn?.disabled).toBe(false);
  });

  it.each([
    { label: "a finished step", opts: { status: "done" } },
    { label: "a step already being killed", opts: { killed: true } },
    { label: "a viewer", opts: { readOnly: true } },
    { label: "a run owned by another process", opts: { external: true } },
    { label: "a detached run", opts: { detached: true } },
  ])("offers nothing to $label", ({ opts }) => {
    // Nothing this session can stop, so nothing that pretends it can.
    expect(mountRecord(opts).killBtn).toBeUndefined();
  });

  it("stops the status pill reading as plain 'running' once a kill lands", () => {
    expect(mountRecord({}).pill()).not.toContain("killing");
    expect(mountRecord({ killed: true }).pill()).toContain("killing");
  });
});
