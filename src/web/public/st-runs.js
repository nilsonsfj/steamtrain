/**
 * Runs surface: the run browser page (#runs, see parseRoute/runsDeepLink in the
 * reducer bundle). Replaces the old full-screen history modal.
 *
 * Three columns, same geometry as the cockpit and the settings page: a 236px
 * filter rail, the run table, and a 340px receipt rail. Clicking a row selects
 * it into the receipt — never a modal, never a navigation — which is the same
 * click-selects-into-the-rail rule the run cockpit uses for steps. Comparing
 * runs is the row checkbox, not a separate screen.
 *
 * The centre pane has three views: the table (`list`), one run's full receipt
 * with its worktree lifecycle actions (`receipt`), and the side-by-side
 * comparison of the checked runs (`compare`). The rails stay put across all
 * three so the reader never loses the list.
 */
(function (ST) {
  "use strict";
  var S = ST.state;
  var h = ST.h;
  var activateWithKeyboard = ST.activateWithKeyboard;
  var aggregateByModel = ST.aggregateByModel;
  var api = ST.api;
  var apiAuth = ST.apiAuth;
  var attachRun = ST.attachRun;
  var clear = ST.clear;
  var fmtTime = ST.fmtTime;
  var fmtTokenSummary = ST.fmtTokenSummary;
  var fmtTokens = ST.fmtTokens;
  var fmtTotals = ST.fmtTotals;
  var isReadOnly = ST.isReadOnly;
  var KIND_LABEL = ST.KIND_LABEL;
  var relTime = ST.relTime;
  var totalTokens = ST.totalTokens;
  var truncate = ST.truncate;

  /** Rows shown before "load N older runs"; each click adds another page. */
  var PAGE_SIZE = 40;
  /** Bars in the rail's spend sparkline, oldest → newest. */
  var SPARK_BARS = 12;

  /**
   * Status filters, in rail order. Every `id` but `all` and `live` is a
   * RunRecordStatus matched against a recorded summary; `live` selects the
   * in-flight runs instead, which have no recorded status yet.
   */
  var STATUS_FILTERS = [
    { id: "all", label: "All runs" },
    { id: "live", label: "Running", tone: "running" },
    { id: "error", label: "Failed", tone: "error" },
    { id: "budget-exceeded", label: "Budget", tone: "gate" },
    { id: "canceled", label: "Canceled", tone: "faint" },
    { id: "done", label: "Done", tone: "done" }
  ];

  var R = {
    mount: null,
    runs: [],            // recorded summaries, newest first (GET /api/history)
    liveRuns: [],        // in-flight runs (GET /api/runs)
    loaded: false,
    loadError: null,
    status: "all",
    workflow: null,      // null ⇒ every workflow
    query: "",
    limit: PAGE_SIZE,
    selectedId: null,    // the run in the receipt rail
    record: null,        // its full record, once fetched
    recordError: null,
    compare: [],         // checked run ids, in click order
    view: "list",
    pollTimer: null,
    request: 0,
    recordRequest: 0,
    fingerprint: "",
    // Which full-receipt step lines have their recorded output open, keyed
    // "<runId>:<stepId>" so opening one on one run says nothing about another.
    receiptOpen: {}
  };

  // Per-step worktree patches, fetched lazily by the full-receipt view and
  // cached per run so re-expanding a step never refetches, plus which step rows
  // are expanded (survives that section's re-renders).
  var Diff = {
    cache: new Map(),    // runId -> Map(stepId -> worktree-detail body)
    expanded: new Map(), // runId -> Set(stepId)
    inflight: new Set()  // "runId:stepId" currently being fetched
  };

  // ---- route -----------------------------------------------------------------

  /** Navigate to the page, optionally with `runId` selected into the receipt. */
  function open(runId) {
    var link = (window.SteamtrainReducer && window.SteamtrainReducer.runsDeepLink)
      ? window.SteamtrainReducer.runsDeepLink(normalizeRunId(runId))
      : (normalizeRunId(runId) ? "#runs/" + runId.toLowerCase() : "#runs");
    if (window.location.hash === link) {
      S.pageReturnOverride = null;
      render(R.mount, normalizeRunId(runId));
    } else {
      window.location.hash = link;
    }
  }

  /** Only a non-empty string is a run id — never a DOM Event from an onClick. */
  function normalizeRunId(runId) {
    return typeof runId === "string" && runId.length > 0 ? runId : null;
  }

  /**
   * Paint the page into `container`. Called by the router on every navigation
   * into #runs, including section-only changes (#runs → #runs/<id>), so it must
   * be idempotent and must not reset the reader's filters.
   */
  function render(container, runId) {
    if (!container) return;
    R.mount = container;
    var wanted = normalizeRunId(runId);
    if (wanted !== R.selectedId) selectRun(wanted, { fromRoute: true });
    // Deep-linking straight to a run should show that run, not the last view
    // this page happened to be left on.
    if (wanted && R.view === "compare") R.view = "list";
    if (!R.loaded) refresh({ silent: false });
    startPoll();
    paint();
  }

  /** Router hook: stop polling when the page is hidden (it is never unmounted). */
  function onLeave() {
    stopPoll();
  }

  function startPoll() {
    if (R.pollTimer) return;
    R.pollTimer = setInterval(function () {
      if (S.page !== "runs") return;
      refresh({ silent: true });
    }, 2500);
  }

  function stopPoll() {
    if (!R.pollTimer) return;
    clearInterval(R.pollTimer);
    R.pollTimer = null;
  }

  // ---- data ------------------------------------------------------------------

  function refresh(opts) {
    opts = opts || {};
    var req = ++R.request;
    return Promise.all([
      apiAuth("GET", "/api/history"),
      api("GET", "/api/runs").catch(function () { return { status: 0, body: {} }; })
    ]).then(function (results) {
      if (req !== R.request) return;
      var histRes = results[0];
      var liveRes = results[1];
      var nextRuns = (histRes.body && histRes.body.runs) || [];
      var nextLive = R.liveRuns;
      if (liveRes && liveRes.status === 200) {
        nextLive = (liveRes.body.runs || []).filter(function (run) {
          return run.status === "running" || run.status === "queued";
        });
        S.liveRuns = nextLive.slice();
        ST.shell.renderLiveRuns();
      }
      var fingerprint = listFingerprint(nextRuns, nextLive);
      var changed = fingerprint !== R.fingerprint;
      R.runs = nextRuns;
      R.liveRuns = nextLive;
      R.fingerprint = fingerprint;
      R.loaded = true;
      R.loadError = null;
      // A silent poll repaints only when something actually moved: the page
      // holds a focused search box and a scrolled table, and rebuilding those
      // every 2.5s for an unchanged list would fight the reader.
      if (!opts.silent || changed) paint();
    }).catch(function (err) {
      if (req !== R.request) return;
      if (err && err.message === "auth required") {
        ST.showReauthOverlay();
        return;
      }
      if (!R.loaded) {
        R.loadError = "Could not load run history — check the connection and try again.";
        paint();
      }
    });
  }

  function listFingerprint(runs, liveRuns) {
    var live = (liveRuns || []).map(function (r) {
      return [r.id, r.status, (r.pendingApprovals || []).length, (r.pendingInputs || []).length].join(":");
    }).join("|");
    var past = (runs || []).map(function (r) { return r.id + ":" + r.status; }).join("|");
    return live + "#" + past;
  }

  /**
   * Select `runId` into the receipt rail and fetch its full record (the list
   * endpoint returns summaries without the phase tree, and the ledger, result
   * and worktree blocks all need the tree). Passing null clears the rail.
   */
  function selectRun(runId, opts) {
    opts = opts || {};
    R.selectedId = runId;
    R.record = null;
    R.recordError = null;
    if (!runId) {
      if (!opts.fromRoute) syncHash();
      return;
    }
    if (!opts.fromRoute) syncHash();
    var live = findLive(runId);
    // A live run has no history record yet — the rail offers to attach instead.
    if (live) return;
    var req = ++R.recordRequest;
    apiAuth("GET", "/api/history/" + encodeURIComponent(runId)).then(function (r) {
      if (req !== R.recordRequest) return;
      if (r.status !== 200 || !r.body.record) {
        R.recordError = (r.body && r.body.error) || "Could not load that run.";
      } else {
        R.record = r.body.record;
      }
      paint();
    }).catch(function () {
      if (req !== R.recordRequest) return;
      R.recordError = "Could not load that run — network error.";
      paint();
    });
  }

  /** Keep the address bar in step with the rail so the view is shareable. */
  function syncHash() {
    if (S.page !== "runs") return;
    var link = (window.SteamtrainReducer && window.SteamtrainReducer.runsDeepLink)
      ? window.SteamtrainReducer.runsDeepLink(R.selectedId || undefined)
      : (R.selectedId ? "#runs/" + R.selectedId : "#runs");
    if (window.location.hash !== link) {
      history.replaceState(null, "", window.location.pathname + window.location.search + link);
    }
  }

  function findLive(runId) {
    for (var i = 0; i < R.liveRuns.length; i++) if (R.liveRuns[i].id === runId) return R.liveRuns[i];
    return null;
  }
  function findRecorded(runId) {
    for (var i = 0; i < R.runs.length; i++) if (R.runs[i].id === runId) return R.runs[i];
    return null;
  }

  // ---- filtering -------------------------------------------------------------

  function matchesQuery(run) {
    var q = (R.query || "").trim().toLowerCase();
    if (!q) return true;
    return [run.workflow, run.input, run.id, run.status]
      .filter(Boolean).join("\n").toLowerCase().indexOf(q) !== -1;
  }

  function matchesWorkflow(run) {
    return !R.workflow || run.workflow === R.workflow;
  }

  /**
   * The rows the table shows, live runs first (they are the ones you might
   * still act on), then recorded runs newest-first as the history API returns
   * them. The `limit` cut is applied by the caller so the "older runs" footer
   * can report how many it is hiding.
   */
  function buildEntries() {
    var out = [];
    if (R.status === "all" || R.status === "live") {
      R.liveRuns.forEach(function (run) {
        if (matchesQuery(run) && matchesWorkflow(run)) out.push({ kind: "live", id: run.id, run: run });
      });
    }
    if (R.status !== "live") {
      R.runs.forEach(function (run) {
        if (R.status !== "all" && run.status !== R.status) return;
        if (matchesQuery(run) && matchesWorkflow(run)) out.push({ kind: "record", id: run.id, run: run });
      });
    }
    return out;
  }

  /**
   * FACETING RULE for the two count functions below, which is why they look
   * asymmetric: a facet narrows every *other* facet, never itself.
   *
   *   statusCounts()    applies workflow + query, buckets by status
   *   workflowCounts()  applies status   + query, buckets by workflow
   *
   * Adding a facet's own filter to its own counts looks like a consistency fix
   * and is a dead end: pick workflow "A" and every other workflow drops to
   * zero, so it is dropped from the rail — and the rail has no "all workflows"
   * row to get back from (clicking the active one is what clears it). The
   * reader would be stuck in A. Pinned by "keeps the other workflows
   * reachable while one is selected" in tests/web-runs-page.test.ts.
   */

  /** Counts for the status rail, computed before the status filter applies. */
  function statusCounts() {
    var counts = { all: 0, live: R.liveRuns.length, done: 0, error: 0, canceled: 0, "budget-exceeded": 0 };
    R.runs.forEach(function (run) {
      if (!matchesWorkflow(run) || !matchesQuery(run)) return;
      counts.all++;
      if (counts[run.status] != null) counts[run.status]++;
    });
    counts.all += R.liveRuns.filter(function (run) {
      return matchesWorkflow(run) && matchesQuery(run);
    }).length;
    return counts;
  }

  /** Workflow names present in history or live, with their run counts. */
  function workflowCounts() {
    var map = {};
    function bump(name) {
      if (!name) return;
      map[name] = (map[name] || 0) + 1;
    }
    R.runs.forEach(function (run) {
      if (R.status !== "all" && R.status !== "live" && run.status !== R.status) return;
      if (matchesQuery(run)) bump(run.workflow);
    });
    R.liveRuns.forEach(function (run) {
      if (R.status !== "all" && R.status !== "live") return;
      if (matchesQuery(run)) bump(run.workflow);
    });
    return Object.keys(map).sort(function (a, b) {
      return map[b] - map[a] || a.localeCompare(b);
    }).map(function (name) { return { name: name, count: map[name] }; });
  }

  // ---- outcome text ----------------------------------------------------------

  function statusLabel(status) {
    if (status === "error") return "failed";
    if (status === "budget-exceeded") return "budget";
    return status ? String(status) : "";
  }

  /** Which state colour a row (and its dot) carries. */
  function statusTone(status) {
    if (status === "running" || status === "queued") return "running";
    if (status === "done") return "done";
    if (status === "error") return "error";
    if (status === "budget-exceeded") return "gate";
    return "faint";
  }

  /**
   * The Outcome column: what actually happened, in the run's own words. The
   * mock shows a domain summary ("4 findings kept") that no recorded field
   * carries, so this reports the run's real terminal reason instead — the error
   * for a failure, the breached cap for a budget stop, the step tally otherwise.
   */
  function outcomeNode(entry) {
    var run = entry.run;
    if (entry.kind === "live") {
      var bits = [run.status === "queued" ? "queued" : "running"];
      if (run.detached) bits.push("detached");
      if (run.pendingApprovals && run.pendingApprovals.length) bits.push("awaiting approval");
      if (run.pendingInputs && run.pendingInputs.length) bits.push("awaiting input");
      return h("span", { class: "outcome running", text: bits.join(" · ") });
    }
    if (run.status === "error") {
      return h("span", { class: "outcome error", text: truncate(oneLine(run.error) || "failed", 90) });
    }
    if (run.status === "budget-exceeded" && run.budget) {
      var scope = run.budget.scope === "step" && run.budget.stepId
        ? "step " + run.budget.stepId : "workflow";
      return h("span", { class: "outcome gate",
        text: scope + " budget $" + run.budget.limitUsd.toFixed(4) + " reached" });
    }
    if (run.status === "canceled") return h("span", { class: "outcome", text: "canceled" });
    var totals = run.totals || {};
    var text = (totals.ok || 0) + "/" + (totals.steps || 0) + " ok";
    var node = h("span", { class: "outcome", text: text });
    if (totals.failed) node.appendChild(h("span", { class: "flag error", text: " · " + totals.failed + " failed" }));
    if (totals.cached) node.appendChild(h("span", { class: "flag gate", text: " · " + totals.cached + " cached" }));
    return node;
  }

  function oneLine(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  /** m:ss for a run's wall clock, matching the mock's Time column. */
  function fmtClock(ms) {
    if (typeof ms !== "number" || !isFinite(ms) || ms <= 0) return "—";
    var total = Math.round(ms / 1000);
    var min = Math.floor(total / 60);
    var sec = total % 60;
    return min + ":" + (sec < 10 ? "0" : "") + sec;
  }

  function fmtCost(usd) {
    return typeof usd === "number" && usd > 0 ? "$" + usd.toFixed(3) : "—";
  }

  /** Absolute time for older runs, relative for recent ones (as the mock does). */
  function startedText(ts) {
    if (typeof ts !== "number" || !isFinite(ts) || ts <= 0) return "unknown";
    if (Date.now() - ts < 24 * 60 * 60 * 1000) return relTime(ts);
    try {
      var d = new Date(ts);
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " +
        d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    } catch (e) { return relTime(ts); }
  }

  // ---- paint -----------------------------------------------------------------

  function paint() {
    if (!R.mount || S.page !== "runs") return;
    var focus = ST.captureFocus();
    clear(R.mount);
    R.mount.className = "runs";
    R.mount.appendChild(buildRail());
    R.mount.appendChild(buildMain());
    R.mount.appendChild(buildReceipt());
    ST.restoreFocus(focus);
  }

  // ---- left rail: filters ----------------------------------------------------

  function buildRail() {
    var rail = h("nav", { class: "runs-rail", "aria-label": "Filter runs" });
    var counts = statusCounts();

    rail.appendChild(h("div", { class: "runs-rail-head", text: "Filter" }));
    var statusBox = h("div", { class: "runs-rail-group" });
    STATUS_FILTERS.forEach(function (filter) {
      // Hide a terminal state nobody has hit yet, but never the two that are
      // always meaningful (All, Running) and never the active one.
      if (filter.id !== "all" && filter.id !== "live" && !counts[filter.id] && R.status !== filter.id) return;
      statusBox.appendChild(railRow({
        label: filter.label,
        count: counts[filter.id] || 0,
        tone: filter.tone,
        active: R.status === filter.id,
        onPick: function () {
          R.status = filter.id;
          R.limit = PAGE_SIZE;
          paint();
        }
      }));
    });
    rail.appendChild(statusBox);

    var workflows = workflowCounts();
    if (workflows.length) {
      rail.appendChild(h("div", { class: "runs-rail-head", text: "Workflow" }));
      var wfBox = h("div", { class: "runs-rail-group" });
      workflows.forEach(function (wf) {
        wfBox.appendChild(railRow({
          label: wf.name,
          count: wf.count,
          mono: true,
          check: R.workflow === wf.name,
          active: R.workflow === wf.name,
          onPick: function () {
            // Clicking the active workflow clears the filter — the rail has no
            // separate "all workflows" row to go back to.
            R.workflow = R.workflow === wf.name ? null : wf.name;
            R.limit = PAGE_SIZE;
            paint();
          }
        }));
      });
      rail.appendChild(wfBox);
    }

    rail.appendChild(buildSpend());
    return rail;
  }

  function railRow(opts) {
    var row = h("button", {
      class: "runs-rail-row" + (opts.active ? " active" : ""),
      type: "button",
      "aria-pressed": opts.active ? "true" : "false",
      onClick: opts.onPick
    });
    if (opts.check !== undefined) {
      row.appendChild(h("span", { class: "tick" + (opts.check ? " on" : ""), "aria-hidden": "true", text: opts.check ? "✓" : "" }));
    } else if (opts.tone) {
      row.appendChild(h("span", { class: "dot " + opts.tone, "aria-hidden": "true" }));
    }
    row.appendChild(h("span", { class: "label" + (opts.mono ? " mono" : ""), text: opts.label }));
    row.appendChild(h("span", { class: "count", text: String(opts.count) }));
    return row;
  }

  /**
   * Rail footer: what the current filter has cost, as a bar per run (oldest to
   * newest) plus the total and mean. Recorded runs only — a live run has no
   * final cost yet.
   */
  function buildSpend() {
    var scoped = R.runs.filter(function (run) {
      return matchesWorkflow(run) && matchesQuery(run);
    });
    var box = h("div", { class: "runs-spend" });
    box.appendChild(h("div", { class: "runs-rail-head", text: "Spend · " + (R.workflow || "all workflows") }));
    if (!scoped.length) {
      box.appendChild(h("div", { class: "runs-spend-note", text: "No recorded runs yet." }));
      return box;
    }
    var costs = scoped.map(function (run) { return (run.totals && run.totals.costUsd) || 0; });
    var recent = costs.slice(0, SPARK_BARS).reverse();
    var peak = Math.max.apply(null, recent.concat([0]));
    var bars = h("div", { class: "runs-spark", "aria-hidden": "true" });
    recent.forEach(function (cost) {
      // A zero-cost run still gets a visible floor so the bar count matches the
      // run count — an invisible bar would silently misreport the history.
      var pct = peak > 0 ? Math.max(6, Math.round((cost / peak) * 100)) : 6;
      var level = peak > 0 && cost >= peak * 0.75 ? " hot" : peak > 0 && cost >= peak * 0.4 ? " warm" : "";
      bars.appendChild(h("span", { class: "bar" + level, style: "height:" + pct + "%", title: "$" + cost.toFixed(4) }));
    });
    box.appendChild(bars);
    var total = costs.reduce(function (a, b) { return a + b; }, 0);
    box.appendChild(h("div", { class: "runs-spend-note",
      text: "$" + total.toFixed(2) + " over " + costs.length + " run" + (costs.length === 1 ? "" : "s") +
        " · avg $" + (total / costs.length).toFixed(3) }));
    return box;
  }

  // ---- centre pane -----------------------------------------------------------

  function buildMain() {
    var main = h("section", { class: "runs-main" });
    if (R.view === "receipt" && R.record) {
      main.appendChild(buildReceiptHead());
      var full = h("div", { class: "runs-full" });
      main.appendChild(full);
      renderRecordDetail(full, R.record);
      return main;
    }
    if (R.view === "logs" && R.record) {
      main.appendChild(buildLogsHead());
      main.appendChild(buildLogs(R.record));
      return main;
    }
    if (R.view === "compare") {
      main.appendChild(buildCompareHead());
      main.appendChild(buildCompare());
      return main;
    }
    main.appendChild(buildListHead());
    main.appendChild(buildTable());
    return main;
  }

  function backToList() {
    R.view = "list";
    paint();
  }

  function buildReceiptHead() {
    return h("div", { class: "runs-head" },
      h("button", { class: "runs-back", type: "button", text: "← Runs", onClick: backToList }),
      h("span", { class: "runs-head-title", text: R.record.workflow }),
      h("span", { class: "runs-head-meta", text: "full receipt · " + shortId(R.record.id) })
    );
  }

  function buildCompareHead() {
    return h("div", { class: "runs-head" },
      h("button", { class: "runs-back", type: "button", text: "← Runs", onClick: backToList }),
      h("span", { class: "runs-head-title", text: "Compare" }),
      h("span", { class: "runs-head-meta", text: R.compare.length + " runs side by side" })
    );
  }

  // ---- logs ------------------------------------------------------------------
  // Every step's captured output in run order — the raw material behind the
  // receipt's summaries. A centre view (not a modal), so the rails stay put
  // and a long log never traps the reader in an overlay.

  /** One section per executed step, for the clipboard and the .txt download. */
  function logsText(record) {
    var lines = [
      "steamtrain logs · " + record.workflow + " · run " + record.id,
      fmtTime(record.startedAt) + " · " + fmtTotals(record.totals || {}) + " · " + fmtClock(record.durationMs),
      ""
    ];
    (record.phases || []).forEach(function (phase) {
      (phase.steps || []).forEach(function (step) {
        if (step.result && step.result.childResults && step.result.childResults.length) return;
        var result = step.result || {};
        var head = step.stepId + " · " + step.status;
        if (result.durationMs) head += " · " + (result.durationMs / 1000).toFixed(1) + "s";
        if (result.costUsd) head += " · $" + result.costUsd.toFixed(4);
        var text = step.text || result.output || "";
        lines.push("── " + head + " " + "─".repeat(Math.max(0, 60 - head.length)));
        lines.push(text.trim() ? text : "(no output captured)");
        lines.push("");
      });
    });
    return lines.join("\n");
  }

  function buildLogsHead() {
    var actions = h("div", { class: "runs-head-actions" },
      h("button", {
        class: "btn small", type: "button", text: "Copy all",
        onClick: function () {
          if (!navigator.clipboard || !navigator.clipboard.writeText) return;
          navigator.clipboard.writeText(logsText(R.record)).then(function () {
            notify("Copied the run's logs.", "ok");
          }).catch(function () {});
        }
      }),
      h("button", {
        class: "btn small", type: "button", text: "Download .txt",
        onClick: function () {
          var blob = new Blob([logsText(R.record)], { type: "text/plain" });
          var url = URL.createObjectURL(blob);
          var link = h("a", { href: url, download: "steamtrain-logs-" + shortId(R.record.id) + ".txt" });
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        }
      })
    );
    var head = h("div", { class: "runs-head" },
      h("button", { class: "runs-back", type: "button", text: "← Runs", onClick: backToList }),
      h("span", { class: "runs-head-title", text: R.record.workflow }),
      h("span", { class: "runs-head-meta", text: "logs · " + shortId(R.record.id) })
    );
    head.appendChild(actions);
    return head;
  }

  function buildLogs(record) {
    var wrap = h("div", { class: "runs-full runs-logs" });
    var any = false;
    (record.phases || []).forEach(function (phase) {
      var steps = (phase.steps || []).filter(function (step) {
        return !(step.result && step.result.childResults && step.result.childResults.length);
      });
      if (!steps.length) return;
      any = true;
      wrap.appendChild(h("div", { class: "runs-receipt-label", text: phase.title || phase.phaseId }));
      steps.forEach(function (step) {
        var result = step.result || {};
        var row = h("div", { class: "runs-log-step" });
        var head = h("div", { class: "runs-log-head" },
          h("span", { class: "dot " + statusTone(step.status), "aria-hidden": "true" }),
          h("span", { class: "name", text: step.stepId })
        );
        if (step.cached) head.appendChild(h("span", { class: "tag gate", text: "cached" }));
        head.appendChild(h("span", { class: "num", text: result.durationMs ? (result.durationMs / 1000).toFixed(1) + "s" : "" }));
        head.appendChild(h("span", { class: "num cost", text: result.costUsd ? "$" + result.costUsd.toFixed(4) : "" }));
        row.appendChild(head);
        var text = step.text || result.output || "";
        row.appendChild(text.trim()
          ? h("div", { class: "runs-well runs-log-well", text: text })
          : h("div", { class: "runs-receipt-note", text: "No output captured." }));
        wrap.appendChild(row);
      });
    });
    if (!any) {
      wrap.appendChild(h("div", { class: "runs-empty" },
        h("div", { class: "runs-empty-body", text: "This run recorded no step output." })));
    }
    return wrap;
  }

  function buildListHead() {
    var head = h("div", { class: "runs-head" });
    head.appendChild(h("span", { class: "runs-head-title", text: R.workflow || "All workflows" }));

    var counts = statusCounts();
    var summary = [counts.all + " run" + (counts.all === 1 ? "" : "s")];
    if (counts.live) summary.push(counts.live + " running");
    if (counts.done) summary.push(counts.done + " ok");
    if (counts.error) summary.push(counts.error + " failed");
    if (counts["budget-exceeded"]) summary.push(counts["budget-exceeded"] + " budget");
    if (counts.canceled) summary.push(counts.canceled + " canceled");
    head.appendChild(h("span", { class: "runs-head-meta", text: summary.join(" · ") }));

    // paint() rebuilds this pane wholesale on every filter keystroke and every
    // 2.5s poll that saw a change; the focus key is what carries the caret back
    // into the box afterwards (see ST.captureFocus).
    var search = h("input", {
      class: "runs-search", type: "search", value: R.query,
      placeholder: "Search workflow, input, or run id…",
      "aria-label": "Search runs", "data-focus-key": "runs-search"
    });
    search.addEventListener("input", function () {
      R.query = search.value || "";
      R.limit = PAGE_SIZE;
      paint();
    });
    head.appendChild(search);

    var actions = h("div", { class: "runs-head-actions" });
    if (R.compare.length) {
      actions.appendChild(h("span", { class: "runs-selected", text: R.compare.length + " selected" }));
      var compareBtn = h("button", {
        class: "btn small accent", type: "button", text: "Compare",
        title: R.compare.length < 2 ? "Check a second run to compare" : "Compare the checked runs",
        onClick: function () { R.view = "compare"; paint(); }
      });
      if (R.compare.length < 2) compareBtn.disabled = true;
      actions.appendChild(compareBtn);
      actions.appendChild(h("button", {
        class: "btn small", type: "button", text: "Export",
        title: "Download the checked runs as JSON",
        onClick: exportSelected
      }));
      actions.appendChild(h("button", {
        class: "btn small", type: "button", text: "Clear",
        onClick: function () { R.compare = []; paint(); }
      }));
    } else if (!isReadOnly() && R.runs.length) {
      actions.appendChild(h("button", {
        class: "btn small danger", type: "button", text: "Clear history", onClick: clearHistory
      }));
    }
    actions.appendChild(h("button", { class: "btn small", type: "button", text: "Close", onClick: ST.closePageRoute }));
    head.appendChild(actions);
    return head;
  }

  var COLUMNS = ["", "", "Run", "Started", "Outcome", "Time", "Cost", "Steps", ""];

  function buildTable() {
    var wrap = h("div", { class: "runs-table" });
    if (R.loadError) {
      wrap.appendChild(h("div", { class: "runs-empty" },
        h("div", { class: "runs-empty-title", text: "Run history is unavailable" }),
        h("div", { class: "runs-empty-body", text: R.loadError }),
        h("button", { class: "btn small", type: "button", text: "Retry", onClick: function () {
          R.loadError = null; refresh({ silent: false }); paint();
        } })
      ));
      return wrap;
    }
    if (!R.loaded) {
      wrap.appendChild(h("div", { class: "runs-empty" }, h("div", { class: "runs-empty-body", text: "Loading runs…" })));
      return wrap;
    }

    var header = h("div", { class: "runs-row runs-cols" });
    COLUMNS.forEach(function (label) { header.appendChild(h("span", { text: label })); });
    wrap.appendChild(header);

    var entries = buildEntries();
    if (!entries.length) {
      wrap.appendChild(emptyState());
      return wrap;
    }
    var body = h("div", { class: "runs-rows", role: "listbox", "aria-label": "Workflow runs" });
    entries.slice(0, R.limit).forEach(function (entry) { body.appendChild(buildRow(entry)); });
    wrap.appendChild(body);

    var hidden = entries.length - R.limit;
    if (hidden > 0) {
      wrap.appendChild(h("button", {
        class: "runs-more", type: "button",
        text: "load " + hidden + " older run" + (hidden === 1 ? "" : "s"),
        onClick: function () { R.limit += PAGE_SIZE; paint(); }
      }));
    }
    return wrap;
  }

  function emptyState() {
    if (!R.runs.length && !R.liveRuns.length) {
      return h("div", { class: "runs-empty" },
        h("div", { class: "runs-empty-title", text: "No runs yet" }),
        h("div", { class: "runs-empty-body", text: "Launch a workflow and it lands here — live while it runs, then as a receipt you can inspect, compare, or re-run." })
      );
    }
    return h("div", { class: "runs-empty" },
      h("div", { class: "runs-empty-title", text: "No runs match" }),
      h("div", { class: "runs-empty-body", text: "Nothing in this workflow and status combination." }),
      h("button", { class: "btn small", type: "button", text: "Clear filters", onClick: function () {
        R.status = "all"; R.workflow = null; R.query = ""; R.limit = PAGE_SIZE; paint();
      } })
    );
  }

  function shortId(id) {
    return String(id || "").slice(0, 8);
  }

  function buildRow(entry) {
    var run = entry.run;
    var live = entry.kind === "live";
    var selected = R.selectedId === run.id;
    var checked = R.compare.indexOf(run.id) !== -1;
    var row = h("div", {
      class: "runs-row runs-run " + statusTone(run.status) +
        (selected ? " selected" : "") + (live ? " live" : ""),
      role: "option",
      tabindex: "0",
      "aria-selected": selected ? "true" : "false",
      title: oneLine(run.input) || "(no input)",
      "data-focus-key": "runs-row:" + run.id,
      onClick: function (e) {
        // The checkbox is its own control: clicking it toggles comparison
        // without also pulling the run into the receipt.
        if (ST.isInteractiveTarget(e.target)) return;
        selectRun(run.id);
        paint();
      },
      // Arrow keys are handled once, page-wide, in handleKey — a row-level
      // handler here would step the selection twice per press.
      onKeydown: function (e) {
        activateWithKeyboard(e, function () { selectRun(run.id); paint(); });
      }
    });

    // Ticking repaints the page (the head grows a Compare/Export group), so the
    // box needs a focus key of its own to stay focused across that rebuild.
    var check = h("input", {
      class: "runs-check", type: "checkbox", checked: checked,
      "aria-label": "Select run " + shortId(run.id) + " for comparison",
      "data-focus-key": "runs-check:" + run.id
    });
    check.addEventListener("change", function () {
      var at = R.compare.indexOf(run.id);
      if (check.checked && at === -1) R.compare.push(run.id);
      else if (!check.checked && at !== -1) R.compare.splice(at, 1);
      paint();
    });
    row.appendChild(check);

    row.appendChild(h("span", { class: "dot " + statusTone(run.status) + (live ? " pulse" : ""), "aria-hidden": "true" }));
    row.appendChild(h("span", { class: "runs-id", text: shortId(run.id) }));
    row.appendChild(h("span", { class: "runs-started", text: startedText(run.startedAt || run.createdAt) }));
    row.appendChild(outcomeNode(entry));
    row.appendChild(h("span", { class: "num", text: live ? "—" : fmtClock(run.durationMs) }));
    row.appendChild(h("span", { class: "num", text: live ? "—" : fmtCost(run.totals && run.totals.costUsd) }));
    row.appendChild(h("span", { class: "num quiet",
      text: live ? "—" : ((run.totals && run.totals.steps) ? (run.totals.ok || 0) + "/" + run.totals.steps : "—") }));
    row.appendChild(h("span", { class: "runs-chev" + (selected ? " on" : ""), "aria-hidden": "true", text: "›" }));
    return row;
  }

  // ---- right rail: receipt ---------------------------------------------------

  function buildReceipt() {
    var rail = h("aside", { class: "runs-receipt", "aria-label": "Run receipt" });
    if (!R.selectedId) {
      rail.appendChild(h("div", { class: "runs-receipt-idle" },
        h("div", { class: "title", text: "No run selected" }),
        h("div", { class: "body", text: "Pick a run to see its wall clock, cost, step ledger, and result here." })
      ));
      return rail;
    }
    var live = findLive(R.selectedId);
    if (live) {
      rail.appendChild(receiptHead(live, "running"));
      rail.appendChild(h("div", { class: "runs-receipt-idle" },
        h("div", { class: "title", text: "This run is still going" }),
        h("div", { class: "body", text: "Its receipt is written when it finishes. Attach to watch it live." }),
        h("button", { class: "btn small accent", type: "button", text: "Attach", onClick: function () {
          ST.closePageRoute();
          attachRun(live);
        } })
      ));
      return rail;
    }
    if (R.recordError) {
      rail.appendChild(h("div", { class: "runs-receipt-idle" },
        h("div", { class: "title", text: "Receipt unavailable" }),
        h("div", { class: "body", text: R.recordError })
      ));
      return rail;
    }
    if (!R.record) {
      rail.appendChild(h("div", { class: "runs-receipt-idle" }, h("div", { class: "body", text: "Loading receipt…" })));
      return rail;
    }

    var record = R.record;
    rail.appendChild(receiptHead(record, record.status));
    rail.appendChild(receiptTiles(record));
    if (record.input) {
      rail.appendChild(h("div", { class: "runs-receipt-block" },
        h("div", { class: "runs-receipt-label", text: "Input" }),
        h("div", { class: "runs-receipt-input", text: truncate(oneLine(record.input), 240) })
      ));
    }
    if (record.error) {
      rail.appendChild(h("div", { class: "runs-receipt-block" },
        h("div", { class: "runs-receipt-error", text: truncate(oneLine(record.error), 300) })
      ));
    }
    rail.appendChild(receiptLedger(record));
    rail.appendChild(receiptResult(record));
    rail.appendChild(receiptFoot(record));
    return rail;
  }

  function receiptHead(run, status) {
    var head = h("div", { class: "runs-receipt-head" },
      h("span", { class: "runs-receipt-kicker", text: "Run" }),
      h("span", { class: "runs-receipt-id", text: shortId(run.id), title: run.id }),
      h("span", { class: "runs-chip " + statusTone(status) },
        h("span", { class: "dot " + statusTone(status), "aria-hidden": "true" }),
        statusLabel(status))
    );
    var nav = h("div", { class: "runs-receipt-nav" });
    nav.appendChild(h("button", {
      class: "icon", type: "button", title: "Previous run", "aria-label": "Previous run", text: "↑",
      onClick: function () { stepSelection(-1); }
    }));
    nav.appendChild(h("button", {
      class: "icon", type: "button", title: "Next run", "aria-label": "Next run", text: "↓",
      onClick: function () { stepSelection(1); }
    }));
    nav.appendChild(h("button", {
      class: "icon", type: "button", title: "Close the receipt", "aria-label": "Close the receipt", text: "✕",
      onClick: function () { selectRun(null); R.view = "list"; paint(); }
    }));
    head.appendChild(nav);
    return head;
  }

  /**
   * Move the receipt one run up or down the filtered list. `focusRow` follows
   * the selection with keyboard focus — wanted when the arrow keys drove it,
   * not when the rail's own ↑/↓ buttons did (that would steal focus from the
   * button the reader is still clicking).
   */
  function stepSelection(delta, focusRow) {
    var entries = buildEntries();
    if (!entries.length) return;
    var at = -1;
    for (var i = 0; i < entries.length; i++) if (entries[i].id === R.selectedId) { at = i; break; }
    var next = Math.min(entries.length - 1, Math.max(0, at + delta));
    if (next === at) return;
    // Stepping past the visible window pulls the next page in with it.
    if (next >= R.limit) R.limit += PAGE_SIZE;
    if (R.view === "receipt") R.view = "list";
    selectRun(entries[next].id);
    paint();
    if (!focusRow || !R.mount) return;
    var row = R.mount.querySelector('[data-focus-key="runs-row:' + entries[next].id + '"]');
    if (row) row.focus();
  }

  function receiptTiles(record) {
    var totals = record.totals || {};
    var tokens = totalTokens(totals.tokens);
    var box = h("div", { class: "runs-tiles" });
    [
      { label: "Wall", value: fmtClock(record.durationMs) },
      { label: "Cost", value: totals.costUsd ? "$" + totals.costUsd.toFixed(3) : "—" },
      { label: "Tokens", value: tokens ? fmtTokens(tokens) : "—", title: fmtTokenSummary(totals.tokens) }
    ].forEach(function (tile) {
      box.appendChild(h("div", { class: "runs-tile", title: tile.title || "" },
        h("div", { class: "label", text: tile.label }),
        h("div", { class: "value", text: tile.value })
      ));
    });
    return box;
  }

  /** Every leaf step of the run, in order, with its duration and cost. */
  function ledgerSteps(record) {
    var out = [];
    (record.phases || []).forEach(function (phase) {
      (phase.steps || []).forEach(function (step) {
        // A fan-out parent is summarised by its children, which are their own
        // rows — listing it too would double-count the phase.
        if (step.result && step.result.childResults && step.result.childResults.length) return;
        out.push(step);
      });
    });
    return out;
  }

  function receiptLedger(record) {
    var box = h("div", { class: "runs-receipt-block" });
    box.appendChild(h("div", { class: "runs-receipt-label", text: "Step ledger" }));
    var steps = ledgerSteps(record);
    if (!steps.length) {
      box.appendChild(h("div", { class: "runs-receipt-note", text: "No steps recorded." }));
      return box;
    }
    var rows = h("div", { class: "runs-ledger-rows" });
    steps.forEach(function (step) {
      var result = step.result || {};
      var row = h("div", { class: "runs-ledger-row" },
        h("span", { class: "dot " + statusTone(step.status), "aria-hidden": "true" }),
        h("span", { class: "name", text: step.stepId, title: step.stepId })
      );
      if (step.cached) row.appendChild(h("span", { class: "tag gate", text: "cached" }));
      else if (step.blockKind === "gate") {
        row.appendChild(h("span", { class: "tag", text: step.gate && step.gate.passed ? "gate pass" : "gate stop" }));
      }
      row.appendChild(h("span", { class: "num", text: result.durationMs ? (result.durationMs / 1000).toFixed(1) + "s" : "—" }));
      row.appendChild(h("span", { class: "num cost", text: result.costUsd ? "$" + result.costUsd.toFixed(4) : "free" }));
      rows.appendChild(row);
    });
    box.appendChild(rows);
    return box;
  }

  /**
   * The result well: the output of the run's last step that produced any — the
   * closest thing a recorded run has to "what came out of this".
   */
  function receiptResult(record) {
    var steps = ledgerSteps(record);
    var last = null;
    for (var i = steps.length - 1; i >= 0; i--) {
      var text = steps[i].text || (steps[i].result && steps[i].result.output);
      if (text && String(text).trim()) { last = { step: steps[i], text: String(text) }; break; }
    }
    var box = h("div", { class: "runs-receipt-result" });
    var head = h("div", { class: "runs-receipt-label" }, "Result");
    if (last) head.appendChild(h("span", { class: "src", text: last.step.stepId }));
    box.appendChild(head);
    box.appendChild(h("div", { class: "runs-well", text: last ? last.text : "This run produced no step output." }));
    return box;
  }

  function receiptFoot(record) {
    var foot = h("div", { class: "runs-receipt-foot" });
    foot.appendChild(h("button", {
      class: "btn small", type: "button", text: "Full receipt",
      title: "Phase tree, per-model costs, and worktree changes",
      onClick: function () { R.view = "receipt"; paint(); }
    }));
    foot.appendChild(h("button", {
      class: "btn small", type: "button", text: "Logs",
      title: "Every step's captured output, in run order",
      onClick: function () { R.view = "logs"; paint(); }
    }));
    if (!isReadOnly()) {
      foot.appendChild(h("button", {
        class: "btn small accent", type: "button", text: "Re-run",
        onClick: function () { ST.modals.rerunHistory(record.id, record.workflow, "rerun"); }
      }));
    }
    return foot;
  }

  /**
   * The cockpit's banner is hidden while this page is up, so anything worth
   * saying goes to the live region as well — that is the only channel a reader
   * on this page perceives. The banner still gets it so the message is waiting
   * when they go back.
   */
  function notify(text, kind) {
    ST.announce(text);
    if (ST.run && ST.run.setBanner) ST.run.setBanner(text, kind);
  }

  function copyRunId(id) {
    if (!navigator.clipboard || !navigator.clipboard.writeText) return;
    navigator.clipboard.writeText(id).then(function () {
      ST.announce("Copied run id " + shortId(id));
    }).catch(function () {});
  }

  // ---- compare ---------------------------------------------------------------

  /**
   * Side-by-side totals for the checked runs, plus a per-step row showing how
   * each run's steps differ in duration and cost. Only recorded runs can be
   * compared — a live run has no final totals.
   */
  function buildCompare() {
    var wrap = h("div", { class: "runs-compare" });
    var picked = R.compare.map(findRecorded).filter(Boolean);
    if (picked.length < 2) {
      wrap.appendChild(h("div", { class: "runs-empty" },
        h("div", { class: "runs-empty-title", text: "Nothing to compare" }),
        h("div", { class: "runs-empty-body", text: "Check two or more recorded runs in the table." })
      ));
      return wrap;
    }
    var grid = h("div", { class: "runs-compare-grid", style: "grid-template-columns: 128px repeat(" + picked.length + ", minmax(0, 1fr))" });
    function addRow(label, cells, cls) {
      grid.appendChild(h("span", { class: "runs-compare-label", text: label }));
      cells.forEach(function (cell) {
        grid.appendChild(typeof cell === "string"
          ? h("span", { class: "runs-compare-cell" + (cls ? " " + cls : ""), text: cell })
          : cell);
      });
    }
    addRow("Run", picked.map(function (run) {
      return h("span", { class: "runs-compare-cell head", text: shortId(run.id), title: run.id });
    }));
    addRow("Workflow", picked.map(function (run) { return run.workflow; }));
    addRow("Started", picked.map(function (run) { return startedText(run.startedAt); }));
    addRow("Outcome", picked.map(function (run) {
      return h("span", { class: "runs-compare-cell " + statusTone(run.status), text: statusLabel(run.status) });
    }));
    addRow("Wall", picked.map(function (run) { return fmtClock(run.durationMs); }), "num");
    addRow("Cost", picked.map(function (run) { return fmtCost(run.totals && run.totals.costUsd); }), "num");
    addRow("Steps ok", picked.map(function (run) {
      var t = run.totals || {};
      return (t.ok || 0) + "/" + (t.steps || 0);
    }), "num");
    addRow("Failed", picked.map(function (run) { return String((run.totals && run.totals.failed) || 0); }), "num");
    addRow("Cached", picked.map(function (run) { return String((run.totals && run.totals.cached) || 0); }), "num");
    addRow("Tokens", picked.map(function (run) {
      var tok = totalTokens(run.totals && run.totals.tokens);
      return tok ? fmtTokens(tok) : "—";
    }), "num");
    wrap.appendChild(grid);
    wrap.appendChild(h("div", { class: "runs-compare-note",
      text: "Totals come from each run's recorded receipt. Open a run's full receipt for its phase tree." }));
    return wrap;
  }

  /** Download the checked runs' summaries as one JSON file. */
  function exportSelected() {
    var picked = R.compare.map(findRecorded).filter(Boolean);
    if (!picked.length) {
      notify("Nothing to export — check a recorded run first.", "info");
      return;
    }
    var blob = new Blob([JSON.stringify({ runs: picked }, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var link = h("a", { href: url, download: "steamtrain-runs.json" });
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function clearHistory() {
    if (!window.confirm("Clear all recorded runs? This deletes the on-disk history.")) return;
    apiAuth("DELETE", "/api/history").then(function (r) {
      if (r.status === 200 || r.status === 204) {
        R.runs = [];
        R.compare = [];
        R.fingerprint = "";
        selectRun(null);
        R.view = "list";
        notify("Cleared run history.", "ok");
        refresh({ silent: false });
        paint();
      } else {
        notify((r.body && r.body.error) || "clear failed", "err");
      }
    }).catch(function () {
      notify("Clear failed — network error.", "err");
    });
  }

  function deleteRecord(record) {
    if (!window.confirm("Delete recorded run " + shortId(record.id) + "… of \u201c" + record.workflow + "\u201d? This cannot be undone.")) return;
    apiAuth("DELETE", "/api/history/" + encodeURIComponent(record.id)).then(function (r) {
      if (r.status === 200 || r.status === 204) {
        notify("Deleted run " + shortId(record.id) + "…", "ok");
        R.compare = R.compare.filter(function (id) { return id !== record.id; });
        R.fingerprint = "";
        selectRun(null);
        R.view = "list";
        refresh({ silent: false });
        paint();
      } else {
        notify((r.body && r.body.error) || "delete failed", "err");
      }
    }).catch(function () {
      notify("Delete failed — network error.", "err");
    });
  }

  // ---- full receipt (centre pane) --------------------------------------------

  /**
   * The deep view of one recorded run: hero, input, per-model costs, the run
   * actions, the worktree lifecycle block, and the recorded phase tree as a
   * ledger.
   *
   * The tree used to be drawn with the cockpit's live step cards, which are
   * built for a run in flight — pulsing status, follow-the-tail output panes,
   * per-step controls that a finished run cannot honour. A record is read, not
   * watched, so the phases are a ledger here: one line per step, its output a
   * click away rather than always open.
   */
  function renderRecordDetail(holder, record) {
    clear(holder);

    var totals = record.totals || {};
    var hero = h("div", { class: "hist-hero " + record.status },
      h("div", { class: "hist-hero-top" },
        h("span", { class: "hist-hero-glyph", text: heroGlyph(record.status) }),
        h("div", { class: "hist-hero-titles" },
          h("div", { class: "hist-hero-name", text: record.workflow }),
          h("div", { class: "hist-hero-sub", text: statusLabel(record.status) + " · " + fmtTime(record.startedAt) })
        ),
        h("button", { class: "btn small hist-copy", type: "button", text: "Copy id", title: record.id,
          onClick: function () { copyRunId(record.id); } })
      )
    );
    // The four numbers the receipt is read for, as tiles rather than the run-on
    // summary line the rest of the page uses (design 02).
    var tiles = h("div", { class: "hist-stats" });
    function tile(k, v) {
      return h("div", { class: "hist-stat" }, h("div", { class: "k", text: k }), h("div", { class: "v", text: v }));
    }
    var tokens = totalTokens(totals.tokens);
    tiles.appendChild(tile("Elapsed", ((record.durationMs || 0) / 1000).toFixed(1) + "s"));
    tiles.appendChild(tile("Cost", totals.costUsd > 0 ? "$" + totals.costUsd.toFixed(4) : "$0"));
    tiles.appendChild(tile("Tokens", tokens > 0 ? fmtTokens(tokens) : "0"));
    tiles.appendChild(tile("Steps", (totals.ok || 0) + " ok"
      + (totals.failed ? " · " + totals.failed + " failed" : "")
      + (totals.cached ? " · " + totals.cached + " cached" : "")));
    hero.appendChild(tiles);
    holder.appendChild(hero);

    if (record.input) {
      holder.appendChild(h("div", { class: "hist-input-block" },
        h("div", { class: "hist-input-label", text: "Input" }),
        h("div", { class: "hist-input-body", text: record.input })
      ));
    }
    if (record.budget) {
      var scope = record.budget.scope === "step" && record.budget.stepId
        ? "step '" + record.budget.stepId + "'" : "workflow";
      holder.appendChild(h("div", { class: "mbanner show err", text: scope + " cost budget $" + record.budget.limitUsd.toFixed(4)
        + " reached (spent $" + record.budget.spentUsd.toFixed(4) + ") — resumable after raising the cap" }));
    }
    if (record.error) holder.appendChild(h("div", { class: "mbanner show err", text: record.error }));

    var steps = [];
    (record.phases || []).forEach(function (p) { (p.steps || []).forEach(function (s) { steps.push(s); }); });
    var byModel = aggregateByModel(steps);
    if (byModel.length) {
      var table = h("table", { class: "hist-model-table" });
      table.appendChild(h("tr", null, h("th", { text: "model" }), h("th", { text: "steps" }), h("th", { text: "cost" }), h("th", { text: "tokens" })));
      byModel.forEach(function (m) {
        table.appendChild(h("tr", null,
          h("td", { text: m.model }), h("td", { text: String(m.steps) }),
          h("td", { text: m.costUsd ? "$" + m.costUsd.toFixed(4) : "" }),
          h("td", { text: fmtTokenSummary(m.tokens) })
        ));
      });
      holder.appendChild(table);
    }

    var canRetry = steps.some(function (s) { return s.status && s.status !== "done"; });
    var actions = h("div", { class: "run-actions hist-actions" });
    if (!isReadOnly()) {
      actions.appendChild(h("button", { class: "btn primary", text: "Re-run",
        onClick: function () { ST.modals.rerunHistory(record.id, record.workflow, "rerun"); } }));
      if (canRetry) {
        actions.appendChild(h("button", { class: "btn", text: "Retry failed",
          onClick: function () { ST.modals.rerunHistory(record.id, record.workflow, "retry"); } }));
        actions.appendChild(h("button", { class: "btn", text: "Retry with agent…",
          onClick: function () {
            ST.modals.openRetryRetargetModal(record, function () { paint(); });
          } }));
      }
      actions.appendChild(h("button", { class: "btn danger small", text: "Delete",
        onClick: function () { deleteRecord(record); } }));
    }
    if (actions.children.length) holder.appendChild(actions);

    var worktrees = h("div", { class: "hist-worktrees" });
    holder.appendChild(worktrees);
    renderWorktreeSection(worktrees, record);

    (record.phases || []).forEach(function (phase, idx) {
      holder.appendChild(renderReceiptPhase(record, phase, idx));
    });
    holder.appendChild(receiptFootnotes(record));
  }

  /** One recorded phase: its header, then a ledger line per step. */
  function renderReceiptPhase(record, phase, idx) {
    var stat = phase.done ? (phase.ok ? "done" : "failed") : "";
    var box = h("div", { class: "hist-phase" },
      h("div", { class: "hist-phase-head" },
        h("span", { class: "idx", text: String(idx + 1) }),
        h("span", { class: "title", text: phase.title || "" }),
        stat ? h("span", { class: "stat " + (phase.ok ? "ok" : "err"), text: stat }) : null,
        h("span", { class: "count", text: (phase.steps || []).length + " step" + ((phase.steps || []).length === 1 ? "" : "s") })
      )
    );
    (phase.steps || []).forEach(function (step) {
      box.appendChild(renderReceiptStep(record, step));
    });
    return box;
  }

  /**
   * One step of the full receipt. The line carries everything a reader scans
   * for (id, kind · model, how it ended, time, cost); the recorded output — and
   * a fan-out parent's children — open underneath on click, so a long run is a
   * page of lines instead of a wall of panes.
   */
  function renderReceiptStep(record, step, depth) {
    var result = step.result || {};
    var children = result.childResults || [];
    var text = step.text || result.output || "";
    var key = record.id + ":" + step.stepId;
    var isOpen = R.receiptOpen[key] === true;
    var expandable = Boolean(text || children.length);
    var wrap = h("div", { class: "hist-step" + (depth ? " child" : "") });

    var line = h("div", {
      class: "hist-step-line" + (expandable ? " expandable" : "") + (isOpen ? "" : " collapsed"),
      role: expandable ? "button" : null,
      tabindex: expandable ? "0" : null,
      onClick: expandable ? function () { toggleReceiptStep(key); } : null,
      onKeydown: expandable ? function (e) { activateWithKeyboard(e, function () { toggleReceiptStep(key); }); } : null
    });
    if (expandable) line.appendChild(h("span", { class: "diff-chevron", "aria-hidden": "true", text: "▾" }));
    else line.appendChild(h("span", { class: "hist-step-nochev", "aria-hidden": "true" }));
    line.appendChild(h("span", { class: "dot " + statusTone(step.status), "aria-hidden": "true" }));
    var kind = KIND_LABEL[step.blockKind] || step.blockKind || "step";
    line.appendChild(h("div", { class: "hist-step-id" },
      h("div", { class: "id", text: step.item ? step.stepId + " · " + truncate(String(step.item), 40) : step.stepId }),
      h("div", { class: "sub", text: kind + (step.model ? " · " + step.model : (step.agent ? " · " + step.agent : "")) })
    ));
    receiptStepTags(step).forEach(function (tag) { line.appendChild(tag); });
    line.appendChild(h("span", { class: "num", text: result.durationMs ? (result.durationMs / 1000).toFixed(1) + "s" : "—" }));
    line.appendChild(h("span", { class: "num cost", text: result.costUsd ? "$" + result.costUsd.toFixed(4) : "free" }));
    wrap.appendChild(line);

    if (isOpen) {
      if (text) wrap.appendChild(h("div", { class: "hist-step-out", text: String(text) }));
      children.forEach(function (child) {
        // A fan-out child is a step in its own right, recorded under its parent.
        wrap.appendChild(renderReceiptStep(record, {
          stepId: child.stepId || step.stepId,
          blockKind: step.blockKind,
          agent: step.agent, model: step.model,
          item: child.item,
          status: child.ok === false ? "error" : "done",
          text: child.output || "",
          result: child
        }, (depth || 0) + 1));
      });
    }
    return wrap;
  }

  /** The short state tags on a receipt line: why this step was cheap or odd. */
  function receiptStepTags(step) {
    var tags = [];
    if (step.cached) tags.push(h("span", { class: "tag gate", text: "cached" }));
    if (step.blockKind === "gate") {
      tags.push(h("span", { class: "tag", text: step.gate && step.gate.passed ? "gate pass" : "gate stop" }));
    }
    if (step.status === "skipped") tags.push(h("span", { class: "tag", text: "skipped" }));
    var attempts = step.attempts || (step.result && step.result.attempts);
    if (attempts > 1) tags.push(h("span", { class: "tag", text: attempts + " attempts" }));
    if (step.approval) tags.push(h("span", { class: "tag", text: step.approval.approved ? "approved" : "rejected" }));
    return tags;
  }

  function toggleReceiptStep(key) {
    if (R.receiptOpen[key]) delete R.receiptOpen[key];
    else R.receiptOpen[key] = true;
    paint();
  }

  /**
   * The receipt's closing lines (design 02): what the run did to the machine,
   * as opposed to what it produced. Every number here is read off the record —
   * the worktree line reports the harvest the CLI or this page recorded, not a
   * guess about what is still on disk, because nothing in a record says that.
   */
  function receiptFootnotes(record) {
    var steps = ledgerSteps(record);
    var readOnly = 0, violations = 0, trees = 0, retried = [];
    steps.forEach(function (s) {
      var perms = ST.stepPermissions(s);
      if (perms) {
        if (perms.profile === "read-only") readOnly += 1;
        violations += (perms.violations && perms.violations.length) || 0;
      }
      if (s.worktree) trees += 1;
      var attempts = s.attempts || (s.result && s.result.attempts) || 0;
      if (attempts > 1) retried.push(s.stepId);
    });
    var foot = h("div", { class: "hist-footnotes" });
    function row(label, value) {
      foot.appendChild(h("div", { class: "row" },
        h("span", { class: "k", text: label }),
        h("span", { class: "v", text: value })
      ));
    }
    row("sandbox", readOnly + " read-only · " + violations + " violation" + (violations === 1 ? "" : "s"));
    row("worktrees", trees + " step tree" + (trees === 1 ? "" : "s") + " · " + harvestLabel(record.harvest));
    row("retries", retried.length ? retried.length + " (" + retried.join(", ") + ")" : "0");
    return foot;
  }

  /** What became of a run's worktrees, in the record's own terms. */
  function harvestLabel(harvest) {
    if (!harvest) return "not harvested";
    if (harvest.prunedAt) return "discarded";
    var applied = (harvest.appliedSteps || []).length;
    if (applied) return applied + " merged back" + (harvest.branch ? " on " + harvest.branch : "");
    return "not harvested";
  }

  function heroGlyph(status) {
    if (status === "done") return "✓";
    if (status === "error") return "✗";
    if (status === "canceled") return "⊘";
    return "$";
  }

  // ---- worktree lifecycle ----------------------------------------------------

  function diffExpanded(runId) {
    var set = Diff.expanded.get(runId);
    if (!set) { set = new Set(); Diff.expanded.set(runId, set); }
    return set;
  }

  /**
   * One expandable step row of the "Worktree changes" block: the summary line
   * (branch, file count, +/- stats) and, when expanded, the lazily fetched
   * graphical diff panel below it.
   */
  function renderWorktreeDiffRow(holder, record, s) {
    var isOpen = diffExpanded(record.id).has(s.stepId);
    var wrap = h("div", null);
    var row = h("div", {
      class: "hist-wt-line expandable" + (isOpen ? "" : " collapsed"),
      title: s.branch,
      role: "button",
      tabindex: "0",
      onClick: function () { toggleWorktreeDiff(holder, record, s.stepId); },
      onKeydown: function (e) { activateWithKeyboard(e, function () { toggleWorktreeDiff(holder, record, s.stepId); }); }
    },
      h("span", { class: "diff-chevron", "aria-hidden": "true", text: "▾" }),
      "⎇ " + s.stepId + " — " + s.files.length + " file(s) ",
      h("span", { class: "diff-add", text: "+" + s.additions }),
      " ",
      h("span", { class: "diff-del", text: "−" + s.deletions })
    );
    wrap.appendChild(row);
    if (!isOpen) return wrap;

    var cached = Diff.cache.get(record.id);
    var body = cached && cached.get(s.stepId);
    if (!body) {
      wrap.appendChild(h("div", { class: "hist-wt-loading", text: "Loading diff…" }));
      fetchWorktreeDiff(holder, record, s.stepId);
      return wrap;
    }
    wrap.appendChild(renderWorktreeDiffPanel(record, s, body));
    return wrap;
  }

  function toggleWorktreeDiff(holder, record, stepId) {
    var expSet = diffExpanded(record.id);
    if (expSet.has(stepId)) expSet.delete(stepId); else expSet.add(stepId);
    renderWorktreeSection(holder, record);
  }

  /** Lazy per-step patch fetch; responses cache per run id + step id. */
  function fetchWorktreeDiff(holder, record, stepId) {
    var key = record.id + ":" + stepId;
    if (Diff.inflight.has(key)) return;
    var cached = Diff.cache.get(record.id);
    if (cached && cached.has(stepId)) return;
    Diff.inflight.add(key);
    function settle(body) {
      Diff.inflight.delete(key);
      var runCache = Diff.cache.get(record.id);
      if (!runCache) { runCache = new Map(); Diff.cache.set(record.id, runCache); }
      runCache.set(stepId, body);
      renderWorktreeSection(holder, record);
    }
    apiAuth("GET", "/api/history/" + encodeURIComponent(record.id) + "/worktrees?step=" + encodeURIComponent(stepId))
      .then(function (r) {
        // Cache the failure too, not just the success. The re-render below asks
        // renderWorktreeDiffRow to draw this step again; that row fetches
        // whenever the step is expanded and uncached, so leaving a non-200
        // uncached means re-render → fetch → non-200 → re-render, hammering the
        // server for as long as the row stays open. An error entry ends that
        // loop and gives the reader something better than a permanent spinner.
        settle(r.status === 200 && r.body
          ? r.body
          : { error: (r.body && r.body.error) || ("diff unavailable (HTTP " + r.status + ")") });
      })
      .catch(function () { settle({ error: "diff request failed" }); });
  }

  /**
   * The expanded body of a worktree step row: the graphical diff when the
   * diff-view bundle is loaded and a patch came back, a muted per-file list for
   * metadata-only changes (and as the no-bundle fallback), or a "worktree gone"
   * note when the step's worktree was cleaned up since the list was fetched.
   */
  function renderWorktreeDiffPanel(record, s, body) {
    var panel = h("div", { class: "hist-wt-diff" });
    // The cached failure sentinel from fetchWorktreeDiff. Say the fetch failed
    // rather than falling through to "no textual changes", which would report a
    // clean worktree we never actually managed to read.
    if (body.error) {
      panel.appendChild(h("div", { class: "hist-wt-diff-empty", text: body.error }));
      return panel;
    }
    if (body.exists === false) {
      panel.appendChild(h("div", { class: "hist-wt-diff-empty", text: "worktree no longer exists — diff unavailable" }));
      return panel;
    }
    if (typeof window.SteamtrainDiff !== "undefined" && body.patch) {
      if (body.patchTruncated) {
        panel.appendChild(h("div", { class: "hist-wt-diff-truncated",
          text: "Diff truncated at 200 KB — view the full diff with: steamtrain workflow history show " + record.id + " --diff --step " + s.stepId }));
      }
      panel.appendChild(window.SteamtrainDiff.renderPatch(body.patch));
      return panel;
    }
    if (body.files && body.files.length) {
      var fileList = body.files.slice(0, 8).map(function (f) { return f.status + " " + f.path; }).join(" · ");
      if (body.files.length > 8) fileList += " …";
      panel.appendChild(h("div", { class: "hist-wt-files", text: fileList }));
    } else {
      panel.appendChild(h("div", { class: "hist-wt-diff-empty", text: "no textual changes" }));
    }
    return panel;
  }

  /** Drop cached patches for a run after a harvest/prune changed its worktrees. */
  function invalidateWorktreeDiffs(runId) {
    Diff.cache.delete(runId);
  }

  /**
   * The "Worktree changes" block of a run's full receipt: per-step diffstat of
   * the retained worktrees, the recorded harvest status, and the lifecycle
   * actions — apply to the checkout, merge to a branch, or prune (discard). A
   * source-vs-source merge conflict (409) surfaces retry buttons with a
   * deterministic winner instead of a dead end.
   */
  function renderWorktreeSection(holder, record, notice) {
    apiAuth("GET", "/api/history/" + encodeURIComponent(record.id) + "/worktrees").then(function (r) {
      if (S.page !== "runs") return;
      if (r.status !== 200 || !r.body.sources || !r.body.sources.length) return;
      var sources = r.body.sources;
      var harvest = r.body.harvest;
      clear(holder);
      holder.appendChild(h("div", { class: "hist-wt-title", text: "Worktree changes" }));
      var bits = [];
      if (harvest && harvest.appliedSteps && harvest.appliedSteps.length) bits.push("harvested: " + harvest.appliedSteps.join(", "));
      if (harvest && harvest.branch) bits.push("on branch " + harvest.branch);
      if (harvest && harvest.prunedAt) bits.push("worktrees pruned " + fmtTime(harvest.prunedAt));
      var status = h("div", { class: "hist-wt-status" });
      if (bits.length) status.textContent = bits.join(" · ");
      if (harvest && harvest.prUrl) {
        status.appendChild(h("span", { text: (bits.length ? " · " : "") + "PR: " }));
        status.appendChild(ST.modals.safeExternalLink(harvest.prUrl));
      }
      if (status.textContent || status.children.length) holder.appendChild(status);

      var anyExists = false, anyChanges = false;
      sources.forEach(function (s) {
        if (!s.exists || !s.files.length) {
          var plain = !s.exists
            ? "⎇ " + s.stepId + " — worktree gone (pruned or cleaned up)"
            : "⎇ " + s.stepId + " — no changes";
          if (s.exists) anyExists = true;
          holder.appendChild(h("div", { class: "hist-wt-line", text: plain, title: s.branch }));
          return;
        }
        anyExists = true; anyChanges = true;
        holder.appendChild(renderWorktreeDiffRow(holder, record, s));
      });

      var banner = h("div", { class: "mbanner", style: "margin-top:6px" });
      if (notice) { banner.className = "mbanner show " + notice.cls; banner.textContent = notice.text; }
      holder.appendChild(banner);
      if (isReadOnly()) return;
      var buttons = h("div", { class: "hist-wt-actions" });
      function harvestBtn(label, body, cls) {
        return h("button", { class: "btn" + (cls ? " " + cls : ""), text: label, onClick: function () {
          banner.className = "mbanner show info"; banner.textContent = "merging…";
          apiAuth("POST", "/api/history/" + encodeURIComponent(record.id) + "/harvest", body).then(function (rr) {
            if (S.page !== "runs") return;
            if (rr.status === 200) {
              invalidateWorktreeDiffs(record.id);
              var res = rr.body.result;
              var text = res.noChanges ? "no changes to merge"
                : (res.mode === "apply"
                  ? "applied " + res.mergedSources.join(", ") + " to the checkout (uncommitted): " + res.files.length + " file(s) +" + res.additions + " -" + res.deletions
                  : "merged " + res.mergedSources.join(", ") + " — " + (res.prUrl ? "PR " + res.prUrl : "branch " + res.branch));
              renderWorktreeSection(holder, record, { cls: "info", text: text });
            } else if (rr.status === 409) {
              banner.className = "mbanner show err";
              banner.textContent = rr.body.error + " — retry with a deterministic winner:";
              clear(buttons);
              buttons.appendChild(harvestBtn("Retry: first wins", Object.assign({}, body, { onConflict: "ours" })));
              buttons.appendChild(harvestBtn("Retry: last wins", Object.assign({}, body, { onConflict: "theirs" })));
            } else {
              banner.className = "mbanner show err";
              banner.textContent = rr.body.error || "harvest failed";
            }
          });
        } });
      }
      if (anyChanges) {
        buttons.appendChild(harvestBtn("Apply to checkout", { mode: "apply" }, "primary"));
        buttons.appendChild(harvestBtn("Merge to branch", { mode: "branch" }));
      }
      if (anyExists && !(harvest && harvest.prunedAt)) {
        buttons.appendChild(h("button", { class: "btn", text: "Prune worktrees", onClick: function () {
          if (!window.confirm("Discard this run's worktrees and branches? Unapplied changes are lost.")) return;
          apiAuth("POST", "/api/history/" + encodeURIComponent(record.id) + "/prune").then(function (rr) {
            if (S.page !== "runs") return;
            if (rr.status === 200) invalidateWorktreeDiffs(record.id);
            renderWorktreeSection(holder, record, {
              cls: rr.status === 200 ? "info" : "err",
              text: rr.status === 200 ? "pruned " + rr.body.pruned + "/" + rr.body.total + " worktree(s)" : (rr.body.error || "prune failed")
            });
          });
        } }));
      }
      if (buttons.children.length) holder.appendChild(buttons);
    }).catch(function () {});
  }

  // ---- keyboard --------------------------------------------------------------

  /**
   * Page-level keys, called from the boot keydown handler when no modal is up
   * and the runs page is showing. Returns true when the key was consumed.
   */
  function handleKey(e) {
    if (S.page !== "runs") return false;
    var typing = e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA");
    if (e.key === "Escape") {
      if (R.view !== "list") { backToList(); return true; }
      if (typing) return false;
      ST.closePageRoute();
      return true;
    }
    if (typing) return false;
    if (e.key === "/") {
      e.preventDefault();
      var search = R.mount && R.mount.querySelector(".runs-search");
      if (search) search.focus();
      return true;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      stepSelection(e.key === "ArrowDown" ? 1 : -1, true);
      return true;
    }
    return false;
  }

  ST.runs = {
    handleKey: handleKey,
    onLeave: onLeave,
    open: open,
    render: render,
  };
})(window.Steamtrain);
