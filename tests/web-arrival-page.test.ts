/**
 * Contract for the finished-run page (design 5a, st-arrival.js).
 *
 * st-arrival.js is a plain IIFE over `window.Steamtrain`, so it runs here for
 * real, the way tests/web-runs-page.test.ts runs the runs page: against the
 * shared stub DOM, with the run state coming from the real web reducer folding
 * real workflow events, and the assertions read back what the page painted
 * and fire the handlers it attached. The layout invariants that only exist in
 * the stylesheet are asserted against the CSS text, and the few that live in
 * other public files (the cockpit and the shell) against their source.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as SteamtrainReducer from "../src/web/reducer";
import type { WorkflowEvent } from "../src/workflow";
import type { WorkflowState } from "../src/workflow/reducer";
import {
  type StubEl,
  buttonsNamed,
  byClass,
  click,
  createDom,
  hasClass,
  loadScripts,
  shownText,
} from "./helpers/stub-dom";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public");
const arrivalJs = readFileSync(join(PUBLIC_DIR, "st-arrival.js"), "utf8");
const css = readFileSync(join(PUBLIC_DIR, "arrival.css"), "utf8");

/** Every declaration block whose selector list contains `selector`, concatenated. */
function ruleBody(sheet: string, selector: string): string {
  const bodies: string[] = [];
  const stripped = sheet.replace(/\/\*[\s\S]*?\*\//g, " ");
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(stripped); m; m = re.exec(stripped)) {
    const selectors = (m[1] ?? "").split(",").map((s) => s.trim().replace(/\s+/g, " "));
    if (selectors.includes(selector)) bodies.push(m[2] ?? "");
  }
  return bodies.join("\n");
}

/** The value half of a tile or footer row (`.k`/label, then `.v`). */
function shownValue(root: StubEl, cls: "tile" | "row", label: string): string {
  const box = byClass(root, cls).find((n) => shownText(n.children[0] as StubEl) === label);
  if (!box) throw new Error(`no ${cls} labelled ${label}`);
  return shownText(byClass(box, "v")[0] as StubEl);
}

// ── mounting ─────────────────────────────────────────────────────────────────

/** A finished run as the web reducer folds it from the engine's events. */
function runState(
  events: WorkflowEvent[],
  seed?: Parameters<typeof SteamtrainReducer.workflowStateFromSpec>[0],
): WorkflowState {
  let state = seed
    ? SteamtrainReducer.workflowReducer(SteamtrainReducer.initialWorkflowState, {
        type: "seed",
        spec: seed,
      })
    : SteamtrainReducer.initialWorkflowState;
  for (const event of events)
    state = SteamtrainReducer.workflowReducer(state, { type: "event", event });
  return state;
}

interface WorktreeAnswer {
  status: number;
  body?: Record<string, unknown>;
}

interface Mounted {
  S: Record<string, unknown>;
  /** The page as last painted. */
  page: () => StubEl;
  text: () => string;
  button: (label: string) => StubEl | undefined;
  render: () => void;
  calls: {
    rerunHistory: unknown[][];
    copied: { text: string; label: string }[];
    openEditor: boolean[];
    deletes: number;
    openRuns: unknown[];
    worktreeFetches: number;
  };
  /** Document-level listeners the page currently has installed. */
  documentListeners: () => number;
  leave: () => void;
}

