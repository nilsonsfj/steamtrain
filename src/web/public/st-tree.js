/**
 * The live run's *shape* — the model behind the bands, computed from
 * `S.runState` alone (design turn 6, screen 6a).
 *
 * A run nests four different ways at once and 6a's rule is that each kind gets
 * its own treatment rather than another level of indentation:
 *
 *   · phases      — a band, as before.
 *   · a loop      — ONE band for the whole phase range, with a pass switcher.
 *                   Superseded passes stop competing for vertical space.
 *   · a `forEach` — ONE row that opens; settled children stay folded.
 *   · a `workflow`— ONE row that rolls up the child run; its steps open one
 *                   level in, contiguous settled/queued ones rolled to a line.
 *
 * Nothing here touches the DOM: st-run.js renders what these functions
 * describe, and the shapes are asserted directly in tests/web-run-tree.test.ts.
 * Every fact comes from something the engine actually reports — `parentStepId`
 * (set on both fan-out children and namespaced sub-run steps), the phase
 * `iteration` tag, and the loop-back gate's own `loopTo` / `maxIterations`.
 */
(function (ST) {
  "use strict";

  /** `a::b::c` is a sub-run step; `a[3]` is a fan-out child. */
  var NAMESPACE = "::";

  function isNested(phaseId) {
    return String(phaseId).indexOf(NAMESPACE) !== -1;
  }

  function allSteps(state) {
    var out = [];
    ((state && state.phases) || []).forEach(function (p) {
      (p.steps || []).forEach(function (s) { out.push({ phase: p, step: s }); });
    });
    return out;
  }

  /**
   * Parent → children and id → entry, built once per state object. The reducer
   * hands back a fresh state on every event, so object identity is a sound
   * cache key — and it has to be one: the rail re-renders every two seconds for
   * the life of the run, and every row asks whether it has children.
   */
  var idx = { state: null, byParent: {}, byId: {} };
  function index(state) {
    if (idx.state === state) return idx;
    var byParent = {}, byId = {};
    allSteps(state).forEach(function (e) {
      (byId[e.step.stepId] || (byId[e.step.stepId] = [])).push(e);
      var p = e.step.parentStepId;
      if (p) (byParent[p] || (byParent[p] = [])).push(e);
    });
    idx = { state: state, byParent: byParent, byId: byId };
    return idx;
  }

  /**
   * Whether `child` ran during THIS instance of `parent`. Used only to walk
   * *up* the tree: a nested step's own `startedAt` picks which pass of its
   * caller it belongs to when the caller's id repeats across loop passes.
   */
  function withinLifetime(child, parent) {
    if (!parent.startedAt) return true;
    if (!child.startedAt) return !parent.endedAt;
    if (child.startedAt < parent.startedAt - 1) return false;
    if (parent.endedAt && child.startedAt > parent.endedAt + 1) return false;
    return true;
  }

  /**
   * Direct children of a step: fan-out children (`id[n]`) and the steps of a
   * sub-run it called (`id::childId`). Both carry `parentStepId` from their
   * `step_start` — the engine sets it to the *executing* step id, which is
   * exactly this relation, so one lookup covers both kinds and any depth.
   *
   * The two kinds need different scoping under a loop. A fan-out child lands in
   * its caller's own phase instance, which the reducer keeps per pass, so
   * `phase` separates pass 3's twelve children from pass 2's. A sub-run's steps
   * do NOT: the child run reports its own iteration (always 1), so the reducer
   * keeps ONE instance per namespaced id and overwrites it on each pass. Those
   * are therefore always this caller's — and the pass being displayed shows the
   * newest pass's contents, which is the same display limitation the engine
   * documents for nested iteration tagging.
   */
  function childrenOf(state, step, phase) {
    var kids = index(state).byParent[step.stepId] || [];
    if (!kids.length || !phase) return kids;
    var prefix = step.stepId + NAMESPACE;
    return kids.filter(function (e) {
      if (String(e.step.stepId).indexOf(prefix) === 0) return true;
      return e.phase === phase;
    });
  }

  /** The instance of `stepId` that was running when `at` happened. */
  function findStepAt(state, stepId, at) {
    var entries = index(state).byId[stepId] || [];
    if (!entries.length) return null;
    for (var i = 0; i < entries.length; i++) {
      if (withinLifetime({ startedAt: at }, entries[i].step)) return entries[i];
    }
    return entries[entries.length - 1];
  }

  /**
   * A step and everything nested under it, depth-first. The band's own header
   * has to know that work is in flight three levels down inside a sub-run —
   * those steps live in namespaced phases the band never lists.
   */
  function stepsUnder(state, step, phase, depth) {
    var out = [step];
    if ((depth || 0) > 8) return out;
    childrenOf(state, step, phase).forEach(function (e) {
      out = out.concat(stepsUnder(state, e.step, e.phase, (depth || 0) + 1));
    });
    return out;
  }

  /** A fan-out child is `parent[n]`; anything else under a parent is a sub-run step. */
  function isFanChild(step) {
    return /\[\d+\]$/.test(String(step.stepId || ""));
  }

  /**
   * The workflow a call step invokes. `StepState.workflow` is seeded from the
   * spec, so it is set on the call step itself but NOT on its fan-out children
   * (`rebase[4]`), which only ever exist at run time. The renderer installs a
   * resolver that maps a runtime id back to its catalog step.
   */
  var resolveWorkflowName = null;
  function setWorkflowResolver(fn) {
    resolveWorkflowName = fn;
  }
  function workflowOf(step) {
    if (!step) return undefined;
    if (step.workflow) return step.workflow;
    if (step.blockKind !== "workflow" || !resolveWorkflowName) return undefined;
    return resolveWorkflowName(step.stepId) || undefined;
  }

  /** True when this step's children are a whole other workflow's steps. */
  function isSubRunCall(state, step) {
    if (step.blockKind === "workflow" || step.workflow) return true;
    return childrenOf(state, step).some(function (e) {
      return String(e.step.stepId).indexOf(step.stepId + NAMESPACE) === 0;
    });
  }

  function settled(step) {
    return step.status === "done" || step.status === "error";
  }

  /**
   * What a step *contains*, or null when it is a leaf. `kind` decides how the
   * children fold: a fan-out hides its settled children behind a count (twelve
   * PRs, nine of them done, is a count and not nine rows), while a sub-run
   * keeps its child's own order and rolls only contiguous settled/queued runs.
   */
  function containerOf(state, step, phase) {
    var kids = childrenOf(state, step, phase);
    if (!kids.length) return null;
    var fan = kids.some(function (e) { return isFanChild(e.step); });
    var ok = 0, failed = 0, running = 0, queued = 0;
    kids.forEach(function (e) {
      if (e.step.status === "error") failed += 1;
      else if (e.step.status === "done") ok += 1;
      else if (e.step.status === "running") running += 1;
      else queued += 1;
    });
    return {
      kind: fan ? "fanout" : "subrun",
      children: kids,
      tally: { ok: ok, failed: failed, running: running, queued: queued, total: kids.length }
    };
  }

  /**
   * Fan-out children, 6a's way: the ones still in play get rows, everything
   * settled collapses to one count line the reader can open.
   */
  function foldFanChildren(children, unfolded) {
    if (unfolded) return children.map(function (e) { return { entry: e }; });
    var rows = [], done = [], pending = [];
    children.forEach(function (e) {
      if (e.step.status === "running" || e.step.status === "error") rows.push({ entry: e });
      else if (e.step.status === "done") done.push(e);
      else pending.push(e);
    });
    if (done.length) rows.push({ roll: done, state: "done" });
    if (pending.length) rows.push({ roll: pending, state: "pending" });
    return rows;
  }

  /**
   * Sub-run children keep the child workflow's own order; contiguous settled
   * (or contiguous queued) steps roll into a single line, so "pull ·
   * comment-scan · fix-review — 3 steps ok" replaces three rows while the one
   * step actually working keeps its own.
   */
  function foldSubChildren(children, unfolded) {
    if (unfolded) return children.map(function (e) { return { entry: e }; });
    var rows = [], run = null, runState = null;
    function flush() {
      if (!run) return;
      rows.push(run.length === 1 ? { entry: run[0] } : { roll: run, state: runState });
      run = null;
      runState = null;
    }
    children.forEach(function (e) {
      var st = e.step.status === "done" ? "done" : e.step.status === "pending" ? "pending" : null;
      // A failed or running step is always its own row — it is the thing the
      // reader came for.
      if (!st) { flush(); rows.push({ entry: e }); return; }
      if (runState !== st) { flush(); runState = st; run = []; }
      run.push(e);
    });
    flush();
    return rows;
  }

  /** Rows for an opened container, folded by its kind. */
  function foldChildren(container, unfolded) {
    return container.kind === "fanout"
      ? foldFanChildren(container.children, unfolded)
      : foldSubChildren(container.children, unfolded);
  }

  // ---- loops ----------------------------------------------------------------

  /**
   * The phase ranges a loop-back gate re-runs, as `{ gateStepId, loopTo, from,
   * to, cap }` over top-level phase indices. Read off the gate steps' own
   * `loopTo`/`maxIterations` (which land on `step_start` and are seeded from
   * the spec), so a loop is a band from the first render — before any pass has
   * completed and produced a `loop_iteration` marker.
   */
  function loopRanges(topPhases) {
    var indexById = {};
    topPhases.forEach(function (p) { if (!(p.phaseId in indexById)) indexById[p.phaseId] = p.index; });
    var ranges = [];
    topPhases.forEach(function (p) {
      (p.steps || []).forEach(function (s) {
        if (!s.loopTo) return;
        var from = indexById[s.loopTo];
        if (typeof from !== "number") return;
        var to = p.index;
        if (to < from) return;
        var dup = ranges.some(function (r) { return r.gateStepId === s.stepId; });
        if (dup) return;
        ranges.push({ gateStepId: s.stepId, loopTo: s.loopTo, from: from, to: to, cap: s.maxIterations });
      });
    });
    // Outermost first, so a nested loop never steals its parent's phases.
    ranges.sort(function (a, b) { return a.from - b.from || b.to - a.to; });
    var taken = [];
    return ranges.filter(function (r) {
      var overlaps = taken.some(function (t) { return r.from <= t.to && r.to >= t.from; });
      if (overlaps) return false;
      taken.push(r);
      return true;
    });
  }

  /** Every pass number seen for a loop's phase range, ascending. */
  function passesOf(members) {
    var seen = {};
    members.forEach(function (p) { seen[p.iteration || 1] = true; });
    return Object.keys(seen).map(Number).sort(function (a, b) { return a - b; });
  }

  /**
   * What the pass before the shown one left behind — the sentence under the
   * pass chips. The gate's own blocked verdict when it recorded one, else the
   * failure count, else how the pass ended. Never a guess.
   */
  function passSummary(members, pass, gateStepId) {
    if (pass < 1) return "";
    var failed = 0, gate = null;
    members.forEach(function (p) {
      if ((p.iteration || 1) !== pass) return;
      (p.steps || []).forEach(function (s) {
        if (s.status === "error") failed += 1;
        if (s.stepId === gateStepId) gate = s;
      });
    });
    if (gate && gate.result && gate.result.output) {
      var line = String(gate.result.output).split("\n")[0].trim();
      if (line) return "pass " + pass + " ended with " + line.slice(0, 90);
    }
    if (failed) return "pass " + pass + " ended with " + failed + " step" + (failed === 1 ? "" : "s") + " failed";
    if (gate && gate.gate && gate.gate.passed === false) return "pass " + pass + " did not satisfy the gate";
    return "pass " + pass + " completed";
  }

  // ---- bands -----------------------------------------------------------------

  /**
   * A band's state, read from every step it *owns* — including the ones nested
   * inside a sub-run, which live in namespaced phases the band never lists.
   * Without the descendants a band whose only activity is three levels down
   * reads as queued while an agent streams inside it.
   */
  function bandStateOf(state, members, entries) {
    var owned = [];
    entries.forEach(function (e) { owned = owned.concat(stepsUnder(state, e.step, e.phase)); });
    if (owned.some(function (s) { return s.status === "running"; })) return "running";
    if (members.every(function (p) { return p.done; })) return "done";
    if (owned.some(settled)) return "running";
    return "queued";
  }

  /**
   * The bands, in phase order. Loops fold their whole range into one band;
   * adjacent bands that are entirely settled (or entirely queued) roll into a
   * single summary band, which is what keeps 6a's "the reader only ever holds
   * two levels at once" true on a run with seven phases and four kinds of
   * nesting. A rolled band opens back into its members on click (`unrolled`).
   *
   * `ui` is the reader's own state: `{ pass: {bandKey: n}, unrolled: {key:1} }`.
   */
  function buildBands(state, ui) {
    ui = ui || {};
    var phases = ((state && state.phases) || []).filter(function (p) { return !isNested(p.phaseId); });
    if (!phases.length) return [];
    var ranges = loopRanges(phases);
    var rangeFor = function (p) {
      for (var i = 0; i < ranges.length; i++) {
        if (p.index >= ranges[i].from && p.index <= ranges[i].to) return ranges[i];
      }
      return null;
    };

    var groups = [], byLoop = {};
    phases.forEach(function (p) {
      var range = rangeFor(p);
      if (!range) { groups.push({ loop: null, members: [p], index: p.index }); return; }
      var g = byLoop[range.gateStepId];
      if (!g) {
        g = byLoop[range.gateStepId] = { loop: range, members: [], index: range.from };
        groups.push(g);
      }
      g.members.push(p);
    });
    groups.sort(function (a, b) { return a.index - b.index; });

    var bands = groups.map(function (g) {
      var band = {
        kind: g.loop ? "loop" : "phase",
        index: g.index,
        members: g.members,
        title: g.members[0].title || g.members[0].phaseId,
        state: "queued",
        entries: []
      };
      band.key = (g.loop ? "loop:" + g.loop.gateStepId : "phase:" + g.members[0].phaseId) + ":" + band.title;
      if (g.loop) {
        var passes = passesOf(g.members);
        var latest = passes.length ? passes[passes.length - 1] : 1;
        var want = ui.pass && ui.pass[band.key];
        var shown = passes.indexOf(want) === -1 ? latest : want;
        var span = g.loop.to - g.loop.from + 1;
        band.loop = {
          gateStepId: g.loop.gateStepId,
          loopTo: g.loop.loopTo,
          cap: g.loop.cap,
          passes: passes,
          shown: shown,
          latest: latest,
          phaseRange: span > 1 ? "phases " + (g.loop.from + 1) + "–" + (g.loop.to + 1) : "phase " + (g.loop.from + 1),
          previous: shown > 1 ? passSummary(g.members, shown - 1, g.loop.gateStepId) : ""
        };
      }
      var pass = band.loop ? band.loop.shown : null;
      band.members.forEach(function (p) {
        if (pass !== null && (p.iteration || 1) !== pass) return;
        (p.steps || []).forEach(function (s) {
          // Children render inside the row that owns them, never as siblings.
          if (s.parentStepId) return;
          band.entries.push({ phase: p, step: s });
        });
      });
      band.stepCount = band.entries.length;
      band.state = bandStateOf(state, band.members, band.entries);
      return band;
    });

    return rollAdjacent(bands, ui.unrolled || {});
  }

  /**
   * Fold runs of ≥2 adjacent all-settled (or all-queued) bands into one
   * summary band. Only ever applies around live work: with nothing running,
   * every band is settled and rolling them all would hide the whole run.
   */
  function rollAdjacent(bands, unrolled) {
    if (!bands.some(function (b) { return b.state === "running"; })) return bands;
    var out = [], run = [], runState = null;
    function flush() {
      if (!run.length) return;
      if (run.length < 2) { out.push(run[0]); run = []; runState = null; return; }
      var key = "roll:" + runState + ":" + run[0].key;
      if (unrolled[key]) run.forEach(function (b) { out.push(b); });
      else out.push(rolledBand(run, runState, key));
      run = [];
      runState = null;
    }
    bands.forEach(function (b) {
      // A loop band always keeps its own header: its pass switcher is the
      // reader's only way back into the earlier passes.
      if (b.kind === "loop" || (b.state !== "done" && b.state !== "queued")) {
        flush();
        out.push(b);
        return;
      }
      if (runState !== b.state) flush();
      runState = b.state;
      run.push(b);
    });
    flush();
    return out;
  }

  function rolledBand(members, state, key) {
    var steps = 0, ok = 0;
    var phases = [];
    members.forEach(function (b) {
      b.members.forEach(function (p) { phases.push(p); });
      b.entries.forEach(function (e) {
        steps += 1;
        if (e.step.status === "done") ok += 1;
      });
    });
    var first = members[0], last = members[members.length - 1];
    return {
      kind: "rollup",
      key: key,
      rolled: members,
      index: first.index,
      members: phases,
      state: state,
      title: first.title || "",
      range: "phases " + (first.index + 1) + "–" + (last.index + 1),
      summary: state === "done"
        ? steps + " step" + (steps === 1 ? "" : "s") + (ok === steps ? " ok" : " · " + ok + " ok")
        : steps + " step" + (steps === 1 ? "" : "s") + " queued",
      entries: []
    };
  }

  // ---- the address -----------------------------------------------------------

  /**
   * The full path of a step — 6a's orientation device: `land › pass 3 ›
   * rebase[#9] › babysit-pr › checks`. Because the address exists, the spine
   * is free to fold aggressively: nothing gets lost, it gets named.
   *
   * Returns `[{ text, kind }]`, newest last; `kind` is "phase" | "pass" |
   * "step" | "workflow" | "self" so the rail can tint the sub-run name.
   */
  function addressOf(state, phase, step, bands) {
    var parts = [];
    var chain = ancestorsOf(state, step);
    var root = chain.length ? chain[0].step : step;
    var rootPhase = (chain.length ? chain[0].phase : phase) || phase;
    var band = bandFor(bands, root);
    parts.push({ text: (band && band.title) || (rootPhase && rootPhase.title) || "", kind: "phase" });
    if (band && band.loop) parts.push({ text: "pass " + (rootPhase.iteration || 1), kind: "pass" });
    chain.forEach(function (e, i) {
      // A fan-out parent is implied by its child's id (`rebase` → `rebase[9]`),
      // so naming both would spend a segment saying the same thing twice.
      var next = chain[i + 1];
      var child = next ? next.step : step;
      if (String(child.stepId).indexOf(e.step.stepId + "[") === 0) return;
      parts.push({ text: leafId(e.step), kind: "step" });
      // A `workflow` call step names the workflow it is running: the frame the
      // steps below it belong to.
      var wf = workflowOf(e.step);
      if (wf) parts.push({ text: wf, kind: "workflow" });
    });
    parts.push({ text: leafId(step), kind: "self" });
    return parts.filter(function (p) { return p.text; });
  }

  /** The step's own id, without the sub-run namespace its ancestors already state. */
  function leafId(step) {
    var id = String(step.stepId || "");
    var at = id.lastIndexOf(NAMESPACE);
    return at === -1 ? id : id.slice(at + NAMESPACE.length);
  }

  /**
   * The chain of enclosing steps, outermost first — the calling `forEach` step,
   * then the `workflow` step, and so on. Each hop picks the ancestor INSTANCE
   * that was running when this step started, so a loop's third pass never
   * addresses itself through the first pass's caller.
   */
  function ancestorsOf(state, step) {
    var chain = [], seen = {}, cur = step, hops = 0;
    while (cur && cur.parentStepId && !seen[cur.stepId] && hops < 16) {
      seen[cur.stepId] = true;
      hops += 1;
      var parent = findStepAt(state, cur.parentStepId, cur.startedAt);
      if (!parent) break;
      chain.unshift(parent);
      cur = parent.step;
    }
    return chain;
  }

  function bandFor(bands, step) {
    var hit = null;
    (bands || []).forEach(function (b) {
      (b.entries || []).forEach(function (e) { if (!hit && e.step === step) hit = b; });
      (b.rolled || []).forEach(function (inner) {
        (inner.entries || []).forEach(function (e) { if (!hit && e.step === step) hit = inner; });
      });
    });
    return hit;
  }

  /**
   * The sub-run a step belongs to, for the rail's SUB-RUN block: the nearest
   * `workflow` ancestor, with how far through its steps the child run is.
   */
  function subRunOf(state, step, phase) {
    // The step itself first: a call row's own child run is what its rail
    // should report, not the fan-out that generated it.
    var own = subRunFrame(state, step, phase);
    if (own) return own;
    var chain = ancestorsOf(state, step);
    for (var i = chain.length - 1; i >= 0; i--) {
      var frame = subRunFrame(state, chain[i].step, chain[i].phase);
      if (frame) return frame;
    }
    return null;
  }

  /**
   * The child run `step` is driving, or null when it drives none. A `forEach`
   * parent is deliberately not a frame: its children are more of ITSELF (the
   * same step over twelve items), while a `workflow` call's children are
   * another workflow's steps — namespaced under the caller's id, which is
   * exactly the test used here.
   */
  function subRunFrame(state, step, phase) {
    var kids = childrenOf(state, step, phase);
    var prefix = step.stepId + NAMESPACE;
    var own = kids.filter(function (e) { return String(e.step.stepId).indexOf(prefix) === 0; });
    if (!own.length) return null;
    return {
      callStepId: step.stepId,
      workflow: workflowOf(step),
      steps: own.map(function (e) { return e.step; }),
      done: own.filter(function (e) { return settled(e.step); }).length,
      total: own.length
    };
  }

  // ---- run shape -------------------------------------------------------------

  /**
   * The three facts 6a hangs in the left rail's footer: how far the loop has
   * got, how many sub-runs are in flight, how many worktrees are open. Each is
   * omitted when the run has no such thing, rather than shown as a zero.
   */
  function runShape(state) {
    var phases = (state && state.phases) || [];
    var top = phases.filter(function (p) { return !isNested(p.phaseId); });
    var shape = {};
    var ranges = loopRanges(top);
    if (ranges.length) {
      var members = top.filter(function (p) {
        return ranges.some(function (r) { return p.index >= r.from && p.index <= r.to; });
      });
      var passes = passesOf(members);
      shape.loop = { pass: passes[passes.length - 1] || 1, cap: ranges[0].cap };
    }
    var subRuns = 0, worktrees = {};
    allSteps(state).forEach(function (e) {
      if (e.step.status === "running" && subRunFrame(state, e.step, e.phase)) subRuns += 1;
      if (e.step.worktree && e.step.worktree.branch) worktrees[e.step.worktree.branch] = true;
    });
    if (subRuns) shape.subRuns = subRuns;
    var open = Object.keys(worktrees).length;
    if (open) shape.worktrees = open;
    return shape;
  }

  ST.tree = {
    isNestedPhaseId: isNested,
    childrenOf: childrenOf,
    stepsUnder: stepsUnder,
    containerOf: containerOf,
    foldChildren: foldChildren,
    buildBands: buildBands,
    loopRanges: loopRanges,
    addressOf: addressOf,
    ancestorsOf: ancestorsOf,
    leafId: leafId,
    subRunOf: subRunOf,
    isSubRunCall: isSubRunCall,
    subRunFrame: subRunFrame,
    workflowOf: workflowOf,
    setWorkflowResolver: setWorkflowResolver,
    runShape: runShape
  };
})(window.Steamtrain);
