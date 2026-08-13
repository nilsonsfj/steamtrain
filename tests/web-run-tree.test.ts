/**
 * The live run's shape (design turn 6, screen 6a): `src/web/public/st-tree.js`.
 *
 * A run nests four ways at once — overlapping phases, a loop gate that re-runs
 * a phase range, a `forEach` that fans one step into twelve, and a `workflow`
 * step that invokes a whole other workflow inside this one. 6a's rule is that
 * each kind gets its own treatment rather than another level of indentation,
 * and this file pins those treatments down:
 *
 *   · a loop is ONE band with a pass switcher, not one band per pass;
 *   · a fan-out is ONE row that opens, its settled children behind a count;
 *   · a sub-run's steps open one level in, contiguous settled ones rolled;
 *   · everything selectable states its full address.
 *
 * The module is a browser IIFE over `window.Steamtrain`, so it is loaded here
 * with a stand-in window rather than imported.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public");

/** The module under test is untyped browser JS; its shapes are plain objects. */
type Any = any;

let tree: Any;

beforeAll(() => {
  const src = readFileSync(join(PUBLIC_DIR, "st-tree.js"), "utf8");
  const ST: Any = {};
  new Function("window", src)({ Steamtrain: ST });
  tree = ST.tree;
});

const T0 = 1_000_000;

function step(over: Partial<Any> & { stepId: string }): Any {
  return {
    blockKind: "worker",
    status: "pending",
    text: "",
    cached: false,
    ...over,
  };
}

function phase(over: Partial<Any> & { phaseId: string; index: number }): Any {
  return {
    title: over.phaseId,
    iteration: 1,
    done: false,
    ok: true,
    stepCount: 0,
    steps: [],
    ...over,
  };
}

/**
 * The 6a example run: two settled phases, a loop over `land` + `verdict` now in
 * its third pass, a `forEach` of twelve PRs inside it, one of whose children is
 * a `workflow` call whose own steps are running.
 */
function shipQueue(): Any {
  const fanChildren: Any[] = [];
  for (let i = 0; i < 12; i++) {
    const status = i === 4 ? "error" : i === 7 || i === 9 ? "running" : "done";
    fanChildren.push(
      step({
        stepId: `rebase[${i}]`,
        parentStepId: "rebase",
        status,
        startedAt: T0 + 300,
        endedAt: status === "done" || status === "error" ? T0 + 400 : undefined,
        ...(i === 9 ? { blockKind: "workflow", workflow: "babysit-pr" } : {}),
      }),
    );
  }
  const landPass = (iteration: number, done: boolean) =>
    phase({
      phaseId: "land",
      title: "Land each PR",
      index: 2,
      iteration,
      done,
      steps: done
        ? [step({ stepId: "review", status: "done", startedAt: T0, endedAt: T0 + 10 })]
        : [
            step({ stepId: "review", status: "done", startedAt: T0 + 100, endedAt: T0 + 200 }),
            step({
              stepId: "rebase",
              status: "running",
              forEach: "steps.prs.items",
              startedAt: T0 + 250,
            }),
            ...fanChildren,
          ],
    });
  return {
    name: "ship-queue",
    startedAt: T0,
    started: true,
    done: false,
    ok: true,
    results: [],
    loopMarkers: [],
    phases: [
      phase({
        phaseId: "collect",
        title: "Collect the queue",
        index: 0,
        done: true,
        steps: [step({ stepId: "list", status: "done", startedAt: T0, endedAt: T0 + 5 })],
      }),
      phase({
        phaseId: "triage",
        title: "Triage",
        index: 1,
        done: true,
        steps: [step({ stepId: "prs", status: "done", startedAt: T0 + 5, endedAt: T0 + 10 })],
      }),
      landPass(1, true),
      landPass(2, true),
      landPass(3, false),
      phase({
        phaseId: "verdict",
        title: "Verdict",
        index: 3,
        iteration: 3,
        steps: [
          step({
            stepId: "land-verdict",
            blockKind: "gate",
            status: "pending",
            loopTo: "land",
            maxIterations: 5,
          }),
        ],
      }),
      phase({
        phaseId: "merge",
        title: "Merge queue and announce",
        index: 4,
        steps: [step({ stepId: "merge", status: "pending" })],
      }),
      // The sub-run's own phase, namespaced by the calling step.
      phase({
        phaseId: "rebase[9]::checks-phase",
        title: "Checks",
        index: 0,
        steps: [
          step({
            stepId: "rebase[9]::pull",
            parentStepId: "rebase[9]",
            status: "done",
            startedAt: T0 + 310,
            endedAt: T0 + 320,
          }),
          step({
            stepId: "rebase[9]::comment-scan",
            parentStepId: "rebase[9]",
            status: "done",
            startedAt: T0 + 320,
            endedAt: T0 + 330,
          }),
          step({
            stepId: "rebase[9]::checks",
            parentStepId: "rebase[9]",
            status: "running",
            startedAt: T0 + 340,
            worktree: { branch: "st/rebase-9", cwd: "/tmp/st/rebase-9" },
          }),
          step({ stepId: "rebase[9]::merge-back", parentStepId: "rebase[9]", status: "pending" }),
          step({ stepId: "rebase[9]::report", parentStepId: "rebase[9]", status: "pending" }),
        ],
      }),
    ],
  };
}