function mount(opts: {
  state: WorkflowState;
  runStatus?: string | null;
  source?: "project" | "user" | "bundled";
  spec?: unknown;
  /** Answers for GET /api/history/:id/worktrees, in order; the last repeats. */
  worktrees?: WorktreeAnswer[];
}): Mounted {
  const S: Record<string, unknown> = {
    runState: opts.state,
    runId: "3f2a9c1e-0000-4000-8000-000000000000",
    selected: "ship-it",
    source: opts.source ?? "project",
    spec: opts.spec ?? null,
    runStatus: opts.runStatus === undefined ? "error" : opts.runStatus,
    startedAt: 1_000,
    endedAt: 61_000,
    arrivalMenuOpen: false,
    arrivalWorktrees: null,
    arrivalWorktreesWait: null,
  };
  const calls: Mounted["calls"] = {
    rerunHistory: [],
    copied: [],
    openEditor: [],
    deletes: 0,
    openRuns: [],
    worktreeFetches: 0,
  };
  const { document, h } = createDom();
  const answers = opts.worktrees ?? [{ status: 200, body: { sources: [] } }];
  let canvas = h("div");
  const ST: Record<string, unknown> = {
    state: S,
    h,
    KIND_LABEL: { worker: "worker", command: "command", gate: "gate" },
    activateWithKeyboard: (e: { key: string }, action: () => void) => {
      if (e.key === "Enter" || e.key === " ") action();
    },
    announce: () => {},
    copyFix: (text: string, _btn: unknown, _fix: unknown, label: string) =>
      calls.copied.push({ text, label }),
    isCredentialFreeSpec: () => false,
    isReadOnly: () => false,
    pickNextWorkflow: () => null,
    fmtElapsed: (ms: number) => (ms ? `${(ms / 1000).toFixed(1)}s` : ""),
    fmtTime: () => "12:00",
    fmtTokens: (n: number) => String(n),
    stepPermissions: () => null,
    apiAuth: () => {
      const answer = answers[Math.min(calls.worktreeFetches, answers.length - 1)] as WorktreeAnswer;
      calls.worktreeFetches += 1;
      return Promise.resolve({ status: answer.status, body: answer.body ?? {} });
    },
    render: () => {
      canvas = h("div");
      (ST.arrival as { renderArrival: (c: StubEl) => boolean }).renderArrival(canvas);
    },
    modals: {
      rerunHistory: (...args: unknown[]) => calls.rerunHistory.push(args),
      openEditor: (clone: boolean) => calls.openEditor.push(clone),
      doDelete: () => {
        calls.deletes += 1;
      },
    },
    run: { startRun: () => {}, effectiveSpec: () => opts.spec ?? null },
    runs: { open: (id: unknown) => calls.openRuns.push(id) },
    selectWorkflow: () => {},
  };
  loadScripts([arrivalJs], {
    window: { Steamtrain: ST },
    document,
    SteamtrainReducer,
    requestAnimationFrame: () => {},
  });
  const render = ST.render as () => void;
  render();
  return {
    S,
    page: () => canvas,
    text: () => shownText(canvas),
    button: (label) => buttonsNamed(canvas, label)[0],
    render,
    calls,
    documentListeners: () =>
      Object.values(document.listeners).reduce((n, fns) => n + fns.length, 0),
    leave: () => (ST.arrival as { leave: () => void }).leave(),
  };
}

// ── runs ─────────────────────────────────────────────────────────────────────

let clock = 1_000;
function at(): number {
  clock += 1_000;
  return clock;
}

function start(phaseCount: number): WorkflowEvent {
  return { kind: "workflow_start", name: "ship-it", phaseCount, stepCount: phaseCount, ts: at() };
}
function phase(phaseId: string, index: number, iteration?: number): WorkflowEvent[] {
  return [
    { kind: "phase_start", phaseId, title: phaseId, index, stepCount: 1, iteration, ts: at() },
  ];
}
function step(
  phaseId: string,
  stepId: string,
  result: Record<string, unknown>,
  opts: { iteration?: number; blockKind?: string; agent?: string } = {},
): WorkflowEvent[] {
  return [
    {
      kind: "step_start",
      phaseId,
      stepId,
      blockKind: (opts.blockKind ?? "command") as "worker",
      agent: opts.agent as "claude" | undefined,
      iteration: opts.iteration,
      ts: at(),
    },
    {
      kind: "step_done",
      phaseId,
      stepId,
      result: { stepId, output: "", durationMs: 2_000, ...result } as never,
      cached: false,
      iteration: opts.iteration,
      ts: at(),
    },
    { kind: "phase_done", phaseId, ok: result.ok === true, iteration: opts.iteration, ts: at() },
  ];
}
function done(ok: boolean): WorkflowEvent {
  return { kind: "workflow_done", ok, results: [], ts: at() };
}

/** build ok → test fails → deploy never starts. */
function failedRun(): WorkflowState {
  return runState([
    start(3),
    ...phase("build", 0),
    ...step("build", "build", { ok: true, output: "built" }),
    ...phase("test", 1),
    ...step("test", "test", {
      ok: false,
      error: "command exited with code 1",
      output:
        "running 12 tests\nFAIL auth.spec.ts\n  expected 200, got 500\n[command exited with code 1]",
    }),
    ...phase("deploy", 2),
    ...step("deploy", "deploy", {
      ok: false,
      error: "dependency failed",
      dependencyFailed: "test",
    }),
    done(false),
  ]);
}

