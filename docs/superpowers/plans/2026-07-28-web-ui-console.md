# Console Web UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the steamtrain web UI as the "Console" layout from the approved design — a three-column live-run cockpit, a split arrival page, and settings as a real page — retiring the Station/Ride/Conductor theatrical layer.

**Architecture:** The client stops being one 6,103-line IIFE (`src/web/public/app.js`) and becomes eight `<script defer>` files sharing a `window.Steamtrain` namespace, with CSS split to match. Task 4 performs that split mechanically with **zero behaviour change**, so every later task restyles one module against a working app. Logic worth testing (asset manifest, deep links, telemetry math) lives in TypeScript under `src/web/` and is unit-tested; the vanilla JS render modules are verified by hand.

**Tech Stack:** TypeScript + Node HTTP server (`src/web/server.ts`), vanilla ES5-style browser JS with a `h()` DOM helper (no framework, no build step for client code), esbuild for the two shared bundles, vitest for tests, biome for lint/format.

**Spec:** `docs/superpowers/specs/2026-07-28-web-ui-console-design.md`. Read it before starting — this plan implements it and does not restate its rationale.

## Global Constraints

- Client render modules are **vanilla browser JS**, ES2020-compatible, no imports, no framework. Each attaches to `window.Steamtrain`. Load order is guaranteed by `<script defer>` in manifest order.
- No new runtime dependencies. `package.json` dependencies stay as they are.
- Dark theme only. The page already declares `<meta name="color-scheme" content="dark">`.
- Content Security Policy forbids inline scripts. Everything ships as an external `/static/*` asset. Never add an inline `<script>` or `onclick` attribute.
- Fonts: IBM Plex Sans and IBM Plex Mono only. **Space Grotesk is removed** — no `--font-display`, no Space Grotesk in the Google Fonts URL.
- Every numeric readout uses `font-variant-numeric: tabular-nums`.
- Run `npm run lint` and `npm run typecheck` before every commit. Biome formats with `npm run format`.
- Tests run unsandboxed: `npm test` (the sandbox blocks the servers' `listen`).
- Commit messages: no `Co-Authored-By` trailers.

## Exact token values

Every task that writes CSS uses these. Copy verbatim.

```css
:root {
  --canvas: #0c0e11;
  --surface: #0e1114;
  --header: #101317;
  --raised: #14181d;
  --well: #080a0c;

  --border: #232830;
  --border-quiet: #1b1f25;
  --border-strong: #2f3742;

  --text: #e6eaef;
  --muted: #98a2af;
  --dim: #6c7784;
  --faint: #3a424d;

  --accent: #34d3c4;
  --accent-bright: #7eefe4;
  --accent-dim: #1c6f68;

  --running: #4aa3ff;
  --running-text: #9ecbff;
  --done: #3fb950;
  --done-text: #6ed67a;
  --gate: #d29922;
  --error: #f85149;
  --error-text: #f0837e;

  --kind-worker: #6fb1ff;        --kind-worker-text: #8fb6e0;
  --kind-consolidator: #5fe0c6;  --kind-consolidator-text: #7fdccb;
  --kind-distributor: #c9a0ff;   --kind-distributor-text: #b9a3dd;
  --kind-gate: #d29922;          --kind-gate-text: #d9b45a;
  --kind-command: #8d9aab;       --kind-command-text: #98a2af;
  --kind-llm: #f0a37e;           --kind-llm-text: #d9a184;

  --r-xs: 4px; --r-sm: 5px; --r-md: 6px; --r-lg: 8px; --r-xl: 10px;

  --font-ui: "IBM Plex Sans", "Helvetica Neue", "Segoe UI", sans-serif;
  --font-mono: "IBM Plex Mono", "SF Mono", "Menlo", "Consolas", monospace;
}
```

**Step-row grid** (used in Task 6, and nowhere else — do not redefine it):

```css
grid-template-columns: 14px 150px 96px 168px 1fr 62px 68px 92px 20px;
gap: 12px;
padding: 7px 18px;
```
Columns in order: status dot · step id · kind chip · agent·model · meta · time · cost · tokens · chevron.

**Fixed dimensions:** header 46px tall · left rail 236px · right rail 300px · arrival ledger column 420px.

---

## Task 1: Asset manifest

Replaces the four hard-coded asset fields with one ordered manifest, so Task 4 can add thirteen files without touching the server. Pure refactor — the served page is byte-identical apart from nothing at all.

**Files:**
- Modify: `src/web/html.ts:29-38` (`PageAssetRevisions`), `src/web/html.ts:46-63` (`renderIndex` head), `src/web/html.ts:148-150` (script tags)
- Modify: `src/web/server.ts:98-107` (`resolvePublicDir`), `src/web/server.ts:136-154` (`STATIC_ASSETS`, `PUBLIC_REVISIONS`)
- Test: `tests/web-assets.test.ts` (create), `tests/web-server.test.ts:225-310` (update)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `WEB_ASSETS: readonly WebAsset[]` and `type PageAssetRevisions = Record<string, string>` exported from `src/web/html.ts`. Task 4 appends entries to `WEB_ASSETS`; nothing else in the plan touches it.

- [ ] **Step 1: Write the failing test**

Create `tests/web-assets.test.ts`:

```ts
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WEB_ASSETS, renderIndex } from "../src/web/html";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public");

describe("web asset manifest", () => {
  it("lists only files that exist on disk", () => {
    const missing = WEB_ASSETS.filter((a) => !existsSync(join(PUBLIC_DIR, a.file)));
    expect(missing.map((a) => a.file)).toEqual([]);
  });

  it("has no duplicate entries", () => {
    const files = WEB_ASSETS.map((a) => a.file);
    expect(new Set(files).size).toBe(files.length);
  });

  it("emits every asset in manifest order with its revision", () => {
    const revs = Object.fromEntries(WEB_ASSETS.map((a) => [a.file, `rev-${a.file}`]));
    const html = renderIndex(revs);
    const positions = WEB_ASSETS.map((a) => html.indexOf(`/static/${a.file}?v=rev-${a.file}`));
    expect(positions.some((p) => p === -1)).toBe(false);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("emits stylesheets as links and scripts as deferred script tags", () => {
    const revs = Object.fromEntries(WEB_ASSETS.map((a) => [a.file, "v"]));
    const html = renderIndex(revs);
    for (const asset of WEB_ASSETS) {
      const url = `/static/${asset.file}?v=v`;
      if (asset.kind === "css") expect(html).toContain(`<link rel="stylesheet" href="${url}" />`);
      else expect(html).toContain(`<script src="${url}" defer></script>`);
    }
  });

  it("does not request Space Grotesk", () => {
    const revs = Object.fromEntries(WEB_ASSETS.map((a) => [a.file, "v"]));
    expect(renderIndex(revs)).not.toContain("Space+Grotesk");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/web-assets.test.ts`
Expected: FAIL — `WEB_ASSETS` is not exported from `../src/web/html`.

- [ ] **Step 3: Add the manifest to `src/web/html.ts`**

Replace the `PageAssetRevisions` interface (lines 29-38) with:

```ts
export interface WebAsset {
  /** Filename inside `src/web/public/`, also its `/static/<file>` URL. */
  file: string;
  kind: "css" | "js";
  mime: string;
}

/**
 * Every static asset the page loads, in load order. Stylesheets are emitted as
 * `<link>` in `<head>`; scripts as `<script defer>` at the end of `<body>`,
 * which is what guarantees execution order for the client modules (they share a
 * `window.Steamtrain` namespace and have no module loader).
 *
 * `src/web/server.ts` builds its `/static/*` route table from this same list,
 * so adding a file here is the only step needed to ship it.
 */
export const WEB_ASSETS: readonly WebAsset[] = [
  { file: "app.css", kind: "css", mime: "text/css; charset=utf-8" },
  { file: "steamtrain-reducer.bundle.js", kind: "js", mime: "text/javascript; charset=utf-8" },
  { file: "steamtrain-diff.bundle.js", kind: "js", mime: "text/javascript; charset=utf-8" },
  { file: "app.js", kind: "js", mime: "text/javascript; charset=utf-8" },
];

/** Content-hash revision per asset filename, e.g. `{ "app.css": "a1b2…" }`. */
export type PageAssetRevisions = Record<string, string>;
```

- [ ] **Step 4: Emit the tags from the manifest**

In `renderIndex`, delete the four `const …Href/Src` lines and build the tag strings instead:

```ts
export function renderIndex(revs: PageAssetRevisions): string {
  const url = (file: string) => `/static/${file}?v=${revs[file] ?? ""}`;
  const styles = WEB_ASSETS.filter((a) => a.kind === "css")
    .map((a) => `<link rel="stylesheet" href="${url(a.file)}" />`)
    .join("\n");
  const scripts = WEB_ASSETS.filter((a) => a.kind === "js")
    .map((a) => `<script src="${url(a.file)}" defer></script>`)
    .join("\n");
```

In the returned template, replace the single stylesheet `<link>` with `${styles}` and the three `<script>` lines with `${scripts}`. Change the Google Fonts URL to drop Space Grotesk:

```
https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap
```

Update `PAGE_HTML` at the bottom of the file:

```ts
export const PAGE_HTML = renderIndex(Object.fromEntries(WEB_ASSETS.map((a) => [a.file, "dev"])));
```

- [ ] **Step 5: Build the server's route table from the manifest**

In `src/web/server.ts`, import `WEB_ASSETS` alongside the existing html imports, then replace `STATIC_ASSETS` and `PUBLIC_REVISIONS` (lines 136-154) with:

```ts
const STATIC_ASSETS: Record<string, StaticAsset | null> = Object.fromEntries(
  WEB_ASSETS.map((a) => [`/static/${a.file}`, loadAsset(a.file, a.mime)]),
);

const PUBLIC_REVISIONS: PageAssetRevisions = Object.fromEntries(
  WEB_ASSETS.map((a) => [a.file, STATIC_ASSETS[`/static/${a.file}`]?.rev ?? ""]),
);
```

`publicAssetsLoaded()` and `missingPublicAssets()` iterate `STATIC_ASSETS` and need no change.

- [ ] **Step 6: Make `resolvePublicDir` probe a stable file**

`resolvePublicDir` (line 98-107) probes for `app.js`, which Task 4 deletes. Probe the first manifest entry instead, and update the comment:

```ts
function resolvePublicDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "public"), resolve(here, "..", "web", "public")];
  // Probe the first manifest asset — whatever the client is split into, the
  // manifest's head is always present in a correctly built tree.
  const probe = WEB_ASSETS[0]!.file;
  for (const candidate of candidates) {
    if (existsSync(join(candidate, probe))) return candidate;
  }
  return candidates[0]!;
}
```

- [ ] **Step 7: Run the new test**

Run: `npm test -- tests/web-assets.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 8: Update `web-server.test.ts` to assert against the manifest**

