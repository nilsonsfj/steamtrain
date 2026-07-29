/**
 * Boot: the top-level render() dispatcher and the one-time DOM wiring.
 * Loaded last so every module object on the namespace already exists.
 */
(function (ST) {
  "use strict";
  var S = ST.state;
  var h = ST.h;
  var clear = ST.clear;
  var loadSessionThenCatalog = ST.loadSessionThenCatalog;

  function render() {
    var stage = document.getElementById("bands");
    clear(stage);
    var railRight = document.getElementById("rail-right");
    if (railRight) ST.instruments.render(railRight);
    if (!S.spec) {
      stage.appendChild(h("div", { class: "empty boot-empty" },
        h("div", { class: "boot-logo" },
          h("span", { class: "brand-mark", "aria-hidden": "true" }),
          h("span", { class: "accent", text: "steam" }),
          "train"
        ),
        h("div", { class: "boot-premise", text: "Parallel agents. One receipt." }),
        h("div", { class: "boarding-pulse", text: "Boarding…" })
      ));
      return;
    }

    var showingArrival = false;
    if (S.runState && S.runState.done) {
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
    // Resolve a shared #settings link once the rail scaffolding above exists
    // to hide/show. A #run- link is deliberately NOT resolved here: the
    // workflow catalog hasn't loaded yet at this point, so attachRun would
    // take its "not in catalog" fallback even for a known workflow. Run/step
    // deep links are left to loadWorkflows() (st-core.js), which re-parses
    // the hash once the catalog is loaded — dispatching from both places
    // raced and could leave the step drill-in drawer closed or its pending
    // deep-link flag stale. Do not re-add a run-link dispatch here.
    ST.handleRoute(null, /* bootSettingsOnly */ true);

    loadSessionThenCatalog();
  }

  ST.render = render;
  ST.start = start;
})(window.Steamtrain);

window.Steamtrain.start();