/** build ok → test was running when the run was canceled. */
function canceledRun(): WorkflowState {
  return runState([
    start(2),
    ...phase("build", 0),
    ...step("build", "build", { ok: true }),
    ...phase("test", 1),
    ...step("test", "test", {
      ok: false,
      error: "command exited with code 143",
      interrupted: true,
    }),
    done(false),
  ]);
}

function cleanRun(): WorkflowState {
  return runState([
    start(1),
    ...phase("build", 0),
    ...step("build", "build", { ok: true }),
    done(true),
  ]);
}

afterEach(() => {
  vi.useRealTimers();
});

// ── rule 1: run actions are not workflow actions ─────────────────────────────

describe("finished-run page: run actions are not workflow actions", () => {
  it("hides the cockpit's workflow action row while the page is up", () => {
    // The row holds Delete, which removes the WORKFLOW. Above a failed run it
    // read as "discard this run" — the confusion this page exists to end.
    const bootJs = readFileSync(join(PUBLIC_DIR, "st-boot.js"), "utf8");
    expect(bootJs).toContain('classList.toggle("arrival-mode", showingArrival)');
    expect(bootJs).toContain("ST.arrival.leave()");
    expect(ruleBody(css, "body.arrival-mode .run-head")).toMatch(/display:\s*none/);
  });

  it("puts every workflow action behind one menu whose items name the workflow", () => {
    const page = mount({ state: failedRun(), source: "project" });
    click(page.button("Workflow▾"));
    const items = byClass(page.page(), "arrival-menu-item").map(shownText);
    expect(items).toEqual([
      "Configure workflow",
      "Clone workflow",
      "Open workflow source",
      // The destructive item states its real blast radius: the config file,
      // not the run history, which deleting a workflow leaves alone.
      "Delete workflow from the project steamtrain.json…",
    ]);
    click(page.button("Clone workflow"));
    expect(page.calls.openEditor).toEqual([true]);

    const user = mount({ state: failedRun(), source: "user" });
    click(user.button("Workflow▾"));
    click(user.button("Delete workflow from your user workflows file…"));
    expect(user.calls.deletes).toBe(1);

    // A bundled workflow has no file to delete it from.
    const bundled = mount({ state: failedRun(), source: "bundled" });
    click(bundled.button("Workflow▾"));
    expect(byClass(bundled.page(), "arrival-menu-item").map(shownText)).not.toContain(
      expect.stringContaining("Delete"),
    );
  });

  it("keeps the menu open across a re-render, and never stacks its dismiss listeners", () => {
    // #bands is rebuilt on every render (st-boot.js), so a menu that kept its
    // own state in the DOM vanished on the next background poll.
    const page = mount({ state: failedRun() });
    click(page.button("Workflow▾"));
    expect(page.S.arrivalMenuOpen).toBe(true);
    page.render();
    page.render();
    const pop = byClass(page.page(), "arrival-menu-pop")[0];
    expect(pop?.hidden).toBe(false);
    // One mousedown (click-away) and one keydown (Escape), however many renders.
    expect(page.documentListeners()).toBe(2);
    page.leave();
    expect(page.documentListeners()).toBe(0);
    expect(page.S.arrivalMenuOpen).toBe(false);
  });
});

// ── rule 3: the page ends in an action ───────────────────────────────────────

