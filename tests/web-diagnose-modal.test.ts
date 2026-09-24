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
import { type StubEl, createDom, flatText, loadScripts } from "./helpers/stub-dom";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public");
const modalsJs = readFileSync(join(PUBLIC_DIR, "st-modals.js"), "utf8");

const RECORD = { id: "diag-1", workflow: "bug-hunt", ok: false, status: "error", phases: [] };

interface Mounted {
  text: () => string;
  posts: { method: string; path: string; body?: unknown }[];
  /** Open the modal on the same run again, in the same session. */
  reopen: () => Promise<void>;
}

async function openDiagnose(response: Record<string, unknown>): Promise<Mounted> {
  const { document, h, byId } = createDom();
  const modal = h("div");
  byId.modal = modal;
  byId.overlay = h("div");
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
    h,
    clear: (n: StubEl) => {
      n.textContent = "";
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
  loadScripts([modalsJs], {
    window: { Steamtrain: ST, location: { hash: "" } },
    document,
    setTimeout: (fn: () => void) => {
      fn();
      return 0;
    },
  });
  const open = async () => {
    // Whatever the modal shows after this, this open rendered.
    modal.textContent = "";
    (ST.modals as { openDiagnoseModal: (r: typeof RECORD) => void }).openDiagnoseModal(RECORD);
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  await open();
  return { text: () => flatText(modal), posts, reopen: open };
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
    const m = await openDiagnose(response);
    expect(m.posts).toHaveLength(1);
    await m.reopen();
    expect(m.posts).toHaveLength(1);
    expect(m.text()).toContain("cached");
  });

  it("asks again on reopen when the last attempt failed", async () => {
    // Only a successful diagnosis is cached; a failure (no key, a timeout) is
    // worth retrying once the reader has fixed it.
    const m = await openDiagnose({ ok: false, error: "needs an API key" });
    await m.reopen();
    expect(m.posts).toHaveLength(2);
    expect(m.text()).toContain("needs an API key");
  });
});