function bandsOf(state: Any, ui: Any = {}) {
  return tree.buildBands(state, ui);
}

describe("a loop is one band, not one band per pass", () => {
  it("folds the loop's whole phase range into a single band with pass chips", () => {
    const bands = bandsOf(shipQueue());
    const loop = bands.find((b: Any) => b.kind === "loop");
    expect(loop).toBeTruthy();
    expect(loop.title).toBe("Land each PR");
    // Three passes have run; the gate's own cap is what says there may be five.
    expect(loop.loop.passes).toEqual([1, 2, 3]);
    expect(loop.loop.shown).toBe(3);
    expect(loop.loop.cap).toBe(5);
    expect(loop.loop.phaseRange).toBe("phases 3–4");
    // Only ONE band stands for the loop, however many passes it has run.
    expect(bands.filter((b: Any) => b.kind === "loop")).toHaveLength(1);
  });

  it("shows only the selected pass's steps", () => {
    const state = shipQueue();
    const key = bandsOf(state).find((b: Any) => b.kind === "loop").key;
    const latest = bandsOf(state).find((b: Any) => b.kind === "loop");
    // Pass 3 is mid-flight: review done, the fan-out running, the gate pending.
    expect(latest.entries.map((e: Any) => e.step.stepId)).toEqual([
      "review",
      "rebase",
      "land-verdict",
    ]);
    const first = bandsOf(state, { pass: { [key]: 1 } }).find((b: Any) => b.kind === "loop");
    expect(first.loop.shown).toBe(1);
    expect(first.entries.map((e: Any) => e.step.stepId)).toEqual(["review"]);
  });

  it("says what the previous pass left behind", () => {
    const state = shipQueue();
    const loop = bandsOf(state).find((b: Any) => b.kind === "loop");
    expect(loop.loop.previous).toContain("pass 2");
  });
});

describe("a fan-out is one row that opens", () => {
  it("keeps the twelve children out of the band's own rows", () => {
    const loop = bandsOf(shipQueue()).find((b: Any) => b.kind === "loop");
    expect(loop.entries.map((e: Any) => e.step.stepId)).not.toContain("rebase[0]");
  });

  it("carries the tally, and folds the settled children behind one count", () => {
    const state = shipQueue();
    const loop = bandsOf(state).find((b: Any) => b.kind === "loop");
    const entry = loop.entries.find((e: Any) => e.step.stepId === "rebase");
    const container = tree.containerOf(state, entry.step, entry.phase);
    expect(container.kind).toBe("fanout");
    expect(container.tally).toMatchObject({ ok: 9, running: 2, failed: 1, total: 12 });

    const rows = tree.foldChildren(container);
    // The three still in play get rows; the nine settled ones are one line.
    const own = rows.filter((r: Any) => r.entry).map((r: Any) => r.entry.step.stepId);
    expect(own).toEqual(["rebase[4]", "rebase[7]", "rebase[9]"]);
    const rolled = rows.filter((r: Any) => r.roll);
    expect(rolled).toHaveLength(1);
    expect(rolled[0].state).toBe("done");
    expect(rolled[0].roll).toHaveLength(9);
  });
});