describe("finished-run page: the page ends in an action", () => {
  it("offers a retry that restarts from the failing step, not from the top", () => {
    const page = mount({ state: failedRun() });
    // retry-failed seeds the steps that already succeeded and re-executes the
    // rest; "rerun" would start the whole workflow over.
    click(page.button("Retry from test"));
    expect(page.calls.rerunHistory).toEqual([
      ["3f2a9c1e-0000-4000-8000-000000000000", "ship-it", "retry"],
    ]);
  });

  it("states the root cause, what it took down, and the evidence", () => {
    const page = mount({ state: failedRun(), spec: specWith("test", "npm test") });
    const cause = byClass(page.page(), "rootcause")[0] as StubEl;
    expect(shownText(byClass(cause, "kicker")[0] as StubEl)).toBe("Root cause");
    expect(shownText(byClass(cause, "what")[0] as StubEl)).toBe(
      "Step test failed: command exited with code 1",
    );
    expect(shownText(byClass(cause, "blocked")[0] as StubEl)).toBe(
      "Everything after it was skipped, not run: deploy.",
    );
    // The failing command, then the last lines of what it printed.
    const evidence = shownText(byClass(cause, "rootcause-evidence")[0] as StubEl);
    expect(evidence).toContain("$ npm test");
    expect(evidence).toContain("expected 200, got 500");
    expect(page.button("Edit this step")).toBeDefined();
  });

  it("copies through the shared helper, with the button's own label", () => {
    // navigator.clipboard is undefined on any non-secure origin, so copying
    // goes through copyFix and its fallback (tests/web-copy-fallback.test.ts).
    const page = mount({ state: failedRun() });
    click(page.button("Copy error"));
    expect(page.calls.copied).toHaveLength(1);
    expect(page.calls.copied[0]?.label).toBe("Copy error");
    expect(page.calls.copied[0]?.text).toMatch(/^test: command exited with code 1\n/);
  });

  it("replaces a zeroed spend tile with the reason it is zero", () => {
    // A run of commands never reached an agent, so "$0" would read as free.
    const page = mount({ state: failedRun() });
    expect(shownValue(page.page(), "tile", "Model spend")).toBe("none — no agent step ran");
  });

  it("says a clean run is complete and shows its receipt instead of findings", () => {
    const page = mount({ state: cleanRun(), runStatus: "done" });
    expect(shownText(byClass(page.page(), "arrival-state")[0] as StubEl)).toBe("complete");
    expect(byClass(page.page(), "rootcause")).toHaveLength(0);
    // With no root cause, the primary action is to run it again.
    expect(page.button("Run again")?.className).toBe("btn primary");
  });
});

// ── rule 2: failed is not skipped ────────────────────────────────────────────

describe("finished-run page: failed is not skipped", () => {
  it("groups the steps that never started under their own header", () => {
    const page = mount({ state: failedRun() });
    const ledger = byClass(page.page(), "ledger")[0] as StubEl;
    expect(shownText(byClass(ledger, "count")[0] as StubEl)).toBe("2 of 3 ran");
    expect(byClass(ledger, "ledger-group").map(shownText)).toEqual(["Never started — 1 step"]);
    const rows = byClass(ledger, "ledger-row");
    expect(rows.map((r) => shownText(byClass(r, "sub")[0] as StubEl))).toEqual([
      "command · succeeded",
      "command · command exited with code 1",
      "command · blocked by test",
    ]);
    expect(hasClass(rows[1] as StubEl, "failed")).toBe(true);
    // The steps tile counts one failure, not three.
    expect(shownValue(page.page(), "tile", "Steps")).toBe("1 ok · 1 failed · 1 skipped");
  });

  it("lays a blocked row out without the columns it cannot populate", () => {
    // A step that never ran has no duration and no cost; dashing them out is
    // the noise design 4a removed from the live view.
    const page = mount({ state: failedRun() });
    const rows = byClass(page.page(), "ledger-row");
    const blocked = rows.find((r) => hasClass(r, "stalled")) as StubEl;
    expect(hasClass(blocked, "has-time") || hasClass(blocked, "has-cost")).toBe(false);
    expect(byClass(blocked, "num")).toHaveLength(0);
    expect(hasClass(rows[0] as StubEl, "has-time")).toBe(true);
    expect(ruleBody(css, ".ledger-row")).toMatch(
      /grid-template-columns:\s*8px minmax\(0, 1fr\)\s*;/,
    );
    expect(ruleBody(css, ".ledger-row.has-time")).toMatch(/grid-template-columns:/);
    expect(ruleBody(css, ".ledger-row.has-cost")).toMatch(/grid-template-columns:/);
  });

  it("shows the failing step's output, and any ledger row swaps it", () => {
    const page = mount({ state: failedRun() });
    const who = () => shownText(byClass(page.page(), "arrival-output-head")[0] as StubEl);
    expect(who()).toContain("test");
    click(byClass(page.page(), "ledger-row")[0]);
    expect(who()).toContain("build");
    expect(shownText(byClass(page.page(), "arrival-output-body")[0] as StubEl)).toBe("built");
  });
});

// ── canceled and timed-out runs ──────────────────────────────────────────────

