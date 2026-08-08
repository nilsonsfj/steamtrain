/**
 * Every copy button goes through one primitive, so every copy button works on
 * a non-secure origin.
 *
 * `navigator.clipboard` is undefined outside a secure context, and this UI is
 * meant to be opened from another machine — so on any LAN address that is not
 * localhost, a button that calls `writeText` behind a bare `.catch(noop)`
 * silently does nothing while looking like it worked. `copyText` in st-core.js
 * owns the clipboard → execCommand → select-the-node chain; nothing else may
 * touch the clipboard API directly.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public");
const coreJs = readFileSync(join(PUBLIC_DIR, "st-core.js"), "utf8");

/** Hand-written client modules, excluding the generated bundles. */
function clientModules(): string[] {
  return readdirSync(PUBLIC_DIR).filter((f) => f.endsWith(".js") && !f.endsWith(".bundle.js"));
}

/** Source with block and line comments stripped, so prose never matches. */
function code(file: string): string {
  return readFileSync(join(PUBLIC_DIR, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

describe("clipboard access is funnelled through one primitive", () => {
  it("only st-core.js touches navigator.clipboard", () => {
    const offenders = clientModules().filter(
      (f) => f !== "st-core.js" && /navigator\.clipboard/.test(code(f)),
    );
    expect(offenders).toEqual([]);
  });

  it("the primitive falls back instead of swallowing the failure", () => {
    // The two ways a copy can fail: no clipboard API at all (insecure origin),
    // and a writeText the browser rejects. Both must reach fallbackCopy.
    expect(coreJs).toMatch(/function copyText\(text, onOk, codeEl\)/);
    expect(coreJs).toMatch(/\.catch\(function \(\) \{ fallbackCopy\(text, codeEl, done\); \}\)/);
    expect(coreJs).toMatch(/fallbackCopy\(text, codeEl, done\);\s*\}/);
    expect(coreJs).toContain('document.execCommand("copy")');
  });

  it("reports success only when the text actually landed", () => {
    // fallbackCopy calls onOk only inside `if (ok)`; the select-the-node last
    // resort deliberately does not. A "Copied" flash on a failed copy is a lie
    // the reader acts on.
    expect(coreJs).toMatch(/if \(ok\) \{ onOk\(\); return; \}/);
    expect(coreJs).toMatch(/function copyFix\(text, btn, codeEl, label\)/);
    expect(coreJs).toMatch(/copyText\(text, function \(\) \{[\s\S]*?"Copied"/);
  });

  it("every copy button restores its own label, not a hardcoded Copy", () => {
    // "Copy error" and "Copy all" must not come back as "Copy".
    expect(coreJs).toMatch(/var back = label \|\| btn\.textContent \|\| "Copy";/);
  });
});
