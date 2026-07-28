/**
 * Boot: the top-level render() dispatcher and the one-time DOM wiring.
 * Loaded last so every module object on the namespace already exists.
 */
(function (ST) {
  "use strict";
  var S = ST.state;
  var h = ST.h;
  var TOUR_NAME = ST.TOUR_NAME;
  var clear = ST.clear;
  var currentRunDeepLink = ST.currentRunDeepLink;
  var loadSessionThenCatalog = ST.loadSessionThenCatalog;
  var openRunDeepLink = ST.openRunDeepLink;
  var syncBodyMode = ST.syncBodyMode;

  function render() {
    var canvas = document.getElementById("canvas");
    clear(canvas);
    syncBodyMode();
    if (!S.spec) {
      ST.arrival.renderStationAtmosphere(canvas);
      canvas.appendChild(h("div", { class: "empty station-empty" },
        h("div", { class: "station-logo" },
          h("span", { class: "brand-mark", "aria-hidden": "true" }),
          h("span", { class: "accent", text: "steam" }),
          "train"
        ),
        h("div", { class: "station-premise", text: "Parallel agents. One receipt." }),
        h("div", { class: "boarding-pulse", text: "Boarding\u2026" })
      ));
      return;
    }

    // First-run station: hero only — one composition, no pipeline noise.
    if (S.stationLanding && S.selected === TOUR_NAME && !(S.runState && S.runState.started)) {
      ST.arrival.renderStationHero(canvas);
      ST.run.updateProgress();
      return;
    }

    // Tour ride stage: Conductor owns the yard until Arrival is ready.
    if (
      S.tourRiding &&
      S.selected === TOUR_NAME &&
      (S.departing || (S.runState && !S.runState.done)) &&
      !S.arrivalInspect
    ) {
      ST.arrival.renderConductorStage(canvas);
      ST.run.updateProgress();
      return;
    }

    // Returning to tour (not first-run): keep a compact boarding banner above the pipeline.
    if (S.selected === TOUR_NAME && !(S.runState && S.runState.started) && !S.departing) {
      ST.arrival.renderStationHero(canvas);
    }

    var showingArrival = false;
    if (S.runState && S.runState.done && !S.departing) {
      if (!S.arrivalInspect) ST.arrival.renderStationAtmosphere(canvas);
      showingArrival = ST.arrival.renderArrival(canvas);
    }

    if (showingArrival && !S.arrivalInspect) {
      ST.run.updateProgress();
      return;
    }

    ST.run.renderNarration(canvas);
    ST.run.renderLegendOrTrack(canvas);

    var maxIter = {};
    var phases = S.runState ? S.runState.phases : [];
    phases.forEach(function (p) {
      if (p.iteration && (!maxIter[p.phaseId] || p.iteration > maxIter[p.phaseId])) maxIter[p.phaseId] = p.iteration;
    });

    phases.forEach(function (p, idx) {
      if (idx > 0) {
        var prevPhase = phases[idx - 1];
        var prevDone = prevPhase && prevPhase.done;
        var prevOk = prevPhase && prevPhase.ok;
        var curRunning = (p.steps || []).some(function (s) { return s.status === "running"; });
        var curDone = p.done;
        var connCls = "connector";
        if (prevDone && prevOk && curRunning) connCls += " active";
        else if (prevDone && prevOk && curDone) connCls += " done";
        else if (prevDone && !prevOk && curDone && p.ok) connCls += " done";
        else if (prevDone && !prevOk) connCls += " err";
        else if (S.runState && S.runState.started && prevDone) connCls += " active";
        var connEl = h("div", { class: connCls });
        if (connCls.indexOf("active") >= 0) {
          connEl.style.animationDelay = "-" + (Date.now() % 600) + "ms";
        }
        canvas.appendChild(connEl);
      }
      var piter = p.iteration || 1;
      var steps = p.steps || [];
      var running = steps.some(function (s) { return s.status === "running"; });
      var pstat = p.done ? (p.ok ? "done" : "failed") : (running ? "running" : (S.runState && S.runState.started ? "" : "pending"));
      var ptitle = p.title + (p.iteration && p.iteration > 1 ? " \u00b7 iteration " + p.iteration : "");
      var phaseEl = h("div", { class: "phase" + (p.done ? " done" : "") },
        h("div", { class: "phead" },
          h("div", { class: "pidx", text: String(idx + 1) }),
          h("div", { class: "ptitle", text: ptitle }),
          pstat ? h("div", { class: "pstat", text: "\u00b7 " + pstat }) : null
        )
      );
      var cards = h("div", { class: "cards" });
      var isLatest = !p.iteration || p.iteration === (maxIter[p.phaseId] || 1);
      steps.forEach(function (s) {
        if (isLatest) cards.appendChild(ST.run.renderCard(s, p));
        else cards.appendChild(h("div", { class: "card superseded" },
          h("div", { class: "top" },
            h("span", { class: "sid", text: s.stepId }),
            h("span", { class: "state", text: "iteration " + piter + " \u2192 superseded by iteration " + maxIter[p.phaseId] })
          )
        ));
      });
      phaseEl.appendChild(cards);
      canvas.appendChild(phaseEl);

      var loopMarkers = S.runState ? (S.runState.loopMarkers || []) : [];
      loopMarkers.forEach(function (m) {
        if (m.gatePhaseId === p.phaseId && m.gatePhaseIteration === piter) {
          canvas.appendChild(h("div", { class: "loop-marker" },
            h("span", { class: "chip warn",
              text: "\u21ba loop \u2192 " + m.loopTo + " \u00b7 iteration " + m.iteration + "/" + (m.maxIterations || "") })
          ));
        }
      });
    });

    if (S.runState && S.runState.done && S.arrivalInspect) ST.run.renderSummary(canvas);
    ST.run.updateProgress();
    applyTailScroll(canvas);
    ST.run.renderDetail();
  }

  /**
   * Re-apply each tail pane's scroll position after the canvas rebuild:
   * following panes pin to the newest line, paused ones stay where the reader
   * left them. Must run after the nodes are in the DOM (scrollHeight is 0
   * before layout).
   */
  function applyTailScroll(canvas) {
    var tails = canvas.querySelectorAll(".tail[data-key]");
    for (var i = 0; i < tails.length; i++) {
      var el = tails[i];
      var st = S.tailScroll[el.getAttribute("data-key")];
      el.scrollTop = st && !st.follow ? st.top : el.scrollHeight;
    }
  }


  /** One-time DOM wiring; runs once this file loads (after every module). */
  function start() {
    document.getElementById("planBtn").addEventListener("click", ST.run.startPlan);
    document.getElementById("runBtn").addEventListener("click", ST.run.startRun);
    document.getElementById("pauseBtn").addEventListener("click", ST.run.togglePauseRun);
    document.getElementById("detachBtn").addEventListener("click", ST.run.detachRun);
    document.getElementById("cancelBtn").addEventListener("click", ST.run.cancelRun);
    document.getElementById("flushBtn").addEventListener("click", ST.run.flushStaged);
    document.getElementById("paramsToggle").addEventListener("click", function () {
      var panel = document.getElementById("paramsPanel");
      if (!panel || panel.hidden) return;
      ST.run.setParamsExpanded(panel.classList.contains("collapsed"));
    });
    document.getElementById("input").addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { ST.run.startRun(); return; }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        if (ST.run.handlePromptHistoryKey(e.target, e.key === "ArrowUp")) e.preventDefault();
      }
    });
    // Typing while browsing history turns the recalled entry into the new draft.
    document.getElementById("input").addEventListener("input", function () { ST.run.clearPromptBrowse(); });
    document.getElementById("newWfBtn").addEventListener("click", ST.modals.openCreate);
    document.getElementById("historyBtn").addEventListener("click", function () { ST.modals.openHistory(); });
    document.getElementById("configBtn").addEventListener("click", ST.settings.openConfigModal);
    document.getElementById("editBtn").addEventListener("click", function () { ST.modals.openEditor(false); });
    document.getElementById("cloneBtn").addEventListener("click", function () { ST.modals.openEditor(true); });
    document.getElementById("deleteBtn").addEventListener("click", ST.modals.doDelete);
    document.getElementById("overlay").addEventListener("click", function (e) {
      if (e.target === document.getElementById("overlay")) ST.modals.closeModal();
    });
    document.addEventListener("keydown", function (e) {
      var overlayOpen = document.getElementById("overlay").classList.contains("show");
      if (overlayOpen) {
        if (e.key === "Escape") {
          e.preventDefault();
          ST.modals.stopHistoryPoll();
          ST.modals.closeModal();
        } else if (ST.modals.handleHistoryListKey(e)) {
          return;
        } else if (e.key === "Tab") {
          ST.modals.trapModalFocus(e);
        }
        return;
      }
      if (e.key === "Escape" && S.detail) {
        e.preventDefault();
        ST.run.closeDetail();
      }
    });

    window.addEventListener("hashchange", function () {
      var parsed = SteamtrainReducer.parseDeepLink
        ? SteamtrainReducer.parseDeepLink(window.location.hash)
        : null;
      if (parsed && parsed.runId) openRunDeepLink(parsed.runId, parsed.stepId);
      else {
        var runId = currentRunDeepLink();
        if (runId) openRunDeepLink(runId);
      }
    });

    loadSessionThenCatalog();
  }

  ST.render = render;
  ST.start = start;
})(window.Steamtrain);

window.Steamtrain.start();