In `tests/web-server.test.ts`, the "serves the SPA page" test (around line 225) and the immutable-caching test (around line 257) name `app.js` / `app.css` literally. Replace the literal names with a manifest-driven loop, e.g. in the caching test:

```ts
for (const asset of WEB_ASSETS) {
  const res = await fetch(`${base}/static/${asset.file}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(res.headers.get("content-type")).toBe(asset.mime);
  const body = await res.text();
  const rev = createHash("sha256").update(body).digest("hex").slice(0, 16);
  expect(html).toContain(`/static/${asset.file}?v=${rev}`);
}
```

Import `WEB_ASSETS` from `../src/web/html` at the top. Keep the 404 test and the no-auth test as they are, but change the no-auth test's two literal fetches to `WEB_ASSETS[0]!.file` and `WEB_ASSETS[WEB_ASSETS.length - 1]!.file`.

- [ ] **Step 9: Run the full web suite**

Run: `npm test -- tests/web-server.test.ts tests/web-assets.test.ts`
Expected: PASS.

- [ ] **Step 10: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add src/web/html.ts src/web/server.ts tests/web-assets.test.ts tests/web-server.test.ts
git commit -m "refactor(web): drive static assets from one ordered manifest"
```

---

## Task 2: Settings deep links

**Files:**
- Modify: `src/web/run-deep-link.ts`
- Modify: `src/web/reducer.ts:26-27` (export the new symbols into the browser bundle)
- Test: `tests/web-deep-link.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Route = { kind: "run"; runId: string; stepId?: string } | { kind: "settings"; section: string }`
  - `parseRoute(hash: string): Route | null`
  - `settingsDeepLink(section?: string): string`
  - `SETTINGS_SECTIONS: readonly string[]` — `["runners", "limits"]`
  - Existing `parseDeepLink`, `parseRunDeepLink`, `runDeepLink`, `approvalDeepLink` keep their current signatures and behaviour. Task 9 calls `parseRoute` and `settingsDeepLink`.

- [ ] **Step 1: Write the failing test**

Create `tests/web-deep-link.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  SETTINGS_SECTIONS,
  parseDeepLink,
  parseRoute,
  parseRunDeepLink,
  settingsDeepLink,
} from "../src/web/run-deep-link";

const RUN = "8f21c0de-1a2b-4c3d-8e4f-5a6b7c8d9e0f";

describe("parseRoute", () => {
  it("parses a run link", () => {
    expect(parseRoute(`#run-${RUN}`)).toEqual({ kind: "run", runId: RUN, stepId: undefined });
  });

  it("parses a run link with a step", () => {
    expect(parseRoute(`#run-${RUN}/step/cross-check`)).toEqual({
      kind: "run",
      runId: RUN,
      stepId: "cross-check",
    });
  });

  it("parses bare #settings as the first section", () => {
    expect(parseRoute("#settings")).toEqual({ kind: "settings", section: "runners" });
  });

  it("parses an explicit settings section", () => {
    expect(parseRoute("#settings/limits")).toEqual({ kind: "settings", section: "limits" });
  });

  it("is case-insensitive on the section", () => {
    expect(parseRoute("#Settings/Limits")).toEqual({ kind: "settings", section: "limits" });
  });

  it("falls back to the first section for an unknown one", () => {
    expect(parseRoute("#settings/does-not-exist")).toEqual({ kind: "settings", section: "runners" });
  });

  it("returns null for anything else", () => {
    expect(parseRoute("")).toBeNull();
    expect(parseRoute("#")).toBeNull();
    expect(parseRoute("#run-not-a-uuid")).toBeNull();
    expect(parseRoute("#settingsish")).toBeNull();
  });
});

describe("settingsDeepLink", () => {
  it("defaults to the first section", () => {
    expect(settingsDeepLink()).toBe("#settings/runners");
  });

  it("round-trips through parseRoute for every known section", () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(parseRoute(settingsDeepLink(section))).toEqual({ kind: "settings", section });
    }
  });
});