describe("finished-run page: a canceled run is not a failed one", () => {
  it("states the run's own status and where it was stopped, and offers to resume", () => {
    const page = mount({ state: canceledRun(), runStatus: "canceled" });
    expect(shownText(byClass(page.page(), "arrival-state")[0] as StubEl)).toBe("canceled");
    const cause = byClass(page.page(), "rootcause")[0] as StubEl;
    expect(hasClass(cause, "interrupted")).toBe(true);
    expect(shownText(byClass(cause, "kicker")[0] as StubEl)).toBe("Stopped here");
    expect(shownText(byClass(cause, "what")[0] as StubEl)).toBe(
      "Run canceled while test was running",
    );
    expect(page.button("Resume from test")).toBeDefined();
    const sub = byClass(page.page(), "ledger-row").map((r) =>
      shownText(byClass(r, "sub")[0] as StubEl),
    );
    expect(sub).toContain("command · interrupted — run canceled");
    expect(shownValue(page.page(), "tile", "Steps")).toBe("1 ok · 1 interrupted");
    expect(ruleBody(css, ".rootcause.interrupted")).toContain("border-left-color");
  });

  it("trusts the engine's marker, not the error's wording", () => {
    // A step that failed on its own before the cancel keeps its failure even
    // when its error happens to say "timed out".
    const state = runState([
      start(1),
      ...phase("test", 0),
      ...step("test", "test", { ok: false, error: "command timed out after 30s" }),
      done(false),
    ]);
    const page = mount({ state, runStatus: "canceled" });
    const cause = byClass(page.page(), "rootcause")[0] as StubEl;
    expect(hasClass(cause, "interrupted")).toBe(false);
    expect(shownText(byClass(cause, "what")[0] as StubEl)).toBe(
      "Step test failed: command timed out after 30s",
    );
  });

  it("tells a workflow timeout apart from a cancel", () => {
    const page = mount({ state: canceledRun(), runStatus: "timed-out" });
    expect(shownText(byClass(page.page(), "arrival-state")[0] as StubEl)).toBe("timed out");
  });

  it("says 'stopped' before the final status frame lands, not 'failed'", () => {
    const page = mount({ state: canceledRun(), runStatus: null });
    expect(shownText(byClass(page.page(), "arrival-state")[0] as StubEl)).toBe("stopped");
  });

  it("lists the ledger in the order steps ran, so a loop's later pass is not last", () => {
    // Seeded from the spec, `report` exists before the loop's second pass, so
    // the phases list `fix` pass 2 after it; the ledger must not.
    const spec = {
      name: "ship-it",
      phases: [
        { id: "fix", title: "fix", steps: [{ id: "fix", kind: "command", cmd: "true" }] },
        {
          id: "check",
          title: "check",
          steps: [{ id: "check", kind: "command", cmd: "true" }],
        },
        { id: "report", title: "report", steps: [{ id: "report", kind: "command", cmd: "true" }] },
      ],
    };
    const state = runState(
      [
        start(3),
        ...phase("fix", 0, 1),
        ...step("fix", "fix", { ok: true, output: "pass 1" }, { iteration: 1 }),
        ...phase("check", 1, 1),
        ...step("check", "check", { ok: true }, { iteration: 1 }),
        {
          kind: "loop_iteration",
          gateStepId: "check",
          loopTo: "fix",
          iteration: 2,
          maxIterations: 3,
          ts: at(),
        },
        ...phase("fix", 0, 2),
        ...step("fix", "fix", { ok: true, output: "pass 2" }, { iteration: 2 }),
        ...phase("report", 2),
        ...step("report", "report", { ok: true }),
        done(true),
      ],
      spec as never,
    );
    const page = mount({ state, runStatus: "done" });
    const ids = byClass(page.page(), "ledger-row").map((r) =>
      shownText(byClass(r, "id")[0] as StubEl),
    );
    expect(ids).toEqual(["fix", "check", "fix", "report"]);
  });
});

// ── worktrees ────────────────────────────────────────────────────────────────

