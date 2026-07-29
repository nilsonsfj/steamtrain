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
  var loadSessionThenCatalog = ST.loadSessionThenCatalog;
  var syncBodyMode = ST.syncBodyMode;

  function render() {
    var stage = document.getElementById("bands");
    clear(stage);
    syncBodyMode();
    var railRight = document.getElementById("rail-right");
    if (railRight) ST.instruments.render(railRight);
    if (!S.spec) {
      ST.arrival.renderStationAtmosphere(stage);
      stage.appendChild(h("div", { class: "empty station-empty" },
        h("div", { class: "station-logo" },
          h("span", { class: "brand-mark", "aria-hidden": "true" }),
          h("span", { class: "accent", text: "steam" }),
          "train"
        ),
        h("div", { class: "station-premise", text: "Parallel agents. One receipt." }),
        h("div", { class: "boarding-pulse", text: "Boarding…" })
      ));
      return;
    }

    // First-run station: hero only — one composition, no pipeline noise.
    if (S.stationLanding && S.selected === TOUR_NAME && !(S.runState && S.runState.started)) {
      ST.arrival.renderStationHero(stage);
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
      ST.arrival.renderConductorStage(stage);
      ST.run.updateProgress();
      return;
    }

    // Returning to tour (not first-run): keep a compact boarding banner above the pipeline.
    if (S.selected === TOUR_NAME && !(S.runState && S.runState.started) && !S.departing) {
      ST.arrival.renderStationHero(stage);
    }

    var showingArrival = false;
    if (S.runState && S.runState.done && !S.departing) {
      if (!S.arrivalInspect) ST.arrival.renderStationAtmosphere(stage);
      showingArrival = ST.arrival.renderArrival(stage);
    }

    if (showingArrival && !S.arrivalInspect) {
      ST.run.updateProgress();
      return;
    }

    ST.run.renderNarration(stage);
    // Idle (no run started yet): the composer above owns the pane and the bands
    // area stays empty. Once a run starts, the phase bands take it.
    ST.run.renderBands(stage);

    // renderSummary belongs to the Arrival report (Task 8); it renders here only
    // in the post-run inspect state, exactly as it did before.
    if (S.runState && S.runState.done && S.arrivalInspect) ST.run.renderSummary(stage);
    ST.run.updateProgress();
    applyTailScroll(stage);
    ST.run.renderDetail();
  }

  /**
   * Re-apply each tail pane's scroll position after the canvas rebuild:
   * following panes pin to the newest line, paused ones stay where the reader
   * left them. Must run after the nodes are in the DOM (scrollHeight is 0
   * before layout).
   */
  function applyTailScroll(stage) {
    var tails = stage.querySelectorAll(".tail[data-key], .output-body[data-key]");
    for (var i = 0; i < tails.length; i++) {
      var el = tails[i];
      var st = S.tailScroll[el.getAttribute("data-key")];
      el.scrollTop = st && !st.follow ? st.top : el.scrollHeight;
    }
  }


  /** One-time DOM wiring; runs once this file loads (after every module). */
  function start() {
    // Build the rail scaffolding before anything below looks up #newWfBtn.
    ST.shell.render();
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
    document.getElementById("settingsBtn").addEventListener("click", function () { ST.settings.open(); });
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

    // parseRoute dispatches the hash to either the cockpit (run deep link,
    // restoring the cockpit view first if settings was showing) or the
    // settings page; a route-less hash leaves whichever view is current alone.
    window.addEventListener("hashchange", function (e) {
      var oldHash = null;
      try { oldHash = new URL(e.oldURL).hash; } catch (err) {}
      ST.handleRoute(oldHash);
    });
    // Resolve whatever hash the page loaded with (a shared #settings or #run-
    // link) once the rail scaffolding above exists to hide/show.
    ST.handleRoute(null);

    loadSessionThenCatalog();
  }

  ST.render = render;
  ST.start = start;
})(window.Steamtrain);

window.Steamtrain.start();
