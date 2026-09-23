import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public");
const bootJs = readFileSync(join(PUBLIC_DIR, "st-boot.js"), "utf8");
const coreJs = readFileSync(join(PUBLIC_DIR, "st-core.js"), "utf8");
const inspectorJs = readFileSync(join(PUBLIC_DIR, "st-inspector.js"), "utf8");
const planJs = readFileSync(join(PUBLIC_DIR, "st-plan.js"), "utf8");
const runJs = readFileSync(join(PUBLIC_DIR, "st-run.js"), "utf8");
const runCss = readFileSync(join(PUBLIC_DIR, "run.css"), "utf8");
const shellJs = readFileSync(join(PUBLIC_DIR, "st-shell.js"), "utf8");
const planCss = readFileSync(join(PUBLIC_DIR, "plan.css"), "utf8");

interface StubNode {
  tag: string;
  className: string;
  textContent: string;
  children: StubNode[];
  listeners: Record<string, (() => void)[]>;
  appendChild: (child: StubNode) => void;
  addEventListener: (event: string, fn: () => void) => void;
}

function node(tag: string, attrs: Record<string, unknown> = {}, ...children: unknown[]): StubNode {
  const result: StubNode = {
    tag,
    className: String(attrs.class ?? ""),
    textContent: attrs.text == null ? "" : String(attrs.text),
    children: [],
    listeners: {},
    appendChild(child) {
      result.children.push(child);
    },
    addEventListener(event, fn) {
      const listeners = result.listeners[event] ?? [];
      result.listeners[event] = listeners;
      listeners.push(fn);
    },
  };
  for (const child of children) {
    if (child && typeof child !== "string") result.children.push(child as StubNode);
    else if (typeof child === "string") result.textContent += child;
  }
  return result;
}

function flatText(value: StubNode): string {
  return [value.textContent, ...value.children.map(flatText)].join(" ").replace(/\s+/g, " ").trim();
}

describe("web plan and sidebar UI contracts", () => {
  it("parks the shared Inputs controls before the destructive canvas clear", () => {
    const prepare = bootJs.indexOf("ST.plan.prepareRender()");
    const clear = bootJs.indexOf("clear(stage);");

    expect(prepare).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(-1);
    expect(prepare).toBeLessThan(clear);
    expect(planJs).toMatch(/function prepareRender\(\)\s*\{\s*parkComposerNodes\(true\);\s*\}/);
    expect(planJs).toContain("prepareRender: prepareRender");
    expect(planJs).toContain("function renderInputsTab(container, spec)");
  });

  it("keeps live inspector timer labels stable across timer ticks", () => {
    // The status pill no longer carries a clock — the Elapsed metric right
    // below it is the step's one timer — but that metric still opts out of
    // the default "⏱ " glyph through the same prefix mechanism.
    expect(coreJs).toContain('getAttribute("data-since-prefix")');
    expect(inspectorJs).toContain('"data-since-prefix": ""');
    expect(inspectorJs).not.toContain('text: "running " + ST.fmtElapsed');
  });

  it("preserves the outer canvas and expanded step-list scroll positions", () => {
    expect(bootJs).toContain("function captureCanvasScroll(stage)");
    expect(bootJs).toContain(".band-steps[data-scroll-key]");
    expect(bootJs).toContain("position.follow ? stage.scrollHeight : position.top");
    expect(runJs).toContain('"data-scroll-key": listKey');
    expect(runJs).toContain("S.stepListScroll[listKey]");
  });

  it("connects sub-workflow details to their parent step", () => {
    expect(runJs).toContain('class: "subwf-label", text: "inside"');
    expect(runCss).toContain(".step-sub::before");
    expect(runCss).toContain(".step-sub .subwf");
    expect(runCss).toContain(".step-sub .subwf-body");
  });

  it("uses a horizontally scrollable shared grid for aligned headers and rows", () => {
    expect(planCss).toContain(".plan-viewport");
    expect(planCss).toMatch(/\.plan-viewport\s*\{[\s\S]*overflow-x:\s*auto/);
    expect(planCss).toMatch(/\.plan-grid\s*\{[\s\S]*min-width:\s*780px/);
    expect(planCss).toMatch(/\.plan-gridhead,\s*\.plan-row\s*\{[\s\S]*grid-template-columns:/);
    expect(planJs).toContain('text: "Context"');
    expect(planJs).toContain('text: "Retries"');
    expect(planJs).not.toContain('text: "Cache"');
    expect(planJs).not.toContain('text: "Est."');
  });

  it("renders user workflows before bundled workflows with both group headings", () => {
    const list = node("div");
    const count = node("span");
    const workflows = [
      { name: "bundled-one", source: "bundled", phaseCount: 1, stepCount: 1 },
      { name: "user-one", source: "user", phaseCount: 2, stepCount: 3 },
    ];
    const elements: Record<string, StubNode> = { wflist: list, wfCount: count };
    const ST: Record<string, unknown> = {
      state: { workflows, selected: null, liveRuns: [], recentRuns: null },
      h: node,
      clear: (target: StubNode) => {
        target.children = [];
      },
      groupWorkflowsBySource: () => [
        { source: "bundled", entries: [workflows[0]] },
        { source: "user", entries: [workflows[1]] },
      ],
      isLiveAttached: () => false,
      isReadOnly: () => false,
      selectWorkflow: () => {},
      truncate: (text: string) => text,
      wfListItem: () => null,
      relTime: () => "",
      plan: null,
    };
    const document = {
      getElementById: (id: string) => elements[id] ?? null,
    };

    new Function("window", "document", shellJs)({ Steamtrain: ST }, document);
    (ST.shell as { renderSidebar: () => void }).renderSidebar();

    expect(list.children.map((child) => flatText(child))).toEqual([
      "User 1",
      "user-one 2·3",
      "Bundled 1",
      "bundled-one 1·1",
    ]);
  });

  it("labels a timed-out recent run as timed out, not canceled", () => {
    const foot = node("div");
    const elements: Record<string, StubNode> = { wflist: node("div"), railFoot: foot };
    const run = (id: string, status: string, timedOut?: boolean) => ({
      id,
      status,
      timedOut,
      startedAt: 0,
      input: "",
    });
    const ST: Record<string, unknown> = {
      state: {
        selected: "w",
        liveRuns: [],
        recentRuns: [run("aaaaa1", "canceled", true), run("bbbbb2", "canceled")],
      },
      h: node,
      clear: (target: StubNode) => {
        target.children = [];
      },
      truncate: (text: string) => text,
      relTime: () => "now",
    };
    const document = { getElementById: (id: string) => elements[id] ?? null };

    new Function("window", "document", shellJs)({ Steamtrain: ST }, document);
    (ST.shell as { renderLiveRuns: () => void }).renderLiveRuns();

    const rows = foot.children.map((child) => flatText(child));
    expect(rows).toContain("aaaaa · now · timed out");
    expect(rows).toContain("bbbbb · now · canceled");
  });
});