describe("existing run helpers are unchanged", () => {
  it("still parses run links", () => {
    expect(parseRunDeepLink(`#run-${RUN}`)).toBe(RUN);
    expect(parseDeepLink(`#run-${RUN}/step/s1`)).toEqual({ runId: RUN, stepId: "s1" });
  });

  it("still returns null for a settings link", () => {
    expect(parseRunDeepLink("#settings")).toBeNull();
    expect(parseDeepLink("#settings")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/web-deep-link.test.ts`
Expected: FAIL — `parseRoute` is not exported.

- [ ] **Step 3: Implement in `src/web/run-deep-link.ts`**

Append to the existing file (do not modify the existing four functions):

```ts
/**
 * Settings sections that have a real config API behind them, in nav order. The
 * design draws seven; the five without an API (model bindings, permissions,
 * access & sharing, notifications, cache & worktrees) are deliberately absent
 * rather than rendered as dead tabs. See the design spec §6.
 */
export const SETTINGS_SECTIONS = ["runners", "limits"] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export type Route =
  | { kind: "run"; runId: string; stepId?: string }
  | { kind: "settings"; section: SettingsSection };

/** Parse any recognised hash route. Returns null when the hash is not one. */
export function parseRoute(hash: string): Route | null {
  const run = parseDeepLink(hash);
  if (run) return { kind: "run", runId: run.runId, stepId: run.stepId };
  const match = /^#settings(?:\/([\w-]+))?$/i.exec(hash.trim());
  if (!match) return null;
  const raw = (match[1] ?? "").toLowerCase();
  const section = (SETTINGS_SECTIONS as readonly string[]).includes(raw)
    ? (raw as SettingsSection)
    : SETTINGS_SECTIONS[0];
  return { kind: "settings", section };
}

export function settingsDeepLink(section: SettingsSection = SETTINGS_SECTIONS[0]): string {
  return `#settings/${section}`;
}
```

- [ ] **Step 4: Export into the browser bundle**

In `src/web/reducer.ts`, extend the existing deep-link export block:

```ts
export {
  parseRunDeepLink,
  runDeepLink,
  approvalDeepLink,
  parseDeepLink,
  parseRoute,
  settingsDeepLink,
  SETTINGS_SECTIONS,
} from "./run-deep-link";
export type { DeepLink, Route, SettingsSection } from "./run-deep-link";
```

- [ ] **Step 5: Run tests**

Run: `npm test -- tests/web-deep-link.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Rebuild the bundle and verify the symbols land**

```bash
bun scripts/build-reducer.ts
grep -c "parseRoute" src/web/public/steamtrain-reducer.bundle.js
```
Expected: a non-zero count.

- [ ] **Step 7: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add src/web/run-deep-link.ts src/web/reducer.ts src/web/public/steamtrain-reducer.bundle.js tests/web-deep-link.test.ts
git commit -m "feat(web): add settings hash routes"
```

---

## Task 3: Derived telemetry

The two rail instruments with no data behind them. Written in TypeScript, unit-tested, exported into the reducer bundle for the client — following the existing precedent of sharing helpers with the browser.

**Files:**
- Create: `src/web/telemetry.ts`
- Modify: `src/web/reducer.ts` (append an export block)
- Test: `tests/web-telemetry.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces (Task 7 consumes all of these):
  - `createThroughputMeter(windowMs?: number): ThroughputMeter`
  - `ThroughputMeter` with `sample(totalTokens: number, nowMs: number): void` and `bars(count: number): number[]` returning `count` values in `0..1`, oldest first
  - `projectCost(input: { spentUsd: number; completedSteps: number; totalSteps: number }): number | null`

- [ ] **Step 1: Write the failing test**

Create `tests/web-telemetry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createThroughputMeter, projectCost } from "../src/web/telemetry";

describe("projectCost", () => {
  it("scales spend by the ratio of total to completed steps", () => {
    expect(projectCost({ spentUsd: 0.04, completedSteps: 3, totalSteps: 6 })).toBeCloseTo(0.08, 6);
  });

  it("returns the spend itself once every step is done", () => {
    expect(projectCost({ spentUsd: 0.0714, completedSteps: 6, totalSteps: 6 })).toBeCloseTo(0.0714, 6);
  });

  it("returns null before any step completes", () => {
    expect(projectCost({ spentUsd: 0, completedSteps: 0, totalSteps: 6 })).toBeNull();
  });

  it("returns null when there are no steps at all", () => {
    expect(projectCost({ spentUsd: 0, completedSteps: 0, totalSteps: 0 })).toBeNull();
  });

  it("never projects below what has already been spent", () => {
    expect(projectCost({ spentUsd: 0.5, completedSteps: 8, totalSteps: 6 })).toBeCloseTo(0.5, 6);
  });
});

describe("createThroughputMeter", () => {
  it("reports no throughput from a single sample", () => {
    const meter = createThroughputMeter(60_000);
    meter.sample(1000, 0);
    expect(meter.bars(4)).toEqual([0, 0, 0, 0]);
  });

  it("normalises bars against the busiest interval", () => {
    const meter = createThroughputMeter(60_000);
    meter.sample(0, 0);
    meter.sample(100, 1000);
    meter.sample(300, 2000);
    const bars = meter.bars(2);
    expect(bars).toHaveLength(2);
    expect(bars[1]).toBeCloseTo(1, 6);
    expect(bars[0]).toBeCloseTo(0.5, 6);
  });

  it("drops samples older than the window", () => {
    const meter = createThroughputMeter(10_000);
    meter.sample(0, 0);
    meter.sample(500, 1000);
    meter.sample(600, 100_000);
    expect(meter.bars(2).every((b) => b >= 0 && b <= 1)).toBe(true);
  });

  it("pads with leading zeros when there is less history than bars", () => {
    const meter = createThroughputMeter(60_000);
    meter.sample(0, 0);
    meter.sample(50, 1000);
    const bars = meter.bars(5);
    expect(bars).toHaveLength(5);
    expect(bars.slice(0, 4)).toEqual([0, 0, 0, 0]);
  });

  it("ignores a token total that goes backwards", () => {
    const meter = createThroughputMeter(60_000);
    meter.sample(500, 0);
    meter.sample(100, 1000);
    expect(meter.bars(2).every((b) => b >= 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/web-telemetry.test.ts`
Expected: FAIL — cannot resolve `../src/web/telemetry`.

- [ ] **Step 3: Implement `src/web/telemetry.ts`**

```ts
/**
 * Client-side telemetry the engine does not record.
 *
 * The run event stream carries per-step cost and token totals but no rate and
 * no forecast, so the Console's instrument rail derives both here. Kept as pure
 * functions in TypeScript (rather than inline in the vanilla client) so they
 * are unit-testable and shared through the reducer bundle.
 */

export interface ThroughputSample {
  atMs: number;
  totalTokens: number;
}

export interface ThroughputMeter {
  /**
   * Record the run's cumulative token total at a point in time. Safe to call on
   * a fixed tick; samples older than the window are discarded. A total that
   * goes backwards (a reset between runs) contributes no throughput.
   */
  sample(totalTokens: number, nowMs: number): void;
  /**
   * `count` bar heights in 0..1, oldest first, normalised against the busiest
   * interval in the window. Returns all zeros when there is nothing to show, so
   * a caller can render the sparkline unconditionally.
   */
  bars(count: number): number[];
}

const DEFAULT_WINDOW_MS = 60_000;

export function createThroughputMeter(windowMs: number = DEFAULT_WINDOW_MS): ThroughputMeter {
  const samples: ThroughputSample[] = [];

  return {
    sample(totalTokens: number, nowMs: number): void {
      samples.push({ atMs: nowMs, totalTokens });
      while (samples.length > 1 && nowMs - samples[0]!.atMs > windowMs) samples.shift();
    },

    bars(count: number): number[] {
      if (count <= 0) return [];
      const empty = new Array<number>(count).fill(0);
      if (samples.length < 2) return empty;

      // Tokens per second across each adjacent pair of samples.
      const rates: number[] = [];
      for (let i = 1; i < samples.length; i++) {
        const prev = samples[i - 1]!;
        const cur = samples[i]!;
        const seconds = (cur.atMs - prev.atMs) / 1000;
        const delta = cur.totalTokens - prev.totalTokens;
        rates.push(seconds > 0 && delta > 0 ? delta / seconds : 0);
      }

      const recent = rates.slice(-count);
      const peak = Math.max(...recent);
      if (peak <= 0) return empty;

      const scaled = recent.map((r) => r / peak);
      return [...new Array<number>(count - scaled.length).fill(0), ...scaled];
    },
  };
}

/**
 * Estimated total spend: what has been spent, scaled by how much of the run
 * remains. A heuristic, and deliberately labelled as one in the UI — it assumes
 * the remaining steps cost about what the finished ones did, which is wrong for
 * workflows whose steps differ greatly (a cheap gate after an expensive scan).
 *
 * Returns null when there is nothing to extrapolate from, so the caller renders
 * a dash rather than a fabricated zero. Never returns less than actual spend.
 */
export function projectCost(input: {
  spentUsd: number;
  completedSteps: number;
  totalSteps: number;
}): number | null {
  const { spentUsd, completedSteps, totalSteps } = input;
  if (completedSteps <= 0 || totalSteps <= 0) return null;
  return Math.max(spentUsd, (spentUsd / completedSteps) * totalSteps);
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/web-telemetry.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Export into the browser bundle**

Append to `src/web/reducer.ts`:

```ts
export { createThroughputMeter, projectCost } from "./telemetry";
export type { ThroughputMeter, ThroughputSample } from "./telemetry";
```

- [ ] **Step 6: Rebuild and verify**

```bash
bun scripts/build-reducer.ts
grep -c "createThroughputMeter" src/web/public/steamtrain-reducer.bundle.js
```
Expected: non-zero.

- [ ] **Step 7: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add src/web/telemetry.ts src/web/reducer.ts src/web/public/steamtrain-reducer.bundle.js tests/web-telemetry.test.ts
git commit -m "feat(web): derive throughput and projected cost client-side"
```

---

## Task 4: Split the client (no behaviour change)

The pivot of the plan. `app.js` (6,103 lines) and `app.css` (4,764 lines) are cut into the target files **by moving code, not rewriting it**. The app must look and behave identically when this task ends — that is the whole point, and it is what makes Tasks 5-10 safe.

**Files:**
- Create: `src/web/public/st-core.js`, `st-shell.js`, `st-run.js`, `st-instruments.js`, `st-arrival.js`, `st-settings.js`, `st-modals.js`, `st-boot.js`
- Create: `src/web/public/tokens.css`, `shell.css`, `run.css`, `instruments.css`, `arrival.css`, `settings.css`, `modals.css`
- Delete: `src/web/public/app.js`, `src/web/public/app.css`
- Modify: `src/web/html.ts` (`WEB_ASSETS` entries)

**Interfaces:**
- Consumes: `WEB_ASSETS` from Task 1.
- Produces: the `window.Steamtrain` namespace. Every later task adds to it. The shape after this task:
  - `Steamtrain.state` — the `S` object, moved verbatim
  - `Steamtrain.h(tag, attrs, ...children)` — DOM helper, moved verbatim
  - `Steamtrain.api` — fetch helpers
  - `Steamtrain.render()` — top-level render, `Steamtrain.scheduleRender()`
  - `Steamtrain.shell`, `.run`, `.instruments`, `.arrival`, `.settings`, `.modals` — one object per module, each exposing the render entry points that module owns
  - `Steamtrain.start()` — boot, called by `st-boot.js`

- [ ] **Step 1: Add the new assets to the manifest**

In `src/web/html.ts`, replace the `WEB_ASSETS` array body with the full list, in this exact order (CSS order matters for the cascade; JS order matters for the namespace):

```ts
export const WEB_ASSETS: readonly WebAsset[] = [
  { file: "tokens.css", kind: "css", mime: "text/css; charset=utf-8" },
  { file: "shell.css", kind: "css", mime: "text/css; charset=utf-8" },
  { file: "run.css", kind: "css", mime: "text/css; charset=utf-8" },
  { file: "instruments.css", kind: "css", mime: "text/css; charset=utf-8" },
  { file: "arrival.css", kind: "css", mime: "text/css; charset=utf-8" },
  { file: "settings.css", kind: "css", mime: "text/css; charset=utf-8" },
  { file: "modals.css", kind: "css", mime: "text/css; charset=utf-8" },
  { file: "steamtrain-reducer.bundle.js", kind: "js", mime: "text/javascript; charset=utf-8" },
  { file: "steamtrain-diff.bundle.js", kind: "js", mime: "text/javascript; charset=utf-8" },
  { file: "st-core.js", kind: "js", mime: "text/javascript; charset=utf-8" },
  { file: "st-shell.js", kind: "js", mime: "text/javascript; charset=utf-8" },
  { file: "st-run.js", kind: "js", mime: "text/javascript; charset=utf-8" },
  { file: "st-instruments.js", kind: "js", mime: "text/javascript; charset=utf-8" },
  { file: "st-arrival.js", kind: "js", mime: "text/javascript; charset=utf-8" },
  { file: "st-settings.js", kind: "js", mime: "text/javascript; charset=utf-8" },
  { file: "st-modals.js", kind: "js", mime: "text/javascript; charset=utf-8" },
  { file: "st-boot.js", kind: "js", mime: "text/javascript; charset=utf-8" },
];
```

- [ ] **Step 2: Create the namespace in `st-core.js`**

The file opens the namespace and holds everything the other modules share. Move — do not retype — from `app.js`: the `S` state object, `h()`, the fetch/API helpers, the SSE wiring, `reduce()`, `scheduleRender()`, `resolvePendingStepDeepLink()`, the formatters, and the `// ---- utils ----` block (`app.js:5728`).

```js
/**
 * Shared state, DOM helpers, API access, and the event stream.
 *
 * Every st-*.js file attaches to the `window.Steamtrain` namespace this file
 * creates. Load order is guaranteed by `<script defer>` in WEB_ASSETS order
 * (src/web/html.ts) — this file must stay first among the st-* scripts.
 */
window.Steamtrain = (function () {
  "use strict";

  var S = { /* … moved verbatim from app.js … */ };

  function h(tag, attrs) { /* … moved verbatim … */ }

  return {
    state: S,
    h: h,
    // filled in by the modules that load after this one
    shell: null, run: null, instruments: null,
    arrival: null, settings: null, modals: null,
  };
})();
```

- [ ] **Step 3: Move the render modules**

Each remaining `st-*.js` follows the same shape — an IIFE that reads the namespace and attaches its own object:

```js
(function (ST) {
  "use strict";
  var h = ST.h;
  var S = ST.state;

  // … functions moved from app.js …

  ST.shell = {
    renderHeader: renderHeader,
    renderSidebar: renderSidebar,
    renderHealth: renderHealth,
    renderLiveRuns: renderLiveRuns,
  };
})(window.Steamtrain);
```

Move functions to files by owner:

| file | functions moved from `app.js` |
|---|---|
| `st-shell.js` | `renderSidebar` (1599), `renderWorkflowCard` (1658), `renderHealth` (1367), `renderLiveRuns` (536), `renderBlockedRow` (1272), `renderSourceLine` (1891) |
| `st-run.js` | `renderCard` (2947), `renderLegendOrTrack` (2866), `renderTrackStrip` (2902), `renderNarration` (2309), `renderParamsForm` (1927), `renderDetail` (3233), `renderApproval` (3379), `renderHumanInput` (3431), `renderSummary` (3525), the running block (3669), prompt history (3617), staged overrides (5732), plan/dry-run (5899) |
| `st-instruments.js` | *(empty placeholder for now — Task 7 fills it)* |
| `st-arrival.js` | `renderArrival` (2555), `renderStationAtmosphere` (2137), `renderStationHero` (2173), `renderConductorStage` (2428), `renderYardTrack` (2402) — these are deleted in Task 10; parking them together now makes that deletion a single-file change |
| `st-settings.js` | `openConfigModal` (796), `renderAgentConfigRows` (820), `renderApiConfigRows` (981), `openSetupPanel` (1463), `renderBody` (1508), `renderModels` (1833) |
| `st-modals.js` | modal scaffolding (3906), create (4086), configure/clone (4209), run history (4864-5466), tool permissions (5651) |

`st-boot.js` holds the DOMContentLoaded wiring and the top-level `render()` dispatcher, and ends with `window.Steamtrain.start()`.

Where a moved function is called across a file boundary, call it through the namespace (`ST.modals.openConfigure(...)`). Do not duplicate any function into two files.

- [ ] **Step 4: Split the CSS the same way**

Move rule blocks from `app.css` by owner, preserving order within each file. `tokens.css` takes the `:root` block, the `*`/scrollbar resets, and `html, body`. The `/* ---- */` section comments already in `app.css` mark most of the seams:

| file | source sections |
|---|---|
| `tokens.css` | `:root`, resets, `html/body` (lines 1-63) |
| `shell.css` | `header` and its children, health chips (246), sidebar/runbar actions (2610), narrow-screen (4454) |
| `run.css` | run row/compose (596), sub-workflow block (2273), sandbox badges (2405), step drill-in (4262), preflight (4423), human input (4146), approval card (4067), autonomy labels (4245) |
| `instruments.css` | *(empty placeholder — Task 7 fills it)* |
| `arrival.css` | Station (729), atmosphere (909), station mode (1180), ride (1208), conductor (1278, 1415, 1432, 1491), arrival (1581, 1786, 1884) |
| `settings.css` | setup panel (2905), per-step editor (3182), nested editors (3205), retarget bar (3311), auth login (3984), reauth overlay (4658) |
| `modals.css` | modal (2667), run history (3378), diff viewer (3789), worktree rows (3936), a11y/reduced-motion (4588), announcer (4641) |

- [ ] **Step 5: Delete the old files**

```bash
git rm src/web/public/app.js src/web/public/app.css
```

- [ ] **Step 6: Verify nothing was lost**

```bash
git show HEAD:src/web/public/app.js | wc -l
cat src/web/public/st-*.js | wc -l
```
Expected: the new total is within ~100 lines of 6,103 (the difference being IIFE wrappers and namespace plumbing). A shortfall of hundreds of lines means functions were dropped — find them before continuing.

Repeat for CSS against 4,764 lines.

- [ ] **Step 7: Run the manifest and server tests**

Run: `npm test -- tests/web-assets.test.ts tests/web-server.test.ts`
Expected: PASS. The manifest test proves all seventeen files exist and are emitted in order.

- [ ] **Step 8: Verify the app still works, by hand**

```bash
npm run dev
```

Open the printed URL. Confirm, and do not proceed until all of these hold: the page paints with no console errors; the workflow list populates; selecting a workflow shows its pipeline; a run streams output; the config modal opens; the Runs history opens.

This is the gate for the whole plan. If anything is broken here, it is a move error — find it now, not three tasks later.

- [ ] **Step 9: Lint, format, commit**

```bash
npm run format && npm run lint && npm run typecheck
git add -A src/web/public src/web/html.ts
git commit -m "refactor(web): split the client into per-surface modules"
```

---

## Task 5: Tokens and shell

First task that changes how anything looks. Header, left rail, and the global surface.

**Files:**
- Modify: `src/web/public/tokens.css`, `shell.css`, `st-shell.js`
- Modify: `src/web/html.ts` (body markup)

**Interfaces:**
- Consumes: `Steamtrain.h`, `Steamtrain.state` (Task 4).
- Produces: `Steamtrain.shell.render()` renders header + rail into the static skeleton. The three-column grid `#app` is established here and Tasks 6 and 7 render into `#center` and `#rail`.

- [ ] **Step 1: Replace the token block**

Overwrite the `:root` block in `tokens.css` with the exact token list from **Global Constraints → Exact token values** above. Delete `--font-display`, `--shadow-sm`, `--shadow-md`, `--bg-elevated`, `--panel*`, `--brass`, and the old `--radius-*` names. Replace the body background:

```css
body {
  background: var(--canvas);
  color: var(--text);
  font: 14px/1.5 var(--font-ui);
  display: flex;
  flex-direction: column;
  height: 100vh;
  margin: 0;
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
}
```

- [ ] **Step 2: Replace the page skeleton**

In `src/web/html.ts`, replace everything between `<body>` and the script tags with the Console skeleton. Keep `#announcer`, `#drawer`, and `#overlay`/`#modal` exactly as they are — Task 9's survivors depend on them.

```html
<div id="app">
  <header id="topbar">
    <div class="brand"><span class="brand-mark" aria-hidden="true"></span><span class="wordmark">steamtrain</span></div>
    <nav class="crumbs" id="crumbs" aria-label="Location"></nav>
    <div class="topbar-right">
      <div class="health" id="health" role="group" aria-label="Agent health"></div>
      <button class="tbtn" id="historyBtn">Runs</button>
      <button class="tbtn" id="settingsBtn">Settings</button>
    </div>
  </header>
  <div id="cols">
    <aside id="rail-left" aria-label="Workflows"></aside>
    <section id="center"></section>
    <aside id="rail-right" aria-label="Run instruments"></aside>
  </div>
</div>
<aside class="drawer" id="drawer" role="dialog" aria-label="Step details" aria-hidden="true" tabindex="-1"></aside>
<div class="modal-overlay" id="overlay"><div class="modal" id="modal"></div></div>
<div id="announcer" class="sr-only" aria-live="polite" aria-atomic="true"></div>
```

- [ ] **Step 3: Write the shell layout CSS**

In `shell.css`, replace the old `header` rules:

```css
#app { display: flex; flex-direction: column; height: 100vh; min-height: 0; }

#topbar {
  height: 46px; flex: none; display: flex; align-items: center;
  padding: 0 14px 0 16px; gap: 0;
  border-bottom: 1px solid var(--border); background: var(--header);
}
#topbar .brand { display: flex; align-items: center; gap: 10px; width: 220px; flex: none; }
#topbar .brand-mark {
  width: 16px; height: 16px; border-radius: var(--r-xs); flex: none;
  background: var(--accent-dim); box-shadow: inset 0 0 0 1px rgba(52, 211, 196, 0.5);
}
#topbar .wordmark { font: 600 14px/1 var(--font-ui); letter-spacing: -0.01em; }
#topbar .crumbs {
  display: flex; align-items: center; gap: 8px;
  font: 400 12px/1 var(--font-mono); color: var(--muted); min-width: 0;
}
#topbar .crumbs .sep { color: var(--faint); }
#topbar .crumbs .here { color: var(--text); }
#topbar .topbar-right { margin-left: auto; display: flex; align-items: center; gap: 6px; }

.status-pill {
  display: inline-flex; align-items: center; gap: 5px; margin-left: 6px;
  padding: 2px 8px; border-radius: var(--r-xs);
  font: 600 11px/1.4 var(--font-ui);
  border: 1px solid rgba(74, 163, 255, 0.35);
  background: rgba(74, 163, 255, 0.1); color: var(--running-text);
}
.status-pill .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--running); }
.status-pill.running .dot { animation: st-pulse 1.1s ease-in-out infinite; }
.status-pill.complete {
  border-color: rgba(63, 185, 80, 0.35); background: rgba(63, 185, 80, 0.1); color: var(--done-text);
}
.status-pill.complete .dot { background: var(--done); animation: none; }
@keyframes st-pulse { 0%, 100% { opacity: 0.35 } 50% { opacity: 1 } }

.tbtn {
  border: 1px solid var(--border); background: var(--raised); color: var(--muted);
  border-radius: var(--r-md); padding: 5px 9px;
  font: 500 12px/1 var(--font-ui); cursor: pointer;
}
.tbtn:hover { color: var(--text); border-color: var(--border-strong); }

.health { display: flex; border: 1px solid var(--border); border-radius: var(--r-md); overflow: hidden; background: var(--raised); }
.health .chip {
  display: inline-flex; align-items: center; gap: 5px; padding: 4px 8px;
  border-right: 1px solid var(--border); font: 500 11px/1.4 var(--font-mono);
  color: var(--muted); background: none; border-top: 0; border-left: 0; border-bottom: 0; cursor: pointer;
}
.health .chip:last-child { border-right: 0; }
.health .chip .dot { width: 5px; height: 5px; border-radius: 50%; }
.health .chip.ready .dot { background: var(--done); }
.health .chip.auth .dot { background: var(--gate); }
.health .chip.absent { color: var(--dim); }

#cols { display: flex; flex: 1; min-height: 0; }
#rail-left { width: 236px; flex: none; border-right: 1px solid var(--border); background: var(--surface); display: flex; flex-direction: column; min-height: 0; }
#center { flex: 1; min-width: 0; display: flex; flex-direction: column; }
#rail-right { width: 300px; flex: none; border-left: 1px solid var(--border); background: var(--surface); display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
```

- [ ] **Step 4: Write the workflow rail CSS**

```css
.rail-head { display: flex; align-items: center; gap: 8px; padding: 12px 12px 8px; }
.rail-label { font: 600 10px/1 var(--font-ui); letter-spacing: 0.14em; text-transform: uppercase; color: var(--dim); }
.rail-count { margin-left: auto; font: 400 11px/1 var(--font-mono); color: var(--dim); }
.rail-add {
  border: 1px solid var(--border); background: var(--raised); color: var(--muted);
  border-radius: var(--r-sm); width: 20px; height: 20px; padding: 0;
  font: 500 13px/1 var(--font-ui); cursor: pointer;
}
.rail-add:hover { color: var(--accent); border-color: var(--border-strong); }

.wf-list { padding: 0 8px 10px; display: flex; flex-direction: column; gap: 1px; overflow-y: auto; }
.wf-row {
  display: flex; align-items: center; gap: 8px; padding: 7px 8px;
  border-radius: var(--r-md); cursor: pointer; border: 0; background: none; width: 100%; text-align: left;
}
.wf-row:hover { background: var(--raised); }
.wf-row .name { font: 400 13px/1.3 var(--font-ui); color: var(--muted); }
.wf-row .lock { margin-left: auto; font-size: 10px; color: var(--gate); }
.wf-row .counts { font: 400 10px/1 var(--font-mono); color: var(--dim); }
.wf-row .lock + .counts { margin-left: 0; }
.wf-row .name + .counts { margin-left: auto; }
.wf-row.selected { background: rgba(52, 211, 196, 0.1); box-shadow: inset 2px 0 0 var(--accent); }
.wf-row.selected .name { color: var(--text); font-weight: 500; }
.wf-group { display: flex; align-items: center; gap: 8px; margin-top: 12px; padding: 6px 8px; }

.rail-foot { margin-top: auto; border-top: 1px solid var(--border); padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.elsewhere-row { display: flex; align-items: center; gap: 7px; font: 400 11.5px/1.4 var(--font-mono); color: var(--muted); }
.elsewhere-row .dot { width: 5px; height: 5px; border-radius: 50%; flex: none; }
.elsewhere-row.detached .dot { background: var(--running); }
.elsewhere-row.awaiting .dot { background: var(--gate); }
```

- [ ] **Step 5: Rewrite `renderSidebar` and `renderHealth`**

In `st-shell.js`, rewrite the two functions against the new markup. The rail row reads `phaseCount`, `stepCount`, and `permissions` straight off the `/api/workflows` payload.

Note the lock condition: `PermissionSummary` (`src/workflow/permission-preflight.ts:173`) exposes `counts`, `agentSteps`, `unrestricted`, `blocking`, and `unenforced` — there is **no** `allReadOnly` field. "Every agent step is read-only" is `agentSteps > 0 && counts["read-only"] === agentSteps`:

```js
function allReadOnly(p) {
  return !!p && p.agentSteps > 0 && p.counts["read-only"] === p.agentSteps;
}

function workflowRow(w) {
  var row = h("button", {
    class: "wf-row" + (S.selected === w.name ? " selected" : ""),
    onClick: function () { selectWorkflow(w.name); }
  });
  row.appendChild(h("span", { class: "name", text: w.name }));
  if (allReadOnly(w.permissions)) {
    row.appendChild(h("span", { class: "lock", text: "🔒", title: "every agent step read-only" }));
  }
  row.appendChild(h("span", { class: "counts", text: w.phaseCount + "·" + w.stepCount }));
  return row;
}
```

Group rows by `w.source`: bundled first under the `Workflows` head, then a `Project` group heading with its own count. The rail footer lists detached and awaiting-approval runs from `S.liveRuns`.

`renderHealth` renders the three chips — ready / needs auth / absent — from `/api/doctor`, each a `<button>` that still opens the setup surface (Task 9 repoints it at the settings page).

- [ ] **Step 6: Verify by hand**

Run `npm run dev`. Confirm: header is 46px with the breadcrumb and health chips; left rail lists workflows with `phases·steps` and lock glyphs; selecting a workflow highlights its row; no console errors. The center pane will be unstyled — Task 6 owns it.

- [ ] **Step 7: Commit**

```bash
npm run format && npm run lint && npm run typecheck && npm test -- tests/web-server.test.ts
git add src/web/public/tokens.css src/web/public/shell.css src/web/public/st-shell.js src/web/html.ts
git commit -m "feat(web): Console tokens, header, and workflow rail"
```

---

## Task 6: Run pane — composer and phase bands

**Files:**
- Modify: `src/web/public/st-run.js`, `run.css`

**Interfaces:**
- Consumes: `Steamtrain.h`, `Steamtrain.state`, `Steamtrain.shell` (Task 5).
- Produces: `Steamtrain.run.render(container)` — renders the composer when no run is active and the phase bands when one is; `Steamtrain.run.selectStep(stepId)`.

- [ ] **Step 1: Write the run header strip CSS**

```css
.run-head {
  flex: none; padding: 12px 18px; border-bottom: 1px solid var(--border);
  background: var(--surface); display: flex; align-items: center; gap: 14px;
}
.run-head .title { font: 600 17px/1.2 var(--font-ui); letter-spacing: -0.02em; }
.run-head .origin { font: 400 11.5px/1.4 var(--font-mono); color: var(--dim); }
.run-head .scope {
  font: 400 12.5px/1.4 var(--font-ui); color: var(--muted); margin-top: 3px;
  max-width: 66ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.run-metrics { margin-left: auto; display: flex; align-items: center; gap: 16px; }
.run-clock { display: flex; flex-direction: column; gap: 4px; align-items: flex-end; }
.run-clock .row { display: flex; align-items: baseline; gap: 8px; font-variant-numeric: tabular-nums; }
.run-clock .elapsed { font: 600 20px/1 var(--font-mono); color: var(--text); letter-spacing: -0.02em; }
.run-clock .steps { font: 400 11px/1 var(--font-mono); color: var(--dim); }
.run-progress { width: 220px; height: 4px; border-radius: 2px; background: var(--border-quiet); overflow: hidden; display: flex; }
.run-progress .done { background: var(--done); }
.run-progress .live { background: var(--running); animation: st-pulse 1.6s ease-in-out infinite; }

.rbtn {
  border: 1px solid var(--border); background: var(--raised); color: var(--muted);
  border-radius: var(--r-md); height: 30px; padding: 0 11px;
  font: 500 12.5px/1 var(--font-ui); cursor: pointer;
}
.rbtn:hover { color: var(--text); border-color: var(--border-strong); }
.rbtn.danger { border-color: rgba(248, 81, 73, 0.35); background: rgba(248, 81, 73, 0.08); color: var(--error-text); }
.rbtn.danger:hover { background: rgba(248, 81, 73, 0.16); }
.rbtn.primary { border-color: rgba(52, 211, 196, 0.4); background: rgba(52, 211, 196, 0.1); color: var(--accent-bright); font-weight: 600; }
.rbtn.primary:hover { background: rgba(52, 211, 196, 0.18); }
```

- [ ] **Step 2: Write the phase band CSS**

```css
.bands { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }
.band { border-bottom: 1px solid var(--border-quiet); display: flex; flex-direction: column; }
.band.expanded { flex: 1; min-height: 0; }

.band-head { display: flex; align-items: center; gap: 10px; padding: 8px 18px; background: var(--header); }
.band-head .idx { font: 500 11px/1 var(--font-mono); color: var(--dim); }
.band-head .dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--faint); }
.band-head .title { font: 600 13px/1.3 var(--font-ui); letter-spacing: -0.01em; }
.band-head .count { font: 400 11.5px/1 var(--font-mono); color: var(--dim); }
.band-head .rollup { margin-left: auto; font: 400 11.5px/1 var(--font-mono); color: var(--muted); font-variant-numeric: tabular-nums; }
.band.done .band-head .dot { background: var(--done); }
.band.running .band-head .dot { background: var(--running); animation: st-pulse 1.1s ease-in-out infinite; }
.band.running .band-head .rollup { color: var(--running); }
.band.queued .band-head .title { font-weight: 500; color: var(--muted); }

.step-row {
  display: grid;
  grid-template-columns: 14px 150px 96px 168px 1fr 62px 68px 92px 20px;
  gap: 12px; padding: 7px 18px; align-items: center;
  border-top: 1px solid var(--border-quiet);
  font: 400 12px/1.4 var(--font-mono); color: var(--muted);
  cursor: pointer; background: none; border-left: 0; border-right: 0; border-bottom: 0; width: 100%; text-align: left;
}
.step-row:hover { background: #12161a; }
.step-row .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); }
.step-row.done .dot { background: var(--done); }
.step-row.failed .dot { background: var(--error); }
.step-row.running { background: rgba(74, 163, 255, 0.06); box-shadow: inset 2px 0 0 var(--running); }
.step-row.running .dot { background: var(--running); box-shadow: 0 0 0 3px rgba(74, 163, 255, 0.18); }
.step-row .id { color: var(--text); font-weight: 500; }
.step-row .meta { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.step-row .num { text-align: right; font-variant-numeric: tabular-nums; }
.step-row .tok { color: var(--dim); }
.step-row .chev { color: var(--faint); text-align: center; }
.step-row.running .num.time { color: var(--running); }
.step-row .meta .cached { color: var(--gate); }

.kind { display: inline-flex; align-items: center; gap: 5px; }
.kind .rule { width: 8px; height: 2px; border-radius: 1px; background: var(--kind-command); }
.kind .label { font: 500 10.5px/1 var(--font-ui); letter-spacing: 0.08em; text-transform: uppercase; color: var(--kind-command-text); }
.kind.worker .rule { background: var(--kind-worker); } .kind.worker .label { color: var(--kind-worker-text); }
.kind.consolidator .rule { background: var(--kind-consolidator); } .kind.consolidator .label { color: var(--kind-consolidator-text); }
.kind.distributor .rule { background: var(--kind-distributor); } .kind.distributor .label { color: var(--kind-distributor-text); }
.kind.gate .rule { background: var(--kind-gate); } .kind.gate .label { color: var(--kind-gate-text); }
.kind.llm .rule { background: var(--kind-llm); } .kind.llm .label { color: var(--kind-llm-text); }
```

- [ ] **Step 3: Write the live output pane CSS**

```css
.output {
  flex: 1; min-height: 0; background: var(--well);
  border-top: 1px solid var(--border-quiet); display: flex; flex-direction: column;
}
.output-head { display: flex; align-items: center; gap: 10px; padding: 6px 18px; border-bottom: 1px solid var(--raised); }
.output-head .label { font: 500 10px/1 var(--font-ui); letter-spacing: 0.14em; text-transform: uppercase; color: var(--dim); }
.output-head .following { font: 400 11px/1 var(--font-mono); color: var(--running); }
.output-head .actions { margin-left: auto; display: flex; gap: 6px; }
.output-head .obtn {
  border: 1px solid var(--border); background: var(--raised); color: var(--muted);
  border-radius: var(--r-sm); padding: 3px 8px; font: 500 11px/1.4 var(--font-ui); cursor: pointer;
}
.output-head .obtn:hover { color: var(--text); }
.output-body {
  flex: 1; min-height: 0; overflow-y: auto; padding: 10px 18px;
  font: 400 12.5px/1.65 var(--font-mono); color: #b9c4d0; white-space: pre-wrap;
}
.output-body.nowrap { white-space: pre; overflow-x: auto; }
```

- [ ] **Step 4: Render the bands**

In `st-run.js`, replace `renderCard`/`renderLegendOrTrack`/`renderTrackStrip` with a band renderer. One band per `PhaseState`; exactly one expanded — the running phase, or the phase owning `S.selectedStepId`:

```js
function expandedPhaseId(phases) {
  if (S.selectedStepId) {
    for (var i = 0; i < phases.length; i++) {
      var steps = phases[i].steps || [];
      for (var j = 0; j < steps.length; j++) {
        if (steps[j].stepId === S.selectedStepId) return phases[i].phaseId;
      }
    }
  }
  for (var k = 0; k < phases.length; k++) {
    if (!phases[k].done && (phases[k].steps || []).some(isRunning)) return phases[k].phaseId;
  }
  return null;
}

function bandClass(phase) {
  if (phase.done) return "band done";
  if ((phase.steps || []).some(isRunning)) return "band running";
  return "band queued";
}
```

A band header shows the 2-digit index, dot, title, `N steps parallel` when `stepCount > 1`, and the rollup `time · cost · tokens` summed over its steps. A queued band renders its header only — no step rows.

Step rows fill the nine columns in order. `meta` concatenates, ` · `-separated and in this order: the worktree branch (prefixed `⎇ `), item label, `cached` in a `.cached` span, and `N tries` when `attempts > 1`. Numbers use the existing formatters from `st-core.js`; `—` where a value is absent.

- [ ] **Step 5: Render the composer for the idle state**

When `!S.runState || !S.runState.started`, the pane renders the composer instead of bands: the workflow description, `renderParamsForm(spec)` (moved unchanged in Task 4), the Describe textarea with its `↑`/`↓` prompt-history recall, the fresh-cache checkbox, and Plan / Run. Reuse the existing element ids `#input`, `#planBtn`, `#runBtn`, `#freshChk` so the existing handlers and the prompt-history code keep working untouched.

- [ ] **Step 6: Verify by hand**

Run `npm run dev` and run a bundled workflow (`bug-hunt` against a small scope). Confirm: composer shows when idle and is replaced by bands on run; the running phase expands and streams output while others stay collapsed; queued phases are single lines; clicking a row opens the drill-in drawer; Pause / Detach / Cancel work.

- [ ] **Step 7: Commit**

```bash
npm run format && npm run lint && npm run typecheck
git add src/web/public/st-run.js src/web/public/run.css
git commit -m "feat(web): phase bands and live output pane"
```

---

## Task 7: Instrument rail

**Files:**
- Modify: `src/web/public/st-instruments.js`, `instruments.css`

**Interfaces:**
- Consumes: `createThroughputMeter`, `projectCost` from `SteamtrainReducer` (Task 3); `Steamtrain.state`.
- Produces: `Steamtrain.instruments.render(container)`, `Steamtrain.instruments.onEvent(ev)` — called from the SSE handler in `st-core.js` to append to the event log.

- [ ] **Step 1: Write the rail CSS**

```css
.inst { padding: 12px 14px 10px; border-bottom: 1px solid var(--border-quiet); }
.inst-label { font: 600 10px/1 var(--font-ui); letter-spacing: 0.14em; text-transform: uppercase; color: var(--dim); margin-bottom: 10px; }
.inst-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.inst-head .inst-label { margin-bottom: 0; }
.inst-head .note { margin-left: auto; font: 400 11px/1 var(--font-mono); color: var(--muted); }

.spend-now { display: flex; align-items: baseline; gap: 8px; font-variant-numeric: tabular-nums; }
.spend-now .amount { font: 500 26px/1 var(--font-mono); letter-spacing: -0.03em; color: var(--text); }
.spend-now .budget { font: 400 12px/1 var(--font-mono); color: var(--dim); }
.spend-bar { height: 4px; border-radius: 2px; background: var(--border-quiet); margin-top: 9px; overflow: hidden; }
.spend-bar span { display: block; height: 100%; background: var(--done); }
.spend-bar.warn span { background: var(--gate); }
.spend-bar.over span { background: var(--error); }
.spend-cells { display: flex; gap: 18px; margin-top: 11px; }
.spend-cells .k { font: 400 10.5px/1 var(--font-ui); letter-spacing: 0.1em; text-transform: uppercase; color: var(--dim); margin-bottom: 4px; }
.spend-cells .v { font: 500 13px/1 var(--font-mono); color: var(--muted); font-variant-numeric: tabular-nums; }

.spark { display: flex; align-items: flex-end; gap: 3px; height: 44px; }
.spark span { flex: 1; border-radius: 1px; background: #1f4d47; min-height: 1px; }
.spark span.mid { background: #256058; }
.spark span.high { background: #2b7a70; }
.spark span.peak { background: var(--accent); }

.runners { display: flex; flex-direction: column; gap: 8px; }
.runner { display: flex; align-items: center; gap: 8px; font: 400 12px/1.4 var(--font-mono); color: var(--dim); }
.runner .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--border-strong); flex: none; }
.runner.busy { color: var(--text); }
.runner.busy .dot { background: var(--running); }
.runner .model { color: var(--dim); }
.runner .right { margin-left: auto; color: var(--muted); font-variant-numeric: tabular-nums; }

.worktrees { display: flex; flex-direction: column; gap: 7px; font: 400 11.5px/1.4 var(--font-mono); }
.worktree { display: flex; gap: 8px; color: var(--muted); }
.worktree .mark { color: var(--done); }
.worktree.live .mark { color: var(--running); }
.worktree .branch { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.worktree .stat { margin-left: auto; color: var(--dim); }

.eventlog { flex: 1; min-height: 0; padding: 12px 14px 14px; overflow-y: auto; border-bottom: 0; }
.eventlog .rows { display: flex; flex-direction: column; gap: 6px; font: 400 11.5px/1.45 var(--font-mono); color: var(--dim); }
.eventlog .at { color: var(--muted); }
.eventlog .cached { color: var(--gate); }
```

- [ ] **Step 2: Implement Spend**

Sum `costUsd` across results. The budget bar renders only when the running workflow's spec declares `maxCostUsd` — it is a per-workflow field, not global config, so its absence is normal:

```js
function renderSpend(spent, spec, completed, total) {
  var box = h("div", { class: "inst" });
  box.appendChild(h("div", { class: "inst-label", text: "Spend" }));
  var budget = spec && spec.maxCostUsd;
  var now = h("div", { class: "spend-now" });
  now.appendChild(h("span", { class: "amount", text: "$" + spent.toFixed(4) }));
  if (budget) now.appendChild(h("span", { class: "budget", text: "/ $" + budget.toFixed(2) + " budget" }));
  box.appendChild(now);
  if (budget) {
    var pct = Math.min(100, (spent / budget) * 100);
    var cls = "spend-bar" + (pct >= 100 ? " over" : pct >= 80 ? " warn" : "");
    var bar = h("div", { class: cls });
    bar.appendChild(h("span", { style: "width:" + pct + "%" }));
    box.appendChild(bar);
  }
  var projected = SteamtrainReducer.projectCost({
    spentUsd: spent, completedSteps: completed, totalSteps: total
  });
  box.appendChild(cells([
    ["Projected", projected === null ? "—" : "$" + projected.toFixed(3)],
    ["Tokens", fmtTokens(totalTokens())],
    ["Cache hits", cachedCount() + " / " + total]
  ]));
  return box;
}
```

- [ ] **Step 3: Implement Throughput**

One meter per run, held on `S.throughput` and reset when a run starts. Sample on a 2s interval while a run is live; stop the interval on `workflow_done`:

```js
function tickThroughput() {
  if (!S.throughput) S.throughput = SteamtrainReducer.createThroughputMeter(60000);
  S.throughput.sample(totalTokens(), Date.now());
}

function renderSpark(meter) {
  var spark = h("div", { class: "spark" });
  var bars = meter ? meter.bars(12) : new Array(12).fill(0);
  for (var i = 0; i < bars.length; i++) {
    var v = bars[i];
    var cls = v >= 0.9 ? "peak" : v >= 0.65 ? "high" : v >= 0.4 ? "mid" : "";
    spark.appendChild(h("span", { class: cls, style: "height:" + Math.max(2, v * 100) + "%" }));
  }
  return spark;
}
```

Label the instrument `Throughput` with the note `tok/s, last 60s`.

- [ ] **Step 4: Implement Runners, Worktrees, Event log**

Runners: group running steps by `agent`, showing model and elapsed for busy ones, `idle` plus a queued count for the rest. Enumerate every configured agent so idle runners still appear.

Worktrees: one row per distinct `StepState.worktree`, marked `.live` while its step runs. Render the branch without a `+N` diffstat — live diffstat is not available, and a fabricated `+0` would be a lie.

Event log: `Steamtrain.instruments.onEvent(ev)` pushes `{ atMs, text }` onto `S.eventLog`, capped at 200 entries, newest first. Timestamps are `mm:ss` relative to `S.runState.startedAt`. Format per event kind, e.g. `step_done scan-errors` with a `.cached` span appended when the result was cached.

- [ ] **Step 5: Verify by hand**

Run a workflow. Confirm: spend ticks up; the budget bar appears only for a workflow declaring `maxCostUsd`; the sparkline moves during token streaming and flattens when idle; Projected shows `—` until the first step completes; runners flip busy/idle; worktree rows appear as steps allocate; the event log fills newest-first.

- [ ] **Step 6: Commit**

```bash
npm run format && npm run lint && npm run typecheck
git add src/web/public/st-instruments.js src/web/public/instruments.css
git commit -m "feat(web): instrument rail"
```

---

## Task 8: Arrival page

**Files:**
- Modify: `src/web/public/st-arrival.js`, `arrival.css`

**Interfaces:**
- Consumes: `buildArrivalReport`, `formatArrivalHeadline`, `arrivalReceiptCards` from `SteamtrainReducer` (already exported).
- Produces: `Steamtrain.arrival.render(container)` — renders the two-column arrival into `#center` when `S.runState.done`.

- [ ] **Step 1: Write the arrival CSS**

```css
.arrival { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 420px; }
.arrival-main { min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.arrival-head { padding: 26px 32px 18px; border-bottom: 1px solid var(--border-quiet); }
.arrival-kicker { display: flex; align-items: baseline; gap: 12px; margin-bottom: 12px; }
.arrival-kicker .state { font: 600 10px/1 var(--font-ui); letter-spacing: 0.16em; text-transform: uppercase; color: var(--done); }
.arrival-kicker .state.failed { color: var(--error-text); }
.arrival-kicker .when { font: 400 11.5px/1 var(--font-mono); color: var(--dim); }
.arrival-headline { font: 600 30px/1.2 var(--font-ui); letter-spacing: -0.03em; max-width: 30ch; text-wrap: pretty; }
.arrival-stats { display: flex; gap: 28px; margin-top: 20px; align-items: flex-end; }
.arrival-stats .k { font: 400 10.5px/1 var(--font-ui); letter-spacing: 0.12em; text-transform: uppercase; color: var(--dim); margin-bottom: 6px; }
.arrival-stats .v { font: 500 17px/1 var(--font-mono); font-variant-numeric: tabular-nums; }
.arrival-stats .rule { width: 1px; align-self: stretch; background: var(--border-quiet); }
.arrival-stats .actions { margin-left: auto; display: flex; gap: 8px; }

.arrival-report { flex: 1; min-height: 0; overflow-y: auto; padding: 20px 32px 24px; }
.arrival-report-head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.arrival-report-head .rule { flex: 1; height: 1px; background: var(--border-quiet); }
.arrival-report-head .src { font: 400 11.5px/1 var(--font-mono); color: var(--dim); }
.finding { display: grid; grid-template-columns: 74px minmax(0, 1fr); gap: 16px; padding-bottom: 14px; border-bottom: 1px solid var(--border-quiet); margin-bottom: 14px; }
.finding:last-child { border-bottom: 0; margin-bottom: 0; padding-bottom: 0; }
.finding .sev { font: 600 10.5px/1.6 var(--font-ui); letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }
.finding .sev.critical { color: var(--error-text); }
.finding .sev.high { color: var(--gate); }
.finding .what { font: 500 14.5px/1.5 var(--font-ui); color: var(--text); }
.finding .what code { font-family: var(--font-mono); font-size: 13px; }
.finding .where { font: 400 12px/1.6 var(--font-mono); color: var(--dim); margin-top: 5px; }

.ledger { border-left: 1px solid var(--border); background: var(--surface); display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.ledger-head { display: flex; align-items: center; gap: 10px; padding: 13px 16px; border-bottom: 1px solid var(--border-quiet); }
.ledger-head .count { margin-left: auto; font: 400 11px/1 var(--font-mono); color: var(--dim); }
.ledger-cols, .ledger-row { display: grid; grid-template-columns: 12px minmax(0, 1fr) 54px 62px; gap: 10px; }
.ledger-cols { padding: 7px 16px; border-bottom: 1px solid var(--border-quiet); font: 400 10.5px/1 var(--font-ui); letter-spacing: 0.1em; text-transform: uppercase; color: var(--dim); }
.ledger-rows { flex: 1; min-height: 0; overflow-y: auto; }
.ledger-row { padding: 9px 16px; border-bottom: 1px solid var(--raised); font: 400 12px/1.4 var(--font-mono); align-items: center; }
.ledger-row:hover { background: #12161a; }
.ledger-row .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--done); }
.ledger-row.failed .dot { background: var(--error); }
.ledger-row .id { color: var(--text); }
.ledger-row .sub { color: var(--dim); font-size: 11px; }
.ledger-row .num { text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; }
.ledger-foot { margin-top: auto; padding: 14px 16px; border-top: 1px solid var(--border-quiet); display: flex; flex-direction: column; gap: 9px; }
.ledger-foot .row { display: flex; align-items: baseline; gap: 10px; font: 400 12px/1.4 var(--font-mono); color: var(--dim); }
.ledger-foot .row .v { margin-left: auto; color: var(--muted); }
```

- [ ] **Step 2: Render the left column**

Kicker (`Complete` / `Failed` + timestamp + duration), headline from `formatArrivalHeadline`, four stat cells (Elapsed, Cost, Tokens, Steps `N ok · M failed`), then Run again / Export. Below, the report body: render `arrivalReceiptCards` output as `.finding` rows, mapping each card's severity onto `.sev.critical` / `.sev.high` / default. Where the report has no severity structure, render the text in a single `.finding` with an empty `.sev`.

- [ ] **Step 3: Render the ledger**

One `.ledger-row` per step: status dot, id with `kind · model` beneath (plus `cached` in a `.cached` span, `passed`/`failed` for gates), then time and cost right-aligned. Footer rows: `sandbox` (`N read-only · M violations`), `worktrees` (`N merged back · M left`), `retries` (count, with the retried step id in parentheses when there is exactly one).

Both `.arrival-report` and `.ledger-rows` scroll independently — this is what fixes the 900px overflow, so verify it explicitly in Step 4.

- [ ] **Step 4: Verify by hand**

Run a workflow to completion, then resize the browser to 900px tall. Confirm: no page-level scrollbar; the report and the ledger each scroll inside their own column; totals stay visible; Run again starts a fresh run; Export downloads the report.

- [ ] **Step 5: Commit**

```bash
npm run format && npm run lint && npm run typecheck
git add src/web/public/st-arrival.js src/web/public/arrival.css
git commit -m "feat(web): arrival page with step ledger"
```

---

## Task 9: Settings page

**Files:**
- Modify: `src/web/public/st-settings.js`, `settings.css`, `st-core.js` (router)

**Interfaces:**
- Consumes: `parseRoute`, `settingsDeepLink`, `SETTINGS_SECTIONS` from `SteamtrainReducer` (Task 2).
- Produces: `Steamtrain.settings.render(container, section)`; `Steamtrain.settings.open(section)` which sets `location.hash`.

- [ ] **Step 1: Route on the hash in `st-core.js`**

Replace the existing hash handling with `parseRoute`. On `hashchange` and at boot: a `settings` route renders the settings page into `#center` and hides both rails; a `run` route restores the cockpit and resolves the run/step deep link exactly as today; `null` leaves the current view. Wire `#settingsBtn` to `Steamtrain.settings.open()` and the settings `Close` button back to the previous route (or `#` when there is none).

- [ ] **Step 2: Write the settings CSS**

```css
.settings { flex: 1; min-height: 0; display: flex; }
.settings-nav { width: 236px; flex: none; border-right: 1px solid var(--border); background: var(--surface); padding: 14px 8px; }
.settings-nav .head { font: 600 10px/1 var(--font-ui); letter-spacing: 0.14em; text-transform: uppercase; color: var(--dim); padding: 0 8px 10px; }
.settings-nav .item {
  display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: var(--r-md);
  font: 400 13px/1.3 var(--font-ui); color: var(--muted);
  cursor: pointer; border: 0; background: none; width: 100%; text-align: left;
}
.settings-nav .item:hover { background: var(--raised); }
.settings-nav .item.active { background: rgba(52, 211, 196, 0.1); box-shadow: inset 2px 0 0 var(--accent); color: var(--text); font-weight: 500; }
.settings-nav .item .count { margin-left: auto; font: 400 11px/1 var(--font-mono); color: var(--dim); }
.settings-scope { margin-top: 18px; padding: 10px; border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--header); font: 400 11.5px/1.5 var(--font-ui); color: var(--muted); }
.settings-scope code { font-family: var(--font-mono); font-size: 11px; color: var(--accent-bright); }

.settings-pane { flex: 1; min-width: 0; overflow-y: auto; padding: 24px 32px; }
.settings-head { display: flex; align-items: flex-end; gap: 16px; padding-bottom: 16px; border-bottom: 1px solid var(--border-quiet); }
.settings-head h2 { margin: 0; font: 600 22px/1.2 var(--font-ui); letter-spacing: -0.025em; }
.settings-head p { margin: 5px 0 0; font: 400 13px/1.5 var(--font-ui); color: var(--muted); max-width: 70ch; }
.settings-head .actions { margin-left: auto; display: flex; gap: 8px; }

.runner-cols, .runner-row { display: grid; grid-template-columns: 14px 150px 92px 1fr 190px 96px 72px; gap: 14px; align-items: center; }
.runner-cols { padding: 12px 4px 8px; font: 400 10.5px/1 var(--font-ui); letter-spacing: 0.12em; text-transform: uppercase; color: var(--dim); }
.runner-row { padding: 12px 4px; border-top: 1px solid var(--border-quiet); font: 400 12.5px/1.4 var(--font-mono); }
.runner-row:hover { background: var(--header); }
.runner-row .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--done); }
.runner-row .name { color: var(--text); font-weight: 500; }
.runner-row .detail { color: var(--muted); }
.runner-row .detail .sub { color: var(--dim); }
.runner-row .scope { color: var(--dim); }
.runner-row .rowacts { display: flex; gap: 8px; color: var(--dim); justify-content: flex-end; }
.runner-row .rowacts button { border: 0; background: none; color: inherit; cursor: pointer; font: inherit; padding: 0; }
.runner-row .rowacts button:hover { color: var(--text); }
.runner-row .rowacts button.del:hover { color: var(--error-text); }

.runner-group.needs-auth { border-top: 1px solid var(--border-quiet); background: rgba(210, 153, 34, 0.05); }
.runner-group.needs-auth .runner-row { border-top: 0; }
.runner-row.absent { opacity: 0.5; }
.runner-row.absent .dot { background: var(--faint); }
.runner-row .detail.warn { color: var(--gate); }
.runner-fix { display: flex; align-items: center; gap: 10px; padding: 0 4px 14px 42px; }
.runner-fix .why { font: 400 12px/1.5 var(--font-ui); color: var(--muted); }
.runner-fix code { font: 400 12px/1 var(--font-mono); color: var(--accent-bright); background: var(--well); border: 1px solid var(--border); border-radius: var(--r-sm); padding: 6px 9px; }

.settings-foot { margin-top: 24px; display: flex; align-items: center; gap: 12px; }
.settings-foot .probed { font: 400 12px/1.5 var(--font-ui); color: var(--dim); }
.settings-foot .actions { margin-left: auto; display: flex; gap: 8px; }
```

- [ ] **Step 3: Render the nav**

Two items only, from `SETTINGS_SECTIONS`: `Runners` (count `agents · endpoints`) and `Limits & budget`. Do **not** render the five sections that have no config API — that is a deliberate decision recorded in the spec, not an omission to fix. Below the nav, the scope note: edits apply to global scope by default; switching a row to project scope writes it into `./steamtrain.json`.

- [ ] **Step 4: Render the Runners table**

One row per configured agent and API from `GET /api/config` (`agents` and `apis` are already tagged with `scope`). Columns in order: status dot, name, kind (`agent`/`api`), binary-or-endpoint with version and extra args in a `.sub` span, default model, scope, edit/delete.

Status comes from `/api/doctor`. A not-ready row renders inside `.runner-group.needs-auth` followed by a `.runner-fix` strip carrying the doctor's `fixCommand`, a Copy button, and Recheck — this is what absorbs the standalone setup panel. A `binary_missing` row renders as `.runner-row.absent` with no fix strip.

Edit opens the existing row editor, moved in Task 4. Save posts the whole `agents`/`apis` arrays to `PUT /api/config`, which is what that endpoint already expects. Track dirty state and enable the footer's Discard / Save changes only when dirty.

- [ ] **Step 5: Render Limits & budget**

Step timeout and workflow timeout, both already accepted by `PUT /api/config`. Show the resolved default beneath each field (`defaultStepTimeoutSec` is in the payload) and support clearing the workflow timeout via `clearWorkflowTimeout`.

- [ ] **Step 6: Delete the config modal and setup panel**

Remove `openConfigModal` and `openSetupPanel` and their CSS now that the page replaces both. Repoint every caller — the header health chips (Task 5), the `#configBtn` that no longer exists, and any "Edit config" link inside the modals — at `Steamtrain.settings.open("runners")`.

- [ ] **Step 7: Verify by hand**

Confirm: `#settings` and `#settings/limits` both load and survive a reload; the nav switches sections and updates the hash; a not-ready agent shows its fix command and Copy works; Recheck re-probes; editing a model and saving persists across a reload and writes to the right scope; Discard reverts; Close returns to the cockpit.

- [ ] **Step 8: Commit**

```bash
npm run format && npm run lint && npm run typecheck && npm test -- tests/web-deep-link.test.ts
git add src/web/public/st-settings.js src/web/public/settings.css src/web/public/st-core.js
git commit -m "feat(web): settings as a page, replacing the config modal"
```

---

## Task 10: Retire the theatrical layer

**Files:**
- Modify: `src/web/public/st-arrival.js`, `arrival.css`, `st-core.js`, `st-run.js`

- [ ] **Step 1: Delete the render functions**

From `st-arrival.js`, delete `renderStationAtmosphere`, `renderStationHero`, `renderConductorStage`, `renderYardTrack`, and the inline engine SVG strings. Task 8 already replaced `renderArrival`; only the parked theatrical functions remain here.

From `st-run.js`, delete `renderTrackStrip` and `renderLegendOrTrack` if Task 6 left them unreferenced.

- [ ] **Step 2: Delete the mode machinery**

Remove every write to `document.body.dataset.mode`, the `S.departing` / `S.stationLanding` state, and the `shouldOfferStationLanding` call site in `st-core.js`. Leave the `first-run` module's exports alone — the reducer bundle still exports them and the TUI uses them.

- [ ] **Step 3: Delete the CSS**

From `arrival.css`, delete every rule under the Station, atmosphere, station-mode, ride, and conductor section comments, plus the `st-flow`, `st-glow`, and `st-drift` keyframes if nothing references them. Keep `st-pulse` — Tasks 5 and 6 use it.

- [ ] **Step 4: Confirm nothing dangles**

```bash
grep -rniE "station|conductor|departing|riding|dataset\.mode|renderYardTrack" src/web/public/
```
Expected: no matches, or only matches inside the reducer bundle (generated, and its `shouldOfferStationLanding` export is used by the TUI).

- [ ] **Step 5: Verify by hand and check the size**

Run `npm run dev`. Confirm: the tour workflow still runs, now through the Console like any other workflow; no console errors; no visual remnants.

```bash
wc -l src/web/public/*.css src/web/public/st-*.js
```

- [ ] **Step 6: Commit**

```bash
npm run format && npm run lint && npm run typecheck
git add -A src/web/public
git commit -m "refactor(web): retire the Station/Ride/Conductor layer"
```

---

## Task 11: Survivor verification and docs

The spec's §8 list, checked one by one, plus documentation. Nothing here is optional — these are the features the mockup never drew and are therefore the ones most likely to have been broken silently.

**Files:**
- Modify: `docs/web-ui.md`, `TUI-WEBUI-DIFFERENCES.md`, and whatever the checks turn up

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS. Note the two TUI test files that already fail on `main` in this environment — they are pre-existing and unrelated.

- [ ] **Step 2: Walk the survivor list**

Verify each in the browser, fixing anything broken before moving on:

- [ ] Configure modal opens, retarget-all works, per-step editors save
- [ ] Clone and Create (LLM-drafted) workflows
- [ ] Run history: list, detail, re-run
- [ ] Unified diff viewer: per-file collapse, large-diff cap notice
- [ ] Approval checkpoint: approve and reject, including the collapsible diff
- [ ] Human input: a `human` step and an agent clarifying question
- [ ] Sub-workflow "what runs inside" expands on a workflow-call step
- [ ] Prompt-history recall with ↑/↓ in the Describe box
- [ ] Read-only session: badge shows, mutating controls are hidden
- [ ] Narrow screen (≤900px wide): layout stays usable
- [ ] `prefers-reduced-motion`: pulses and transitions stop
- [ ] Run and approval deep links resolve on a cold load
- [ ] `#announcer` still announces run state changes

- [ ] **Step 3: Update `docs/web-ui.md`**

Describe the Console layout: the three columns, the single expanded band, settings as a page. Document the derived telemetry and its caveat verbatim from the spec — that projected cost is a heuristic which misleads on workflows with uneven step costs. State that five of the seven drawn settings sections are absent because no config API backs them.

- [ ] **Step 4: Update `TUI-WEBUI-DIFFERENCES.md`**

Add a dated entry (`Updated 2026-07-28`) at the top of the update list recording that the web UI moved to the Console layout and that configuration became a page rather than a modal — which widens the gap with the TUI's modal-based `/agents` and `/apis` managers. Note the instrument rail as web-only.

- [ ] **Step 5: Commit**

```bash
npm run format && npm run lint && npm run typecheck && npm test
git add -A
git commit -m "docs: describe the Console web UI layout"
```

---

## Self-review notes

Checked against the spec, section by section:

- §1 architecture → Tasks 1 and 4. §2 tokens → Task 5. §3 live run → Tasks 5 and 6.
  §4 arrival → Task 8. §5 telemetry → Tasks 3 and 7. §6 settings → Tasks 2 and 9.
  §7 retired → Task 10. §8 survivors → Task 11. §9 testing → Tasks 1, 2, 3, 11.
  §10 docs → Task 11.
- Names used consistently across tasks: `WEB_ASSETS`, `PageAssetRevisions`,
  `parseRoute`, `settingsDeepLink`, `SETTINGS_SECTIONS`, `createThroughputMeter`,
  `projectCost`, `Steamtrain.{state,h,shell,run,instruments,arrival,settings,modals}`.
- The step-row grid is defined once (Global Constraints) and referenced, not
  restated, by Task 6.

Known judgement calls a reviewer should weigh:

- **Task 4 is large and mostly mechanical.** It cannot be split further without
  leaving the app broken between tasks, which would be worse. Its Step 6 line-count
  check and Step 8 manual gate exist because a silent function drop during the move
  is the most likely way this plan fails.
- **The render modules have no automated tests.** The repo has no jsdom and the
  client is vanilla JS. Tasks 1-3 put the logic worth testing into TypeScript where
  it can be unit-tested; everything else is verified by hand, per task. Adding a DOM
  test harness is defensible follow-up work but is not in this plan's scope.