describe("nesting that has not happened yet", () => {
  it("treats a fan-out with no children as a plain step, not an empty container", () => {
    const state = shipQueue();
    const land = state.phases[4];
    // `forEach` over an empty list: the step exists, the fan-out never did.
    land.steps = land.steps.filter((st: Any) => !st.parentStepId);
    const rebase = land.steps.find((st: Any) => st.stepId === "rebase");
    expect(tree.containerOf(state, rebase, land)).toBeNull();
    const loop = bandsOf(state).find((b: Any) => b.kind === "loop");
    expect(loop.entries.map((e: Any) => e.step.stepId)).toContain("rebase");
  });

  it("says nothing about an earlier pass on a loop that has only run once", () => {
    const state = shipQueue();
    // Drop passes 2 and 3; the gate's cap still says there may be five.
    state.phases = state.phases.filter(
      (p: Any) => !(p.phaseId === "land" && (p.iteration ?? 1) > 1),
    );
    state.phases[2].done = false;
    state.phases[2].steps = [step({ stepId: "review", status: "running", startedAt: T0 + 100 })];
    // The gate's phase is part of the loop's range, so its instance carries a
    // pass number too — pass 1 has not reached it yet.
    const gatePhase = state.phases.find((p: Any) => p.phaseId === "verdict");
    gatePhase.iteration = 1;
    const loop = bandsOf(state).find((b: Any) => b.kind === "loop");
    expect(loop.loop.passes).toEqual([1]);
    expect(loop.loop.shown).toBe(1);
    expect(loop.loop.cap).toBe(5);
    // Nothing preceded pass 1, so the strip has nothing to report about one.
    expect(loop.loop.previous).toBe("");
  });
});

describe("loop passes keep their own children", () => {
  it("never lets one pass's fan-out claim another pass's children", () => {
    const state = shipQueue();
    // Pass 2 re-runs the same phase, so the same step ids exist twice. The
    // reducer keeps one phase instance per pass; scoping on it is what keeps
    // the two apart.
    const pass2 = state.phases[3];
    pass2.done = false;
    pass2.steps = [
      step({ stepId: "rebase", status: "done", forEach: "steps.prs.items", startedAt: T0 + 20 }),
      step({ stepId: "rebase[0]", parentStepId: "rebase", status: "done", startedAt: T0 + 21 }),
    ];
    const bands = bandsOf(state);
    const loop = bands.find((b: Any) => b.kind === "loop");
    const rebase = loop.entries.find((e: Any) => e.step.stepId === "rebase");
    // Pass 3's fan-out has its own twelve, not fourteen.
    expect(tree.containerOf(state, rebase.step, rebase.phase).children).toHaveLength(12);
    const earlier = state.phases[3];
    expect(
      tree.containerOf(state, earlier.steps[0], earlier).children.map((e: Any) => e.step.stepId),
    ).toEqual(["rebase[0]"]);
  });
});

