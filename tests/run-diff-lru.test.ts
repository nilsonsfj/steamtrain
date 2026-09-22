import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RUN_DIFF_CACHE_CAP,
  invalidateRunDiff,
  rememberRunDiff,
  touchRunDiff,
} from "../src/web/run-diff-lru";

interface RunDiffLru {
  cap: number;
  touch(maps: RunDiffMaps, runId: string): string | undefined;
  remember(maps: RunDiffMaps, runId: string, value: string): void;
  invalidate(maps: RunDiffMaps, runId: string): void;
}

interface RunDiffMaps {
  cache: Map<string, string>;
  expanded: Map<string, Set<string>>;
}

/**
 * The classic script cannot import the module, so it keeps its own copy of
 * these three functions. Load that copy and run the same assertions against it.
 */
function browserRunDiffLru(): RunDiffLru {
  const js = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/web/public/st-runs.js"),
    "utf8",
  );
  const cap = Number(/var DIFF_CACHE_CAP = (\d+);/.exec(js)?.[1]);
  const start = js.indexOf("function touchRunDiff");
  const end = js.indexOf("function invalidateRunDiff");
  const close = js.indexOf("\n  }", end);
  const src = js.slice(start, close + "\n  }".length);
  const api = new Function(
    `${src}; return { touchRunDiff, rememberRunDiff, invalidateRunDiff };`,
  )() as {
    touchRunDiff(maps: RunDiffMaps, runId: string): string | undefined;
    rememberRunDiff(maps: RunDiffMaps, runId: string, value: string, cap: number): void;
    invalidateRunDiff(maps: RunDiffMaps, runId: string): void;
  };
  return {
    cap,
    touch: api.touchRunDiff,
    remember: (maps, runId, value) => api.rememberRunDiff(maps, runId, value, cap),
    invalidate: api.invalidateRunDiff,
  };
}

function assertCap(lru: RunDiffLru): void {
  const cache = new Map<string, string>();
  const expanded = new Map<string, Set<string>>();
  const maps = { cache, expanded };

  for (let i = 0; i < lru.cap; i++) {
    const id = `run-${i}`;
    lru.remember(maps, id, `patch-${i}`);
    expanded.set(id, new Set([`step-${i}`]));
  }

  // run-0 is the oldest. Re-opening it moves it ahead of run-1.
  expect(lru.touch(maps, "run-0")).toBe("patch-0");

  const fresh = "run-fresh";
  expanded.set(fresh, new Set(["step-fresh"]));
  lru.remember(maps, fresh, "patch-fresh");

  expect(cache.has("run-1")).toBe(false);
  expect(expanded.has("run-1")).toBe(false);
  expect(cache.get("run-0")).toBe("patch-0");
  expect(expanded.get("run-0")).toEqual(new Set(["step-0"]));
  expect(cache.get(fresh)).toBe("patch-fresh");
  expect(expanded.get(fresh)).toEqual(new Set(["step-fresh"]));
  expect(cache.size).toBe(lru.cap);

  lru.invalidate(maps, "run-0");
  expect(cache.has("run-0")).toBe(false);
  expect(expanded.has("run-0")).toBe(false);
  expect(cache.has("run-2")).toBe(true);
  expect(expanded.has("run-2")).toBe(true);
  expect(cache.has(fresh)).toBe(true);
}

describe("run diff LRU", () => {
  it("drops the oldest run from both maps and keeps a run that was just touched", () => {
    assertCap({
      cap: RUN_DIFF_CACHE_CAP,
      touch: touchRunDiff,
      remember: (maps, runId, value) => rememberRunDiff(maps, runId, value),
      invalidate: invalidateRunDiff,
    });
  });

  it("keeps the same cap in the browser script, which cannot import the module", () => {
    const browser = browserRunDiffLru();
    expect(browser.cap).toBe(RUN_DIFF_CACHE_CAP);
    assertCap(browser);
  });
});
