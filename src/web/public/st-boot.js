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

  /**
   * RENDERING IS DESTRUCTIVE — read this before adding anything to #bands or
   * #rail-right.
   *
   * Both regions are cleared and rebuilt from scratch on every call, and the
   * instrument rail schedules a call every 2 seconds for the whole life of a
   * run (st-instruments.js). Any transient UI state that lives only in the DOM
   * — an open <details>, unsent text in a field, a scroll offset, the focused
   * element — is therefore destroyed twice a second-and-a-half, silently.
   *
   * So: anything inside #bands or #rail-right that holds user state must
   * either persist that state on `S` (keyed by stepKey() so loop iterations
   * stay distinct — see S.approvalDiffOpen, S.humanInputDraft,
   * S.subWorkflowOpen, S.tailScroll) or restore it after the rebuild
   * (applyTailScroll below; ST.captureFocus/ST.restoreFocus for focus and
   * caret; the event log's scroll handling in st-instruments.js).
   */
  function render() {
    // Focus and caret first: everything below can replace the focused node.
    var focusToken = ST.captureFocus();
    renderStage();
    ST.restoreFocus(focusToken);
  }

  function renderStage() {
    var stage = document.getElementById("bands");
    clear(stage);
    var railRight = document.getElementById("rail-right");
    if (railRight) {
      // Rail ownership: the inspector takes it pre-run (the step form) and
      // when a step is drilled into during a run (the step record, 02.4);
      // the instrument cluster has it otherwise.
      if (!(ST.inspector && ST.inspector.render(railRight))) ST.instruments.render(railRight);
    }
    if (!S.spec) {
      stage.appendChild(h("div", { class: "empty boot-empty" },
        h("div", { class: "boot-logo" },
          h("span", { class: "brand-mark", "aria-hidden": "true" }),
          h("span", { class: "accent", text: "steam" }),
          "train"
        ),
        h("div", { class: "boot-premise", text: "Parallel agents. One receipt." }),
        h("div", { class: "boot-pulse", text: "Loading…" })
      ));
      return;
    }

    var showingArrival = false;
    if (S.runState && S.runState.done) {
      showingArrival = ST.arrival.renderArrival(stage);
    }

    if (showingArrival) {
      ST.run.updateProgress();
      return;
    }

    // Idle (no run attached): the plan editor owns the centre pane — an
    // editable projection of the workflow file with the pending-diff footer.
    if (!S.runId && ST.plan) {
      ST.plan.render(stage);
      ST.run.updateProgress();
      return;
    }

    ST.run.renderNarration(stage);
    ST.run.renderBands(stage);
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
    document.getElementById("homeBtn").addEventListener("click", function () { ST.goHome(); });
    document.getElementById("historyBtn").addEventListener("click", function () { ST.runs.open(); });
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
          ST.modals.closeModal();
        } else if (e.key === "Tab") {
          ST.modals.trapModalFocus(e);
        }
        return;
      }
      // The runs page owns ↑/↓, `/` and Escape while it is up; it reports
      // whether it consumed the key so the cockpit's own handling below still
      // runs for anything it did not.
      if (ST.runs.handleKey(e)) return;
      // The plan editor's keys (⌘S save, ⌘⏎ launch sheet, ⌫ delete, arrows,
      // Esc deselect) apply while no run is attached.
      if (ST.plan && ST.plan.handleKey(e)) return;
      if (e.key === "Escape" && S.detail) {
        e.preventDefault();
        ST.run.closeDetail();
      }
    });

    // parseRoute dispatches the hash to the cockpit (run deep link, restoring
    // the cockpit view first if a page was showing) or to one of the full-page
    // surfaces (#runs, #settings); a route-less hash leaves the current view
    // alone.
    window.addEventListener("hashchange", function (e) {
      var oldHash = null;
      try { oldHash = new URL(e.oldURL).hash; } catch (err) {}
      ST.handleRoute(oldHash);
    });
    // Resolve a shared #settings or #runs link once the rail scaffolding above
    // exists to hide/show. A #run- link is deliberately NOT resolved here: the
    // workflow catalog hasn't loaded yet at this point, so attachRun would
    // take its "not in catalog" fallback even for a known workflow. Run/step
    // deep links are left to loadWorkflows() (st-core.js), which re-parses
    // the hash once the catalog is loaded — dispatching from both places
    // raced and could leave the step drill-in drawer closed or its pending
    // deep-link flag stale. Do not re-add a run-link dispatch here.
    ST.handleRoute(null, /* bootPagesOnly */ true);

    loadSessionThenCatalog();
  }

  ST.render = render;
  ST.start = start;
})(window.Steamtrain);

window.Steamtrain.start();
