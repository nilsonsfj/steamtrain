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
import * as SteamtrainReducer from "../src/web/reducer";
import { type StubEl, buttonsNamed, click, createDom, loadScripts } from "./helpers/stub-dom";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public");
const modalsJs = readFileSync(join(PUBLIC_DIR, "st-modals.js"), "utf8");
const runJs = readFileSync(join(PUBLIC_DIR, "st-run.js"), "utf8");

/** Load st-modals.js (and st-run.js) over a stub `window.Steamtrain`. */
function load(state: Record<string, unknown> = {}, catalog: Record<string, unknown> = {}) {
  const { document, h, byId } = createDom();
  for (const id of ["modal", "overlay", "paramsPanel", "paramsForm", "banner"]) byId[id] = h("div");
  const posts: { path: string; body: unknown }[] = [];
  const ST: Record<string, unknown> = {
    state: { agents: [], doctor: [], ...state },
    h,
    clear: (n: StubEl) => {
      n.textContent = "";
    },
    agentById: () => null,
    agentUiLabel: (id: string) => id,
    effortsFor: () => [],
    modelsFor: () => [],
    isReadOnly: () => false,
    ...catalog,
    run: { setBanner: () => {} },
    apiAuth: (_method: string, path: string, body?: unknown) => {
      posts.push({ path, body });
      return new Promise(() => {});
    },
  };
  const window = { Steamtrain: ST, SteamtrainReducer, location: { hash: "" } };
  const immediately = (fn: () => void) => {
    fn();
    return 0;
  };
  loadScripts([modalsJs, runJs], { window, document, setTimeout: immediately, SteamtrainReducer });
  return {
    modals: ST.modals as {
      openEditor: () => void;
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
    h,
  };
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
    click(buttonsNamed(modal, "Retry with agent")[0]);
    expect(posts).toEqual([
      { path: "/api/history/r1/retry", body: { retargetAgent: "codex", retargetModel: "gpt-6" } },
    ]);
  });
});

describe("blur validation", () => {
  it("writes to the error line of the field the control is in now", () => {
    const { modals, h } = load();
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
    const { modals, h } = load();
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

describe("the configure sheet's nested editors", () => {
  it("apply 'Use for all' from inside a sub-workflow to every agent step", () => {
    const models: Record<string, { id: string; name: string }[]> = {
      claude: [
        { id: "claude-sonnet-5", name: "Sonnet 5" },
        { id: "claude-opus-5-5", name: "Opus 5.5" },
      ],
      codex: [{ id: "gpt-6", name: "GPT-6" }],
    };
    const worker = (id: string) => ({ id, agent: "claude", model: "claude-sonnet-5", prompt: id });
    const { modals, byId } = load(
      {
        agents: [
          { id: "claude", models: models.claude },
          { id: "codex", models: models.codex },
        ],
        spec: {
          name: "outer",
          phases: [
            {
              id: "p",
              steps: [worker("top"), { id: "call", kind: "workflow", workflow: "child" }],
            },
          ],
        },
        childSpecs: { child: { name: "child", phases: [{ id: "c", steps: [worker("inner")] }] } },
        source: "project",
        selected: "outer",
        stagedOverrides: {},
      },
      {
        modelsFor: (agent: string) => models[agent] ?? [],
        effortsFor: (_agent: string, model: string) =>
          model === "claude-opus-5-5" ? ["low", "high"] : [],
      },
    );
    modals.openEditor();
    const modal = byId.modal!;
    const nested = modal.querySelectorAll(".estep").find((c) => c.classList.contains("nested"))!;
    const [, modelSel] = nested.querySelectorAll("select");
    modelSel!.value = "claude-opus-5-5";
    modelSel!.fire("change");
    const effortSel = nested.querySelectorAll("select")[2]!;
    effortSel.value = "high";
    click(buttonsNamed(nested, "Use for all →")[0]);

    const bulk = modal.querySelector(".bulk-retarget")!;
    expect(bulk.querySelectorAll("select").map((sel) => sel.value)).toEqual([
      "claude",
      "claude-opus-5-5",
      "high",
    ]);
    expect(bulk.querySelector(".bulk-flash")!.textContent).toBe(
      "Retargeted 2 steps → claude · claude-opus-5-5 · high",
    );
    const top = modal.querySelectorAll(".estep").find((c) => !c.classList.contains("nested"))!;
    expect(
      top
        .querySelectorAll("select")
        .slice(0, 2)
        .map((sel) => sel.value),
    ).toEqual(["claude", "claude-opus-5-5"]);
  });
});
