/**
 * The shared stub DOM (tests/helpers/stub-dom.ts) stands in for a browser in
 * every web client test, so where it differs from one a test can pass on
 * behavior the page would not have. These pin the places it is meant to agree.
 */
import { describe, expect, it } from "vitest";
import { createDom } from "./helpers/stub-dom";

describe("stub DOM", () => {
  it("refuses a selector it cannot honour instead of matching everything", () => {
    const { h } = createDom();
    const root = h("div", null, h("span"));
    expect(() => root.querySelectorAll("")).toThrow(/unsupported selector/);
    expect(() => root.querySelector("span:first-child")).toThrow(/unsupported selector/);
    for (const dangling of ["div >", "> span", "div > > span"]) {
      expect(() => root.querySelector(dangling)).toThrow(/unsupported selector/);
    }
    // A well-formed one still works; the root counts as an ancestor, as in a browser.
    expect(root.querySelectorAll("div > span")).toHaveLength(1);
  });

  it("refuses a malformed selector list whichever node is asked", () => {
    const { h } = createDom();
    expect(() => h("button").matches("button,")).toThrow(/unsupported selector/);
    expect(() => h("span").matches("button,")).toThrow(/unsupported selector/);
  });

  it("keeps an element's text in a child, so removing children clears it", () => {
    const { h } = createDom();
    const node = h("div", { text: "old" });
    // st-core's clear().
    while (node.firstChild) node.removeChild(node.firstChild);
    expect(node.textContent).toBe("");
  });

  it("finds a node by an id a script assigned, in the body or a registered tree", () => {
    const { document, h, byId } = createDom();
    const pane = h("div");
    pane.id = "runsPage";
    document.body.appendChild(pane);
    expect(document.getElementById("runsPage")).toBe(pane);

    byId.modal = h("div");
    const field = h("input");
    field.id = "name";
    byId.modal.appendChild(field);
    expect(document.getElementById("name")).toBe(field);
  });

  it("keeps a combinator inside an attribute value as part of the value", () => {
    const { h } = createDom();
    const root = h("div", null, h("span", { title: "a>b" }), h("span", { title: "a" }));
    expect(root.querySelectorAll('[title="a>b"]')).toHaveLength(1);
    expect(root.querySelectorAll('div > [title="a>b"]')).toHaveLength(1);
  });

  it("refuses to insert before, or remove, a node that is not a child", () => {
    const { h } = createDom();
    const parent = h("div", null, h("span"));
    expect(() => parent.insertBefore(h("b"), h("i"))).toThrow(/not a child/);
    expect(() => parent.removeChild(h("i"))).toThrow(/not a child/);
    expect(parent.children).toHaveLength(1);
  });

  it("reflects disabled, hidden and open as attributes", () => {
    const { h } = createDom();
    const form = h("div", null, h("input"), h("input"));
    const [first, second] = form.children;
    first!.disabled = true;
    expect(form.querySelectorAll("input:not([disabled])")).toEqual([second]);
    first!.removeAttribute("disabled");
    expect(first!.disabled).toBe(false);
    second!.setAttribute("hidden", "");
    expect(second!.hidden).toBe(true);
  });

  it("bubbles a click from the body to the document, until a handler stops it", () => {
    const { document, h } = createDom();
    const seen: string[] = [];
    const inner = h("button");
    const outer = h("div", { onClick: () => seen.push("outer") }, inner);
    document.body.appendChild(outer);
    document.addEventListener("click", () => seen.push("document"));

    inner.click();
    expect(seen).toEqual(["outer", "document"]);

    seen.length = 0;
    inner.addEventListener("click", (e) =>
      (e as { stopPropagation: () => void }).stopPropagation(),
    );
    inner.click();
    expect(seen).toEqual([]);

    // A detached node has no document to reach.
    const loose = h("div", { onClick: () => seen.push("loose") });
    loose.click();
    expect(seen).toEqual(["loose"]);
  });
});