describe("finished-run page: what the run left behind", () => {
  const tileText = (page: Mounted) => shownValue(page.page(), "tile", "Left behind");
  const footText = (page: Mounted) => shownValue(page.page(), "row", "worktrees");
  const settle = () => new Promise((r) => setImmediate(r));

  it("reports worktrees from the server's look at them, not from step success", async () => {
    // "5 merged back" on a workflow with no merge step: an ok step merged nothing.
    const page = mount({
      state: failedRun(),
      worktrees: [
        {
          status: 200,
          body: {
            sources: [
              { stepId: "build", root: "/wt/a", exists: true, files: ["src/a.ts"] },
              { stepId: "test", root: "/wt/b", exists: false },
            ],
          },
        },
      ],
    });
    await settle();
    expect(tileText(page)).toBe("1 worktree with changes review");
    expect(footText(page)).toBe("1 with changes · 1 cleaned up");
    click(page.button("review"));
    expect(page.calls.openRuns).toEqual(["3f2a9c1e-0000-4000-8000-000000000000"]);
  });

  it("retries a record that has not landed yet, then offers the reader a retry", async () => {
    vi.useFakeTimers();
    const page = mount({
      state: failedRun(),
      worktrees: [
        ...Array.from({ length: 22 }, () => ({ status: 404 })),
        {
          status: 200,
          body: { sources: [] },
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(footText(page)).toBe("checking…");
    // Ten retries a second apart, and one more round once the page repaints
    // after the first gives up; then it stops.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(page.calls.worktreeFetches).toBe(22);
    expect(tileText(page)).toBe("unknown retry");
    // It no longer retries by itself, however often the page repaints…
    page.render();
    page.render();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(page.calls.worktreeFetches).toBe(22);
    expect(tileText(page)).toBe("unknown retry");
    // …but the reader can ask again.
    click(page.button("retry"));
    await vi.advanceTimersByTimeAsync(0);
    expect(page.calls.worktreeFetches).toBe(23);
    expect(tileText(page)).toBe("nothing");
    expect(footText(page)).toBe("none");
  });

  it("waits for the run's status before looking, but not forever", async () => {
    // A marker that outlived its timer left the page at "checking…" for good.
    vi.useFakeTimers();
    const page = mount({ state: failedRun(), runStatus: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(page.calls.worktreeFetches).toBe(0);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(page.calls.worktreeFetches).toBe(1);
    // Once it has an answer, a re-armed wait does not fetch it again.
    await vi.advanceTimersByTimeAsync(16_000);
    expect(page.calls.worktreeFetches).toBe(1);
    expect(footText(page)).toBe("none");
  });
});

// ── layout ───────────────────────────────────────────────────────────────────

describe("finished-run page: layout", () => {
  it("gives the output pane the space a finished run used to leave empty", () => {
    const out = ruleBody(css, ".arrival-output");
    expect(out).toMatch(/flex:\s*1 1 auto/);
    expect(out).toMatch(/min-height:\s*\d/);
  });

  it("lets the head's menu hang over the body without the page overflowing", () => {
    // `overflow: hidden` clipped the popup; dropping it also drops the
    // automatic-minimum-size behaviour that kept the column inside the canvas,
    // so min-height has to be stated explicitly.
    const main = ruleBody(css, ".arrival-main");
    expect(main).toMatch(/overflow:\s*visible/);
    expect(main).toMatch(/min-height:\s*0/);
    expect(ruleBody(css, ".arrival-body")).toMatch(/overflow-y:\s*auto/);
  });

  it("retires the live instrument rail once the run is over", () => {
    expect(ruleBody(css, "body.arrival-mode #rail-right")).toMatch(/display:\s*none/);
  });
});

// ── the cockpit around the page ──────────────────────────────────────────────

describe("finished-run page: what the cockpit hands it", () => {
  // These live in st-run.js and st-shell.js, which this harness does not run.
  const runJs = readFileSync(join(PUBLIC_DIR, "st-run.js"), "utf8");
  const shellJs = readFileSync(join(PUBLIC_DIR, "st-shell.js"), "utf8");

  it("keeps the run's own terminal status, timeouts included", () => {
    expect(runJs).toContain(": frame.status || null;");
    expect(runJs).toContain('frame.status === "canceled" && frame.timedOut ? "timed-out"');
    expect(runJs).toContain('canceled: { cls: "stopped", text: "canceled" }');
    // The generic outcome banner is gone: the page's pill and root cause say it.
    expect(runJs).not.toContain('setBanner("Run failed"');
    expect(runJs).not.toContain('setBanner("Run complete."');
  });

  it("never loses a live run from view once the cockpit leaves it", () => {
    expect(shellJs).toContain('return run.id !== S.runId || liveRunState(run).cls === "awaiting";');
    expect(runJs).toContain('text: "attach"');
  });
});

function specWith(stepId: string, cmd: string) {
  return {
    name: "ship-it",
    phases: [{ id: "p", title: "p", steps: [{ id: stepId, kind: "command", cmd }] }],
  };
}
