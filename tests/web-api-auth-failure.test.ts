/**
 * apiAuth rejects as before, and a rejection the caller did not catch surfaces
 * one banner. A .catch() — including one attached to a promise derived from
 * .then(), and one Promise.all / `return` adoption installs internally — keeps
 * its own recovery and is not reported again. The 401 "auth required" throw is
 * the login overlay, not a network failure.
 *
 * Mounts st-core.js against a stub document. No jsdom.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public");
const coreJs = readFileSync(join(PUBLIC_DIR, "st-core.js"), "utf8");

interface StubNode {
  className: string;
  textContent: string;
  firstChild: StubNode | null;
  classList: { contains: (cls: string) => boolean };
  appendChild: (child: StubNode) => StubNode;
  insertBefore: (child: StubNode, before: StubNode | null) => StubNode;
  removeChild: (child: StubNode) => StubNode;
  addEventListener: () => void;
  focus: () => void;
  setAttribute: () => void;
  querySelector: (sel: string) => StubNode | null;
  kids: StubNode[];
}

function stubNode(className = ""): StubNode {
  const kids: StubNode[] = [];
  const node = {
    className,
    textContent: "",
    firstChild: null as StubNode | null,
    kids,
    classList: {
      contains: (cls: string) => node.className.split(" ").includes(cls),
    },
    appendChild: (child: StubNode) => {
      kids.push(child);
      node.firstChild = kids[0] ?? null;
      return child;
    },
    insertBefore: (child: StubNode, before: StubNode | null) => {
      const at = before ? kids.indexOf(before) : kids.length;
      kids.splice(at < 0 ? kids.length : at, 0, child);
      node.firstChild = kids[0] ?? null;
      return child;
    },
    removeChild: (child: StubNode) => {
      const at = kids.indexOf(child);
      if (at >= 0) kids.splice(at, 1);
      node.firstChild = kids[0] ?? null;
      return child;
    },
    addEventListener: () => {},
    focus: () => {},
    setAttribute: () => {},
    querySelector: (sel: string) => {
      const want = sel.startsWith(".") ? sel.slice(1) : sel;
      const walk = (n: StubNode): StubNode | null => {
        if (n.className.split(" ").includes(want)) return n;
        for (const kid of n.kids) {
          const hit = walk(kid);
          if (hit) return hit;
        }
        return null;
      };
      for (const kid of kids) {
        const hit = walk(kid);
        if (hit) return hit;
      }
      return null;
    },
  };
  return node;
}

interface Watched {
  // Own signatures, not Promise's: `.then()` returns another Watched, and the
  // tests silence the forwarded native rejection through `_promise` without
  // that catch counting as the caller handling it.
  then(
    onFulfilled?: ((value: unknown) => unknown) | null,
    onRejected?: ((reason: unknown) => unknown) | null,
  ): Watched;
  catch(onRejected?: ((reason: unknown) => unknown) | null): Watched;
  finally(onFinally?: (() => void) | null): Watched;
  _promise: Promise<unknown>;
}

interface Core {
  apiAuth: (method: string, path: string, body?: unknown) => Watched;
  requestFailureMessage: (reason: unknown) => string;
  watchUnhandledRejection: (
    promise: Promise<unknown>,
    onUnhandled: (reason: unknown) => void,
  ) => Watched;
  run: { setBanner: (text: string, kind: string) => void } | null;
  runs: { noteFailure: (text: string) => void } | null;
  state: { runId: string | null; selected: string | null; announceText: string };
}

const modalBody = stubNode("mbody");
const modal = stubNode();
modal.appendChild(modalBody);

const scene = { overlayOpen: false };

function loadCore(): Core {
  const window: Record<string, unknown> = {};
  const document = {
    body: stubNode(),
    getElementById: (id: string) => {
      if (id === "overlay")
        return stubNode(scene.overlayOpen ? "modal-overlay show" : "modal-overlay");
      if (id === "modal") return modal;
      return stubNode();
    },
    createElement: () => stubNode(),
    createTextNode: () => stubNode(),
    querySelectorAll: () => [],
  };
  new Function(
    "window",
    "document",
    "localStorage",
    "setInterval",
    "clearInterval",
    "SteamtrainReducer",
    coreJs,
  )(
    window,
    document,
    { getItem: () => null, setItem: () => {} },
    () => 1,
    () => {},
    {},
  );
  return window.Steamtrain as Core;
}

const ST = loadCore();
const originalFetch = globalThis.fetch;

let banners: string[] = [];
let noted: string[] = [];

function arm() {
  banners = [];
  noted = [];
  scene.overlayOpen = false;
  modalBody.kids.splice(0, modalBody.kids.length);
  modalBody.firstChild = null;
  ST.state.announceText = "";
  ST.state.runId = null;
  ST.state.selected = null;
  ST.run = {
    setBanner: (text: string) => {
      banners.push(text);
    },
  };
  ST.runs = {
    noteFailure: (text: string) => {
      noted.push(text);
    },
  };
}

beforeAll(() => {
  arm();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  scene.overlayOpen = false;
});

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function rejectFetch(reason: unknown) {
  globalThis.fetch = () => Promise.reject(reason);
}

describe("requestFailureMessage", () => {
  it("names the rejection when it has one", () => {
    expect(ST.requestFailureMessage(new Error("Failed to fetch"))).toBe(
      "Request failed: Failed to fetch",
    );
    expect(ST.requestFailureMessage("offline")).toBe("Request failed: offline");
  });

  it("still says the request failed when the rejection has no reason", () => {
    expect(ST.requestFailureMessage(new Error("  "))).toBe("Request failed.");
    expect(ST.requestFailureMessage("")).toBe("Request failed.");
    expect(ST.requestFailureMessage(null)).toBe("Request failed.");
    expect(ST.requestFailureMessage({})).toBe("Request failed.");
  });

  it("does not stack the words, and keeps a long reason short", () => {
    expect(ST.requestFailureMessage(new Error("request failed: timeout"))).toBe(
      "Request failed: timeout",
    );
    const detail = "x".repeat(200);
    const text = ST.requestFailureMessage(new Error(detail));
    expect(text.startsWith("Request failed: ")).toBe(true);
    expect(text.endsWith("…")).toBe(true);
    expect(text.length).toBeLessThan(detail.length);
  });
});

describe("watchUnhandledRejection", () => {
  it("reports a rejection nobody caught", async () => {
    const reports: unknown[] = [];
    ST.watchUnhandledRejection(Promise.reject(new Error("offline")), (reason) =>
      reports.push(reason),
    );
    await flush();
    expect(reports).toHaveLength(1);
    expect((reports[0] as Error).message).toBe("offline");
  });

  it("reports a bare .then(success), which does not handle the rejection", async () => {
    const reports: unknown[] = [];
    const child = ST.watchUnhandledRejection(Promise.reject(new Error("offline")), (reason) => {
      reports.push(reason);
    }).then(() => "ok");
    // Silence the forwarded native rejection. This is not a Watched catch, so
    // it must not count as the caller handling it.
    child._promise.catch(() => {});
    await flush();
    expect(reports).toHaveLength(1);
  });

  it("does not report when .catch recovers, and the catch still sees the reason", async () => {
    const reports: unknown[] = [];
    let seen = "";
    ST.watchUnhandledRejection(Promise.reject(new Error("offline")), (reason) =>
      reports.push(reason),
    ).catch((reason: unknown) => {
      seen = (reason as Error).message;
    });
    await flush();
    expect(reports).toEqual([]);
    expect(seen).toBe("offline");
  });

  it("does not report a .then().catch() chain", async () => {
    const reports: unknown[] = [];
    let seen = "";
    ST.watchUnhandledRejection(Promise.reject(new Error("offline")), (reason) =>
      reports.push(reason),
    )
      .then(() => "ok")
      .catch((reason: unknown) => {
        seen = (reason as Error).message;
      });
    await flush();
    expect(reports).toEqual([]);
    expect(seen).toBe("offline");
  });

  it("runs .finally without counting it as handled, and a later catch still counts", async () => {
    const reports: unknown[] = [];
    let cleanups = 0;
    const bare = ST.watchUnhandledRejection(Promise.reject(new Error("offline")), (reason) =>
      reports.push(reason),
    ).finally(() => {
      cleanups += 1;
    });
    bare._promise.catch(() => {});
    let seen = "";
    ST.watchUnhandledRejection(Promise.reject(new Error("gone")), (reason) => reports.push(reason))
      .finally(() => {
        cleanups += 1;
      })
      .catch((reason: unknown) => {
        seen = (reason as Error).message;
      });
    await flush();
    expect(cleanups).toBe(2);
    expect(reports.map((r) => (r as Error).message)).toEqual(["offline"]);
    expect(seen).toBe("gone");
  });

  it("does not report when the promise is returned into a catch", async () => {
    const reports: unknown[] = [];
    let seen = "";
    Promise.resolve("from")
      .then(() =>
        ST.watchUnhandledRejection(Promise.reject(new Error("offline")), (reason) =>
          reports.push(reason),
        ),
      )
      .catch((reason: unknown) => {
        seen = (reason as Error).message;
      });
    await flush();
    expect(reports).toEqual([]);
    expect(seen).toBe("offline");
  });

  it("does not report a Promise.all member whose aggregate is caught", async () => {
    const reports: unknown[] = [];
    let seen = "";
    Promise.all([
      ST.watchUnhandledRejection(Promise.reject(new Error("offline")), (reason) =>
        reports.push(reason),
      ),
    ]).catch((reason: unknown) => {
      seen = (reason as Error).message;
    });
    await flush();
    expect(reports).toEqual([]);
    expect(seen).toBe("offline");
  });

  it("does not treat a caller throw after a successful response as a request failure", async () => {
    const reports: unknown[] = [];
    const child = ST.watchUnhandledRejection(Promise.resolve("ok"), (reason) =>
      reports.push(reason),
    ).then(() => {
      throw new Error("caller bug");
    });
    child._promise.catch(() => {});
    await flush();
    expect(reports).toEqual([]);
  });
});

describe("apiAuth network failure", () => {
  it("banners an unguarded rejection and still rejects", async () => {
    arm();
    rejectFetch(new Error("Failed to fetch"));
    const child = ST.apiAuth("POST", "/api/history/abc/prune").then(() => "ok");
    child._promise.catch(() => {});
    await flush();
    expect(banners).toEqual(["Request failed: Failed to fetch"]);
    expect(noted).toEqual(["Request failed: Failed to fetch"]);
  });

  it("banners a call with no handler at all", async () => {
    arm();
    rejectFetch(new Error("Failed to fetch"));
    ST.apiAuth("DELETE", "/api/workflows/demo");
    await flush();
    expect(banners).toEqual(["Request failed: Failed to fetch"]);
  });

  it("says the request failed when the rejection carries no message", async () => {
    arm();
    rejectFetch(new Error(""));
    ST.apiAuth("GET", "/api/workflows");
    await flush();
    expect(banners).toEqual(["Request failed."]);
  });

  it("does not banner when the caller catches, and the catch still runs", async () => {
    arm();
    rejectFetch(new Error("Failed to fetch"));
    let recovered = false;
    ST.apiAuth("PUT", "/api/workflows/demo", { spec: {} })
      .then(() => "saved")
      .catch(() => {
        recovered = true;
      });
    await flush();
    expect(recovered).toBe(true);
    expect(banners).toEqual([]);
    expect(noted).toEqual([]);
  });

  it("does not banner a background poll swallowed by Promise.all", async () => {
    arm();
    rejectFetch(new Error("Failed to fetch"));
    let swallowed = false;
    Promise.all([ST.apiAuth("GET", "/api/history")]).catch(() => {
      swallowed = true;
    });
    await flush();
    expect(swallowed).toBe(true);
    expect(banners).toEqual([]);
  });

  it("does not banner a fulfilled response, including a non-JSON body", async () => {
    arm();
    globalThis.fetch = () =>
      Promise.resolve({
        status: 200,
        text: () => Promise.resolve('{"ok":true}'),
      } as Response);
    const ok = (await ST.apiAuth("GET", "/api/workflows")) as {
      status: number;
      body: { ok?: boolean };
    };
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);

    globalThis.fetch = () =>
      Promise.resolve({
        status: 502,
        text: () => Promise.resolve("<html>bad gateway"),
      } as Response);
    const bad = (await ST.apiAuth("GET", "/api/workflows")) as { status: number; body: unknown };
    expect(bad.status).toBe(502);
    expect(bad.body).toEqual({});
    expect(banners).toEqual([]);
  });

  it("does not banner a 401 — the login overlay already explains it", async () => {
    arm();
    globalThis.fetch = () =>
      Promise.resolve({ status: 401, text: () => Promise.resolve("") } as Response);
    const child = ST.apiAuth("GET", "/api/config").then(() => "ok");
    child._promise.catch(() => {});
    await flush();
    expect(banners).toEqual([]);
    expect(noted).toEqual([]);
  });

  it("also drops the failure into an open modal, which covers the cockpit banner", async () => {
    arm();
    scene.overlayOpen = true;
    rejectFetch(new TypeError("Failed to fetch"));
    ST.apiAuth("POST", "/api/history/abc/retry", {});
    await flush();
    expect(banners).toEqual(["Request failed: Failed to fetch"]);
    const failure = modalBody.querySelector(".api-failure");
    expect(failure).not.toBeNull();
    expect(failure?.textContent).toBe("Request failed: Failed to fetch");
    expect(failure?.className).toContain("mbanner");
    expect(failure?.className).toContain("err");
  });
});
