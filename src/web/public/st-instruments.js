/**
 * Instruments surface: the right-hand rail (#rail-right). Five stacked
 * read-outs over the live run — Spend, Throughput, Runners in flight,
 * Worktrees, Event log — built from `S.runState` alone (no separate poll).
 *
 * Every number here must be something the engine actually reports. Where it
 * doesn't (a live worktree diffstat, a workflow with no declared budget), the
 * instrument renders an honest gap (a dash, an absent row) rather than a
 * fabricated value.
 */
(function (ST) {
  "use strict";

  var S = ST.state;
  var h = ST.h;
  var fmtTokens = ST.fmtTokens;
  var fmtElapsed = ST.fmtElapsed;
  var addTokensInto = ST.addTokensInto;
  var emptyTokens = ST.emptyTokens;
  var totalTokens = ST.totalTokens; // takes a token-sum object, e.g. { input, output, ... }

  var THROUGHPUT_WINDOW_MS = 60000;
  var THROUGHPUT_TICK_MS = 2000;
  var EVENT_LOG_CAP = 200;

  // Own timer handle, not on S: nothing outside this module needs to see it,
  // and keeping it module-local means reset()/tick() are the only two places
  // that can touch it — easy to audit for leaks.
  var throughputTimer = null;

  // ---- shared readouts over the live run -----------------------------------

  function flattenSteps() {
    var out = [];
    if (S.runState) {
      S.runState.phases.forEach(function (p) {
        p.steps.forEach(function (s) { out.push(s); });
      });
    }
    return out;
  }

  /** Cost/token/completion totals from the live step tree (not `runState.results`,
   *  which the reducer only populates once, on `workflow_done`). */
  function liveTotals() {
    var steps = flattenSteps();
    var spent = 0, tokens = emptyTokens(), completed = 0, cachedN = 0;
    steps.forEach(function (s) {
      if (s.result) {
        spent += s.result.costUsd || 0;
        addTokensInto(tokens, s.result.tokens);
      }
      if (s.status === "done" || s.status === "error") completed += 1;
      if (s.cached) cachedN += 1;
    });
    return { spent: spent, tokens: tokens, completed: completed, total: steps.length, cachedN: cachedN };
  }

  function cells(pairs) {
    var row = h("div", { class: "spend-cells" });
    pairs.forEach(function (p) {
      row.appendChild(h("div", null,
        h("div", { class: "k", text: p[0] }),
        h("div", { class: "v", text: p[1] })
      ));
    });
    return row;
  }

  // ---- Spend ----------------------------------------------------------------

  function renderSpend(totals, spec) {
    var spent = totals.spent, completed = totals.completed, total = totals.total;
    var box = h("div", { class: "inst" });
    box.appendChild(h("div", { class: "inst-label", text: "Spend" }));
    // Per-workflow field (spec.maxCostUsd), not global config — most workflows
    // don't declare one, and that is the normal case, not a missing value.
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
      ["Tokens", fmtTokens(totalTokens(totals.tokens))],
      ["Cache hits", totals.cachedN + " / " + total]
    ]));
    return box;
  }

  // ---- Throughput -------------------------------------------------------------

  function currentTotalTokens() {
    return totalTokens(liveTotals().tokens);
  }

  function tickThroughput() {
    // Defensive: a leaked timer is the one bug this instrument cannot afford.
    // If the run this meter belongs to is gone, stop rather than keep ticking
    // a meter nobody reads.
    if (!S.runState || !S.runState.started || S.runState.done) { stopThroughputTimer(); return; }
    if (!S.throughput) S.throughput = SteamtrainReducer.createThroughputMeter(THROUGHPUT_WINDOW_MS);
    S.throughput.sample(currentTotalTokens(), Date.now());
  }

  function startThroughputTimer() {
    stopThroughputTimer();
    S.throughput = SteamtrainReducer.createThroughputMeter(THROUGHPUT_WINDOW_MS);
    tickThroughput();
    throughputTimer = setInterval(function () {
      tickThroughput();
      ST.scheduleRender();
    }, THROUGHPUT_TICK_MS);
  }

  function stopThroughputTimer() {
    if (throughputTimer) { clearInterval(throughputTimer); throughputTimer = null; }
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

  function renderThroughput() {
    var box = h("div", { class: "inst" });
    box.appendChild(h("div", { class: "inst-head" },
      h("div", { class: "inst-label", text: "Throughput" }),
      h("span", { class: "note", text: "tok/s, last 60s" })
    ));
    box.appendChild(renderSpark(S.throughput));
    return box;
  }

  // ---- Runners in flight ------------------------------------------------------

  function renderRunners() {
    var box = h("div", { class: "inst" });
    box.appendChild(h("div", { class: "inst-label", text: "Runners in flight" }));
    var list = h("div", { class: "runners" });
    var steps = flattenSteps();
    // Enumerate every configured agent so idle runners still appear, not just
    // the ones currently busy.
    (S.agents || []).forEach(function (a) {
      var running = steps.filter(function (s) { return s.status === "running" && s.agent === a.id; });
      if (running.length) {
        running.forEach(function (s) {
          list.appendChild(h("div", { class: "runner busy" },
            h("span", { class: "dot" }),
            h("span", { text: a.label || a.id }),
            h("span", { class: "model", text: s.model || "" }),
            h("span", {
              class: "right",
              "data-since": String(s.startedAt || ""),
              text: s.startedAt ? "⏱ " + fmtElapsed(Date.now() - s.startedAt) : ""
            })
          ));
        });
      } else {
        var queued = steps.filter(function (s) { return s.status === "pending" && s.agent === a.id; }).length;
        list.appendChild(h("div", { class: "runner" },
          h("span", { class: "dot" }),
          h("span", { text: a.label || a.id }),
          h("span", { class: "model", text: "idle" }),
          h("span", { class: "right", text: queued ? queued + " queued" : "" })
        ));
      }
    });
    box.appendChild(list);
    return box;
  }

  // ---- Worktrees --------------------------------------------------------------

  function renderWorktrees() {
    var box = h("div", { class: "inst" });
    box.appendChild(h("div", { class: "inst-label", text: "Worktrees" }));
    var list = h("div", { class: "worktrees" });
    var seen = {};
    flattenSteps().forEach(function (s) {
      if (!s.worktree || !s.worktree.branch) return;
      if (seen[s.worktree.branch]) return;
      seen[s.worktree.branch] = true;
      var live = s.status === "running";
      // No live diffstat is available mid-run (only after the step finishes and
      // the worktree is inspected) — render the branch alone rather than a
      // fabricated "+0".
      list.appendChild(h("div", { class: "worktree" + (live ? " live" : ""), title: s.worktree.cwd },
        h("span", { class: "mark", text: "⎇" }),
        h("span", { class: "branch", text: s.worktree.branch })
      ));
    });
    box.appendChild(list);
    return box;
  }

  // ---- Event log ----------------------------------------------------------------

  /** One line per event kind worth surfacing; `null` skips the (very chatty) rest. */
  function formatEvent(ev) {
    switch (ev.kind) {
      case "workflow_start": return { text: "▶ run started" };
      case "phase_start": return { text: "phase " + ev.title };
      case "phase_done": return { text: (ev.ok ? "✓" : "✗") + " phase done" };
      case "fan_out": return { text: "⇉ " + ev.parentStepId + " × " + ev.count };
      case "step_start": return { text: "▶ " + ev.stepId };
      case "step_retry": return { text: "↻ retry " + ev.stepId + " (" + ev.attempt + "/" + ev.maxAttempts + ")" };
      case "gate_evaluated": return { text: "gate " + ev.stepId + (ev.passed ? " passed" : " blocked") };
      case "step_done": return { text: (ev.result && ev.result.ok ? "✓" : "✗") + " " + ev.stepId, cached: Boolean(ev.cached) };
      case "budget_exceeded": return { text: "⚠ budget exceeded ($" + ev.spentUsd.toFixed(4) + " / $" + ev.limitUsd.toFixed(2) + ")" };
      case "approval_pending": return { text: "⏳ approval " + ev.stepId };
      case "approval_resolved": return { text: (ev.approved ? "✓ approved " : "✗ rejected ") + ev.stepId };
      case "human_input_pending": return { text: "✎ awaiting input " + ev.stepId };
      case "human_input_resolved": return { text: (ev.canceled ? "✗ input canceled " : "✎ input received ") + ev.stepId };
      case "run_paused": return { text: "⏸ run paused" };
      case "run_resumed": return { text: "▶ run resumed" };
      case "step_edited": return { text: "✎ edited " + ev.stepId };
      case "loop_iteration": return { text: "↻ loop → " + ev.loopTo + " (iter " + ev.iteration + ")" };
      case "workflow_done": return { text: ev.ok ? "■ run complete" : "■ run failed" };
      default: return null; // step_event (per-token deltas), step_workspace: too chatty
    }
  }

  function fmtRelClock(atMs, startedAt) {
    if (typeof startedAt !== "number" || !startedAt) return "--:--";
    var ms = Math.max(0, atMs - startedAt);
    var totalSec = Math.floor(ms / 1000);
    var mm = Math.floor(totalSec / 60);
    var ss = totalSec % 60;
    return String(mm).padStart(2, "0") + ":" + String(ss).padStart(2, "0");
  }

  function pushEventLog(ev) {
    // A fresh run's own workflow_start clears whatever the log held before —
    // covers startRun() (which resets S.narration the same way but never
    // touches S.eventLog) *and* re-attaching/reconnecting to a run whose
    // stream replays from the top, neither of which routes through
    // selectWorkflow()/reset(). Without this, a re-run of the same workflow
    // leaves the previous run's entries in place, and fmtRelClock() then
    // times them against the new run's startedAt (they clamp to 00:00 and
    // interleave with the new entries under one mistimed clock).
    if (ev.kind === "workflow_start") S.eventLog = [];
    var formatted = formatEvent(ev);
    if (!formatted) return;
    var atMs = typeof ev.ts === "number" ? ev.ts : Date.now();
    if (!S.eventLog) S.eventLog = [];
    S.eventLog.unshift({ atMs: atMs, text: formatted.text, cached: Boolean(formatted.cached) });
    if (S.eventLog.length > EVENT_LOG_CAP) S.eventLog.length = EVENT_LOG_CAP;
  }

  function renderEventLog() {
    var box = h("div", { class: "inst eventlog" });
    box.appendChild(h("div", { class: "inst-label", text: "Event log" }));
    var rows = h("div", { class: "rows" });
    var startedAt = S.runState && S.runState.startedAt;
    (S.eventLog || []).forEach(function (entry) {
      var row = h("div", null,
        h("span", { class: "at", text: fmtRelClock(entry.atMs, startedAt) }),
        " " + entry.text
      );
      if (entry.cached) row.appendChild(h("span", { class: "cached", text: " · cached" }));
      rows.appendChild(row);
    });
    box.appendChild(rows);
    return box;
  }

  // ---- public surface ---------------------------------------------------------

  function render(container) {
    ST.clear(container);
    var spec = (ST.run && ST.run.effectiveSpec ? ST.run.effectiveSpec() : null) || S.spec;
    var totals = liveTotals();
    container.appendChild(renderSpend(totals, spec));
    container.appendChild(renderThroughput());
    container.appendChild(renderRunners());
    container.appendChild(renderWorktrees());
    container.appendChild(renderEventLog());
  }

  /** Called from the SSE handler (st-core.js openStream) for every WorkflowEvent. */
  function onEvent(ev) {
    pushEventLog(ev);
    if (ev.kind === "workflow_start") {
      startThroughputTimer();
    } else if (ev.kind === "workflow_done") {
      stopThroughputTimer();
    }
  }

  /** Clears the rail's per-run state (throughput meter/timer, event log) when
   *  the reader leaves the current run — e.g. picking a different workflow.
   *  Complements the defensive stop inside tickThroughput() so the interval
   *  never outlives the run it was sampling, however the run ends. */
  function reset() {
    stopThroughputTimer();
    S.throughput = null;
    S.eventLog = [];
  }

  ST.instruments = {
    render: render,
    onEvent: onEvent,
    reset: reset
  };
})(window.Steamtrain);