describe("a sub-workflow is a frame, not an indent", () => {
  it("hangs the child run's steps off the calling row, not off the band", () => {
    const state = shipQueue();
    // The sub-run's namespaced phase never becomes a band of its own.
    expect(bandsOf(state).map((b: Any) => b.title)).not.toContain("Checks");
    const call = tree
      .childrenOf(state, { stepId: "rebase" })
      .find((e: Any) => e.step.stepId === "rebase[9]");
    const container = tree.containerOf(state, call.step, call.phase);
    expect(container.kind).toBe("subrun");
    expect(container.children).toHaveLength(5);
  });

  it("rolls contiguous settled and queued child steps into one line each", () => {
    const state = shipQueue();
    const call = tree
      .childrenOf(state, { stepId: "rebase" })
      .find((e: Any) => e.step.stepId === "rebase[9]");
    const rows = tree.foldChildren(tree.containerOf(state, call.step, call.phase));
    expect(rows).toHaveLength(3);
    expect(rows[0].roll.map((e: Any) => e.step.stepId)).toEqual([
      "rebase[9]::pull",
      "rebase[9]::comment-scan",
    ]);
    // The one step actually working keeps its own row.
    expect(rows[1].entry.step.stepId).toBe("rebase[9]::checks");
    expect(rows[2].state).toBe("pending");
    expect(rows[2].roll.map((e: Any) => e.step.stepId)).toEqual([
      "rebase[9]::merge-back",
      "rebase[9]::report",
    ]);
  });

  it("reports how far through the child run the calling step is", () => {
    const state = shipQueue();
    const checks = state.phases.at(-1).steps[2];
    const sub = tree.subRunOf(state, checks);
    expect(sub.workflow).toBe("babysit-pr");
    expect(sub.done).toBe(2);
    expect(sub.total).toBe(5);
  });
});

describe("the address is the orientation", () => {
  it("states the full path of a step running four levels down", () => {
    const state = shipQueue();
    const bands = bandsOf(state);
    const checksPhase = state.phases.at(-1);
    const checks = checksPhase.steps[2];
    const parts = tree.addressOf(state, checksPhase, checks, bands);
    expect(parts.map((p: Any) => p.text)).toEqual([
      "Land each PR",
      "pass 3",
      "rebase[9]",
      "babysit-pr",
      "checks",
    ]);
    expect(parts.at(-1).kind).toBe("self");
    expect(parts.find((p: Any) => p.text === "babysit-pr").kind).toBe("workflow");
  });

  it("names a top-level step by its band alone", () => {
    const state = shipQueue();
    const bands = bandsOf(state);
    const land = state.phases[4];
    const parts = tree.addressOf(state, land, land.steps[0], bands);
    expect(parts.map((p: Any) => p.text)).toEqual(["Land each PR", "pass 3", "review"]);
  });
});

describe("superseded and not-yet-reached bands stop competing for space", () => {
  it("rolls adjacent settled bands into one line, and opens it again on demand", () => {
    const state = shipQueue();
    const bands = bandsOf(state);
    const rolled = bands.find((b: Any) => b.kind === "rollup");
    expect(rolled).toBeTruthy();
    expect(rolled.range).toBe("phases 1–2");
    expect(rolled.summary).toContain("2 steps");
    const opened = bandsOf(state, { unrolled: { [rolled.key]: true } });
    expect(opened.find((b: Any) => b.kind === "rollup")).toBeUndefined();
    expect(opened.map((b: Any) => b.title)).toContain("Collect the queue");
  });

  it("never rolls when nothing is running — an idle plan must show every phase", () => {
    const state = shipQueue();
    for (const p of state.phases) {
      p.done = true;
      for (const s of p.steps) s.status = "done";
    }
    expect(bandsOf(state).some((b: Any) => b.kind === "rollup")).toBe(false);
  });
});

describe("the run's shape", () => {
  it("reports only the facts this run actually has", () => {
    const shape = tree.runShape(shipQueue());
    expect(shape.loop).toEqual({ pass: 3, cap: 5 });
    expect(shape.subRuns).toBe(1);
    expect(shape.worktrees).toBe(1);
  });

  it("says nothing about loops when the workflow has none", () => {
    const state = shipQueue();
    state.phases = state.phases.filter((p: Any) => p.phaseId !== "verdict");
    expect(tree.runShape(state).loop).toBeUndefined();
  });
});
